import { defineStore } from 'pinia';
import type {
  ApprovalBriefView,
  Envelope,
  SubagentCard,
  ToolCallView,
  TranscriptItem
} from '../protocol/host-protocol';
import { setLocale } from './i18n';
import {
  buildHistoryList,
  buildPromptPayload,
  buildTimelineStrip,
  canFollowUpFrom,
  absorbChatModelFields,
  absorbHydrateModels,
  normalizeSessions,
  normalizeTimelineEvent,
  type ChatModelOption,
  type ChatTimelineEvent,
  type PromptAttachment,
  type SessionMeta,
  type TimelineStripEntry
} from './store-helpers';
import { getVsCodeApi, isMockHost } from './vscode-api';

export type {
  ChatTimelineEvent,
  PromptAttachment,
  SessionMeta,
  TimelineStripEntry
} from './store-helpers';

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

/** picker 用的模型项（与 store-helpers.normalizeChatModels 的产物同形）。 */
export type ModelOption = ChatModelOption;

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

/** models.json 模板同款示例（仅供文档/演示引用；picker 不再用它兜底）。 */
export const DEFAULT_MODELS: ModelOption[] = [
  { provider: 'custom', model: 'qwen3-max', label: 'Qwen3 Max' }
];

interface HydratePayload {
  sessionId?: string;
  playbook?: { id: string; stage: string } | null;
  items?: TranscriptItem[];
  providers?: unknown;
  pendingApproval?: ApprovalBriefView | null;
  /** 可选语言标记（缺省用 <html lang>，默认 zh-CN）。 */
  locale?: unknown;
  /** 可选时间线快照（host 目前只发给看板；chat 侧证据便签兜底）。 */
  timeline?: unknown;
  /** 可选会话列表（历史侧滑数据源；host 未下发时退化为仅当前会话）。 */
  sessions?: unknown;
  /** 顶层模型清单（models.json 解析结果；空数组 = 未配置，覆盖 providers 快照）。 */
  models?: unknown;
  /** 顶层当前模型 id / provider（优先于 providers 快照内的同名字段）。 */
  model?: unknown;
  modelProvider?: unknown;
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
    modelProvider: '' as string,
    playbooks: [...DEFAULT_PLAYBOOKS] as PlaybookMeta[],
    // 初始为空：真实清单只来自 host（hydrate / capabilities）；空 = 未配置，UI 引导去设置
    modelOptions: [] as ModelOption[],
    activePicker: null as 'playbook' | null,
    timeline: [] as ChatTimelineEvent[],
    sessions: [] as SessionMeta[],
    historyOpen: false,
    mock: false
  }),

  getters: {
    /** 刚结束一轮（最近的 user/assistant 是已完成的 assistant 回复）⇒ 可追问。 */
    canFollowUp(state): boolean {
      return canFollowUpFrom(state.items, state.streaming);
    },

    /** 紧凑事件脉络条：timeline 事件 + 证据便签（host 不发 timeline 也能渲染）。 */
    timelineStrip(state): TimelineStripEntry[] {
      return buildTimelineStrip(state.timeline, state.items);
    },

    /** 历史侧滑列表：hydrate.sessions 新→旧；host 未下发时退化为仅当前会话。 */
    historySessions(state): SessionMeta[] {
      return buildHistoryList(state.sessions, state.sessionId);
    },

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

    sendPrompt(text: string, attachments?: readonly PromptAttachment[]): void {
      const payload = buildPromptPayload(
        text,
        { streaming: this.streaming, canFollowUp: this.canFollowUp },
        attachments
      );
      if (!payload) {
        return;
      }
      this.post('chat/prompt', payload);
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
      this.modelProvider = provider;
    },

    /** 内置技能不再有用户可见入口；保留上行通道（host 侧仅记日志）。 */
    runSkill(name: string): void {
      this.post('skill/run', { name });
      this.activePicker = null;
    },

    togglePicker(kind: 'playbook'): void {
      this.activePicker = this.activePicker === kind ? null : kind;
    },

    toggleHistory(force?: boolean): void {
      this.historyOpen = force ?? !this.historyOpen;
    },

    /** host 未接线 session/switch 时该 req 会被忽略——UI 只关闭侧滑，不乐观切换。 */
    switchSession(sessionId: string): void {
      if (sessionId && sessionId !== this.sessionId) {
        this.post('session/switch', { sessionId });
      }
      this.historyOpen = false;
    },

    newSession(): void {
      this.post('session/new', {});
      this.historyOpen = false;
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
        case 'timeline/upsert':
          this.upsertTimeline(payload);
          break;
        case 'approval/request':
          this.pendingApproval = asRecord(payload) as unknown as ApprovalBriefView;
          break;
        case 'history/toggle': {
          // 工作台 view/title 按钮等 host 入口：payload.open 为布尔时定向开合，否则翻转
          const open = asRecord(payload).open;
          this.historyOpen = typeof open === 'boolean' ? open : !this.historyOpen;
          break;
        }
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

    /** capabilities/hydrate payload 里可选的 model/models/playbooks 提取（缺省保留兜底）。 */
    absorbCapabilities(rec: AnyRecord): void {
      const next = absorbChatModelFields(
        {
          modelOptions: this.modelOptions,
          modelLabel: this.modelLabel,
          modelProvider: this.modelProvider
        },
        rec
      );
      this.modelOptions = next.modelOptions;
      this.modelLabel = next.modelLabel;
      this.modelProvider = next.modelProvider;
      if (Array.isArray(rec.playbooks)) {
        const playbooks = rec.playbooks
          .map((entry): PlaybookMeta | null => {
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
      // 内置技能是 Agent 内部资源（OpsResourceLoader / ops_read_skill），
      // 不进入 UI 目录：即使 host 误发 skills 字段也不吸收。
    },

    /** hydrate 全量覆盖当前状态。 */
    applyHydrate(snapshot: HydratePayload): void {
      setLocale(snapshot.locale);
      this.sessionId = snapshot.sessionId ?? '';
      this.playbook = snapshot.playbook ?? null;
      this.items = Array.isArray(snapshot.items) ? [...snapshot.items] : [];
      this.providers = snapshot.providers ?? null;
      this.absorbCapabilities(asRecord(snapshot.providers));
      // 顶层 models/model/modelProvider 后吸收 ⇒ 覆盖 providers 快照里的同名旧值
      const models = absorbHydrateModels(
        {
          modelOptions: this.modelOptions,
          modelLabel: this.modelLabel,
          modelProvider: this.modelProvider
        },
        snapshot
      );
      this.modelOptions = models.modelOptions;
      this.modelLabel = models.modelLabel;
      this.modelProvider = models.modelProvider;
      this.pendingApproval = snapshot.pendingApproval ?? null;
      // timeline 是可选字段：只有下发数组时才整体重放，否则保留已收到的 upsert
      if (Array.isArray(snapshot.timeline)) {
        this.timeline = [];
        for (const entry of snapshot.timeline) {
          this.upsertTimeline(entry);
        }
      }
      // sessions 同为可选字段：下发数组时整体覆盖，缺省保留（切会话 hydrate 不清列表）
      if (Array.isArray(snapshot.sessions)) {
        this.sessions = normalizeSessions(snapshot.sessions);
      }
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
    },

    upsertTimeline(payload: unknown): void {
      const event = normalizeTimelineEvent(payload);
      if (!event) {
        return;
      }
      const idx = this.timeline.findIndex((existing) => existing.id === event.id);
      if (idx >= 0) {
        this.timeline.splice(idx, 1, event);
      } else {
        this.timeline.push(event);
      }
    }
  }
});
