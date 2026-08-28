import { defineStore } from 'pinia';
import type {
  ApprovalBriefView,
  Envelope,
  SubagentCard,
  ToolCallView,
  TranscriptItem
} from '../protocol/host-protocol';
import { getVsCodeApi, isMockHost } from './vscode-api';

export interface ProviderChip {
  id: string;
  label: string;
  connected: boolean;
}

export interface PlaybookMeta {
  id: string;
  title: string;
  maxRisk: 'read' | 'write' | 'exec';
  description?: string;
}

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
}

export interface SkillMeta {
  name: string;
  description?: string;
}

/** host 未下发 playbook 列表时的兜底：设计稿 8 条一等链路（docs/research/06 §B.3）。 */
export const DEFAULT_PLAYBOOKS: PlaybookMeta[] = [
  { id: 'pb.incident', title: '故障排查', maxRisk: 'exec', description: '5xx/超时/事故 · 证据优先' },
  { id: 'pb.metric-anomaly', title: '指标异常诊断', maxRisk: 'read', description: 'Grafana/Prometheus 单指标' },
  { id: 'pb.release', title: '发布与回滚', maxRisk: 'exec', description: 'Jenkins + 主机验证' },
  { id: 'pb.config-change', title: '配置变更', maxRisk: 'read', description: 'Nacos · 写操作走 IDE' },
  { id: 'pb.db', title: '数据库慢查询 / 容量', maxRisk: 'exec', description: '堡垒机 SQL · 全部带 LIMIT' },
  { id: 'pb.host-emergency', title: '主机应急', maxRisk: 'exec', description: '磁盘/CPU/服务挂死' },
  { id: 'pb.inspection', title: '日常巡检', maxRisk: 'read', description: '清单逐项 · 未检查≠正常' },
  { id: 'pb.security-triage', title: '安全事件初判', maxRisk: 'read', description: '证据保全 · 不做清理' }
];

/** host 未下发模型列表时的兜底（models.json 模板同款）。 */
export const DEFAULT_MODELS: ModelOption[] = [
  { provider: 'custom', model: 'qwen3-max', label: 'Qwen3 Max' }
];

/** host 未下发技能列表时的兜底（skills/ 目录同名）。 */
export const DEFAULT_SKILLS: SkillMeta[] = [
  { name: 'ops-agent-core', description: '核心纪律：证据优先、审批简报、输出契约' },
  { name: 'incident-response', description: '故障排查链路细则' },
  { name: 'metric-anomaly', description: '指标异常诊断细则' },
  { name: 'release-rollback', description: '发布与回滚细则' },
  { name: 'config-change', description: 'Nacos 配置变更细则' },
  { name: 'db-slow-and-capacity', description: '数据库慢查询与容量细则' },
  { name: 'host-emergency', description: '主机应急细则' },
  { name: 'daily-inspection', description: '日常巡检清单' },
  { name: 'security-triage', description: '安全事件初判细则' }
];

interface HydratePayload {
  sessionId?: string;
  playbook?: { id: string; stage: string } | null;
  items?: TranscriptItem[];
  providers?: unknown;
  pendingApproval?: ApprovalBriefView | null;
}

type AnyRecord = Record<string, unknown>;

let reqSeq = 0;

function asRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : {};
}

function pickToolCall(source: AnyRecord): Partial<ToolCallView> {
  const call: Partial<ToolCallView> = {};
  const keys: Array<keyof ToolCallView> = [
    'name',
    'pluginId',
    'risk',
    'status',
    'durationMs',
    'truncated',
    'preview',
    'artifactUri',
    'errorCode',
    'errorMessage'
  ];
  for (const key of keys) {
    if (source[key] !== undefined) {
      (call as AnyRecord)[key] = source[key];
    }
  }
  return call;
}

