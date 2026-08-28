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
          const rec = asRecord(payload);
          if (typeof rec.model === 'string') {
            this.modelLabel = rec.model;
          }
          break;
        }
        default:
          break;
      }
    },

    /** hydrate 全量覆盖当前状态。 */
    applyHydrate(snapshot: HydratePayload): void {
      this.sessionId = snapshot.sessionId ?? '';
      this.playbook = snapshot.playbook ?? null;
      this.items = Array.isArray(snapshot.items) ? [...snapshot.items] : [];
      this.providers = snapshot.providers ?? null;
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