export const useOpsStore = defineStore('ops-chat', {
  state: () => ({
    sessionId: '' as string,
    items: [] as TranscriptItem[],
    playbook: null as { id: string; stage: string } | null,
    pendingApproval: null as ApprovalBriefView | null,
    providers: null as unknown,
    streaming: false,
    streamingId: null as string | null,
    modelLabel: '' as string,
    playbooks: [...DEFAULT_PLAYBOOKS] as PlaybookMeta[],
    modelOptions: [...DEFAULT_MODELS] as ModelOption[],
    skills: [...DEFAULT_SKILLS] as SkillMeta[],
    activePicker: null as 'playbook' | 'skill' | null,
    mock: false
  }),

  getters: {
    providerChips(state): ProviderChip[] {
      const raw = state.providers;
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(asRecord(raw).providers)
          ? (asRecord(raw).providers as unknown[])
          : [];
      return list.map((entry, i) => {
        const rec = asRecord(entry);
        const id = String(rec.pluginId ?? rec.id ?? `provider-${i}`);
        return {
          id,
          label: String(rec.label ?? rec.name ?? id),
          connected: rec.connected !== false && rec.ok !== false && rec.state !== 'error'
        };
      });
    }
  },

  actions: {
    /** 上行：req envelope。 */
    post(type: string, payload: unknown = {}): void {
      reqSeq += 1;
      const envelope: Envelope = {
        v: 1,
        id: `wv-${Date.now().toString(36)}-${reqSeq}`,
        dir: 'req',
        type,
        payload,
        ts: Date.now()
      };
      getVsCodeApi().postMessage(envelope);
    },

    sendPrompt(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      this.post('chat/prompt', {
        text: trimmed,
        mode: this.streaming ? 'steer' : undefined
      });
    },

    abortRun(): void {
      this.post('chat/abort', {});
    },

    respondApproval(decision: 'approved' | 'rejected'): void {
      if (!this.pendingApproval) {
        return;
      }
      this.post('approval/respond', { briefId: this.pendingApproval.id, decision });
      this.pendingApproval = null;
    },

    /** GuidedManual：用户已在插件 UI 完成写操作。 */
    completeGuidedManual(): void {
      if (!this.pendingApproval) {
        return;
      }
      this.post('guidedManual/complete', { briefId: this.pendingApproval.id });
      this.pendingApproval = null;
    },

    startPlaybook(playbookId: string): void {
      this.post('playbook/start', { playbookId });
      this.activePicker = null;
    },

    setModel(provider: string, model: string): void {
      this.post('model/set', { provider, model });
      // 乐观更新；host capabilities/snapshot 到达后覆盖。
      this.modelLabel = model;
    },

    runSkill(name: string): void {
      this.post('skill/run', { name });
      this.activePicker = null;
    },

    togglePicker(kind: 'playbook' | 'skill'): void {
      this.activePicker = this.activePicker === kind ? null : kind;
    },

    abortSubagent(taskId: string): void {
      this.post('subagent/abort', { taskId });
    },

    attach(): void {
      this.mock = isMockHost();
      window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as Partial<Envelope> | undefined;
        if (!data || data.v !== 1 || data.dir !== 'evt' || typeof data.type !== 'string') {
          return;
        }
        this.handleEvent(data.type, data.payload);
      });
    },

    handleEvent(type: string, payload: unknown): void {
      switch (type) {
        case 'hydrate':
          this.applyHydrate(asRecord(payload) as HydratePayload);
          break;
        case 'transcript/append':
          this.appendItem(payload);
          break;
        case 'transcript/patch':
          this.patchItem(asRecord(payload));
          break;
        case 'tool/start':
        case 'tool/update':
        case 'tool/end':
          this.upsertTool(type, asRecord(payload));
          break;
        case 'thinking/delta':
          this.applyThinkingDelta(asRecord(payload));
          break;
        case 'subagent/upsert':
          this.upsertSubagent(asRecord(payload));
          break;
        case 'approval/request':
          this.pendingApproval = asRecord(payload) as unknown as ApprovalBriefView;
          break;
        case 'playbook/stage': {
          const rec = asRecord(payload);
          this.playbook = {
            id: String(rec.id ?? rec.playbookId ?? this.playbook?.id ?? ''),
            stage: String(rec.stage ?? '')
          };
          break;
        }
        case 'capabilities/snapshot': {
          this.providers = payload;
          this.absorbCapabilities(asRecord(payload));
          break;
        }
        default:
          break;
      }
    },

    /** capabilities/hydrate payload 里可选的 model/models/playbooks/skills 提取（缺省保留兜底）。 */
    absorbCapabilities(rec: AnyRecord): void {
      if (typeof rec.model === 'string') {
        this.modelLabel = rec.model;
      }
      if (Array.isArray(rec.models)) {
        const models = rec.models
          .map((entry) => {
            const m = asRecord(entry);
            const model = String(m.model ?? m.id ?? '');
            if (!model) {
              return null;
            }
            return {
              provider: String(m.provider ?? 'custom'),
              model,
              label: String(m.label ?? m.name ?? model)
            };
          })
          .filter((m): m is ModelOption => m !== null);
        if (models.length > 0) {
          this.modelOptions = models;
        }
      }
      if (Array.isArray(rec.playbooks)) {
        const playbooks = rec.playbooks
          .map((entry) => {
            const p = asRecord(entry);
            const id = String(p.id ?? '');
            if (!id) {
              return null;
            }
            const fallback = DEFAULT_PLAYBOOKS.find((d) => d.id === id);
            const risk = String(p.maxRisk ?? '');
            return {
              id,
              title: String(p.title ?? fallback?.title ?? id),
              maxRisk: (risk === 'read' || risk === 'write' || risk === 'exec'
                ? risk
                : fallback?.maxRisk ?? 'read') as PlaybookMeta['maxRisk'],
              description:
                typeof p.description === 'string' ? p.description : fallback?.description
            };
          })
          .filter((p): p is PlaybookMeta => p !== null);
        if (playbooks.length > 0) {
          this.playbooks = playbooks;
        }
      }
      if (Array.isArray(rec.skills)) {
        const skills = rec.skills
          .map((entry) => {
            if (typeof entry === 'string') {
              return { name: entry };
            }
            const s = asRecord(entry);
            const name = String(s.name ?? '');
            return name
              ? { name, description: typeof s.description === 'string' ? s.description : undefined }
              : null;
          })
          .filter((s): s is SkillMeta => s !== null);
        if (skills.length > 0) {
          this.skills = skills;
        }
      }
    },

    /** hydrate 全量覆盖当前状态。 */
    applyHydrate(snapshot: HydratePayload): void {
      this.sessionId = snapshot.sessionId ?? '';
      this.playbook = snapshot.playbook ?? null;
      this.items = Array.isArray(snapshot.items) ? [...snapshot.items] : [];
      this.providers = snapshot.providers ?? null;
      this.absorbCapabilities(asRecord(snapshot.providers));
      this.pendingApproval = snapshot.pendingApproval ?? null;
      const streamingItem = this.items.find(
        (item) => item.kind === 'assistant' && item.streaming
      );
      this.streaming = Boolean(streamingItem);
      this.streamingId = streamingItem ? streamingItem.id : null;
    },

    appendItem(payload: unknown): void {
      const rec = asRecord(payload);
      const item = (rec.item ? asRecord(rec.item) : rec) as unknown as TranscriptItem;
      if (!item.kind || !item.id) {
        return;
      }
      const idx = this.items.findIndex((existing) => existing.id === item.id);
      if (idx >= 0) {
        this.items.splice(idx, 1, item);
      } else {
        this.items.push(item);
      }
      if (item.kind === 'assistant' && item.streaming) {
        this.streaming = true;
        this.streamingId = item.id;
      }
    },

    patchItem(rec: AnyRecord): void {
      const itemId = String(rec.itemId ?? rec.id ?? '');
      const patch = asRecord(rec.patch);
      const item = this.items.find((existing) => existing.id === itemId);
      if (!item) {
        return;
      }
      const target = item as unknown as AnyRecord;
      if (typeof patch.appendText === 'string' && typeof target.text === 'string') {
        target.text = String(target.text) + patch.appendText;
        delete patch.appendText;
      }
      Object.assign(target, patch);
      if (item.kind === 'assistant' && patch.streaming === false && this.streamingId === item.id) {
        this.streaming = false;
        this.streamingId = null;
      }
    },

    upsertTool(type: string, rec: AnyRecord): void {
      const callPatch = rec.call ? pickToolCall(asRecord(rec.call)) : pickToolCall(rec);
      const itemId = String(rec.itemId ?? rec.id ?? `tool-${String(callPatch.name ?? 'unknown')}`);
      const existing = this.items.find(
        (item) => item.kind === 'tool' && item.id === itemId
      );
      if (existing && existing.kind === 'tool') {
        Object.assign(existing.call, callPatch);
        if (type === 'tool/end' && existing.call.status === 'running') {
          existing.call.status = 'ok';
        }
        return;
      }
      const call: ToolCallView = {
        name: String(callPatch.name ?? 'tool'),
        risk: callPatch.risk ?? 'read',
        status: callPatch.status ?? (type === 'tool/end' ? 'ok' : 'running'),
        ...callPatch
      };
      this.items.push({ kind: 'tool', id: itemId, call });
    },

    applyThinkingDelta(rec: AnyRecord): void {
      const itemId = String(rec.itemId ?? rec.id ?? 'thinking');
      const text = typeof rec.text === 'string' ? rec.text : '';
      let item = this.items.find(
        (existing) => existing.kind === 'thinking' && existing.id === itemId
      );
      if (!item) {
        item = { kind: 'thinking', id: itemId, steps: [] };
        this.items.push(item);
      }
      if (item.kind !== 'thinking') {
        return;
      }
      const stepIndex = typeof rec.step === 'number' ? rec.step : -1;
      if (stepIndex >= 0) {
        item.steps[stepIndex] = (item.steps[stepIndex] ?? '') + text;
      } else if (rec.newStep === true || item.steps.length === 0) {
        item.steps.push(text);
      } else {
        item.steps[item.steps.length - 1] += text;
      }
      if (Array.isArray(rec.untrustedQuotes)) {
        item.untrustedQuotes = rec.untrustedQuotes.map((quote) => String(quote));
      }
    },

    upsertSubagent(rec: AnyRecord): void {
      const card = (rec.agent ? asRecord(rec.agent) : rec) as unknown as SubagentCard;
      if (!card.taskId) {
        return;
      }
      const itemId = typeof rec.itemId === 'string' ? rec.itemId : undefined;
      let board = itemId
        ? this.items.find((item) => item.kind === 'subagents' && item.id === itemId)
        : [...this.items].reverse().find((item) => item.kind === 'subagents');
      if (!board) {
        board = {
          kind: 'subagents',
          id: itemId ?? `subagents-${this.items.length}`,
          agents: []
        };
        this.items.push(board);
      }
      if (board.kind !== 'subagents') {
        return;
      }
      const idx = board.agents.findIndex((agent) => agent.taskId === card.taskId);
      if (idx >= 0) {
        board.agents.splice(idx, 1, { ...board.agents[idx], ...card });
      } else {
        board.agents.push(card);
      }
    }
  }
});
