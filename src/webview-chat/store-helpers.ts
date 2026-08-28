/**
 * chat store 的纯 TS 逻辑（无 Vue/DOM/pinia 依赖）：
 * prompt 上行 payload 组装与「事件脉络」时间线条目归一化。
 * 单独成文件是为了能在 node 环境直接单测（docs/09 §8 组件测降级路径）。
 */
import type { ChatPromptReq, TranscriptItem } from '../protocol/host-protocol';
import { normalizeConfidence, type ConfidenceLevel } from './confidence';

export type PromptAttachment = NonNullable<ChatPromptReq['attachments']>[number];

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : {};
}

/**
 * 追问判定：未在流式中，且最近一条 user/assistant 消息是「已完成的 assistant 回复」
 * ——即刚结束一轮对话。此时上行 mode: 'followUp'（host 当新 prompt 处理也 OK）。
 */
export function canFollowUpFrom(items: readonly TranscriptItem[], streaming: boolean): boolean {
  if (streaming) {
    return false;
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'assistant') {
      return item.streaming !== true;
    }
    if (item.kind === 'user') {
      return false;
    }
  }
  return false;
}

/** chat/prompt payload：流式中 ⇒ steer；刚结束一轮 ⇒ followUp；空文本 ⇒ null（不发）。 */
export function buildPromptPayload(
  text: string,
  state: { streaming: boolean; canFollowUp: boolean },
  attachments?: readonly PromptAttachment[]
): ChatPromptReq | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const payload: ChatPromptReq = { text: trimmed };
  if (attachments && attachments.length > 0) {
    payload.attachments = [...attachments];
  }
  if (state.streaming) {
    payload.mode = 'steer';
  } else if (state.canFollowUp) {
    payload.mode = 'followUp';
  }
  return payload;
}

/**
 * CoT 隐藏（对齐 pi-coding-agent hideThinkingBlock，且恒为隐藏、无开关）：
 * thinking 项的推理步骤永不进入可见渲染；唯一可见的是 security-triage 等
 * 链路附带的 untrustedQuotes 警示块（只含外部引用原文，不含任何思考步骤）。
 * 返回空数组 ⇒ 该 thinking 项完全不渲染。
 */
export function visibleUntrustedQuotes(item: TranscriptItem): string[] {
  if (item.kind !== 'thinking' || !Array.isArray(item.untrustedQuotes)) {
    return [];
  }
  return item.untrustedQuotes.filter((quote) => typeof quote === 'string' && quote !== '');
}

export interface ChatTimelineEvent {
  id: string;
  ts: number;
  title: string;
  severity: 'info' | 'warn' | 'crit';
}

export interface TimelineStripEntry {
  id: string;
  label: string;
  tone: ConfidenceLevel | 'info' | 'warn' | 'crit';
}

function toSeverity(value: unknown): ChatTimelineEvent['severity'] {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'crit' || raw === 'critical' || raw === 'error' || raw === 'fatal') {
    return 'crit';
  }
  if (raw === 'warn' || raw === 'warning' || raw === 'degraded') {
    return 'warn';
  }
  return 'info';
}

/** timeline/upsert payload（或 hydrate.timeline 条目）→ 最小归一化；无 id 丢弃。 */
export function normalizeTimelineEvent(payload: unknown): ChatTimelineEvent | null {
  const outer = asRecord(payload);
  const rec = outer.event ? asRecord(outer.event) : outer;
  const id = rec.id ?? rec.eventId;
  if (id === undefined || id === null || id === '') {
    return null;
  }
  return {
    id: String(id),
    ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : Date.now(),
    title: String(rec.title ?? rec.summary ?? rec.text ?? '（无标题）'),
    severity: toSeverity(rec.severity ?? rec.level)
  };
}

// ── 历史会话 / 欢迎页（Cline 式 History 侧滑 + 空态建议卡）─────────────────

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
}

/** hydrate.sessions → 归一化：无 id 丢弃；title 缺省回退 id 前缀；createdAt 缺省 0。 */
export function normalizeSessions(raw: unknown): SessionMeta[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = rec.id ?? rec.sessionId;
    if (id === undefined || id === null || id === '') {
      continue;
    }
    out.push({
      id: String(id),
      title: String(rec.title ?? rec.label ?? String(id).slice(0, 12)),
      createdAt:
        typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : 0
    });
  }
  return out;
}

/**
 * 历史侧滑列表：新→旧排序；host 尚未下发 sessions 时退化为
 * 「仅当前会话」一条（session/switch 未接线也能展示当前上下文）。
 */
export function buildHistoryList(
  sessions: readonly SessionMeta[],
  currentSessionId: string,
  fallbackTitle = ''
): SessionMeta[] {
  if (sessions.length > 0) {
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  }
  if (currentSessionId) {
    return [
      {
        id: currentSessionId,
        title: fallbackTitle || currentSessionId.slice(0, 12),
        createdAt: 0
      }
    ];
  }
  return [];
}

/** 欢迎页建议卡：取前 cap 条 playbook；cap 收敛到 4–8（Cline 空态卡片量级）。 */
export function buildWelcomeSuggestions<T>(playbooks: readonly T[], cap = 6): T[] {
  return playbooks.slice(0, Math.min(8, Math.max(4, cap)));
}

export interface ChatModelOption {
  provider: string;
  model: string;
  label: string;
}

/** hydrate / capabilities 的 models[]：空数组表示「未配置」，不是解析失败。 */
export function normalizeChatModels(raw: unknown): ChatModelOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatModelOption[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const model = String(rec.model ?? rec.id ?? '').trim();
    if (model.length === 0) continue;
    const provider = String(rec.provider ?? 'custom').trim() || 'custom';
    const label = String(rec.label ?? rec.name ?? model).trim() || model;
    out.push({ provider, model, label });
  }
  return out;
}

export interface ChatModelState {
  modelOptions: ChatModelOption[];
  modelLabel: string;
  modelProvider: string;
}

/** 从 capabilities / providers 记录吸收模型字段；models 是数组（含空）就整体覆盖。 */
export function absorbChatModelFields(state: ChatModelState, rec: Record<string, unknown>): ChatModelState {
  const next: ChatModelState = { ...state, modelOptions: [...state.modelOptions] };
  if (typeof rec.model === 'string') next.modelLabel = rec.model;
  if (typeof rec.modelProvider === 'string') next.modelProvider = rec.modelProvider;
  if (Array.isArray(rec.models)) next.modelOptions = normalizeChatModels(rec.models);
  return next;
}

/**
 * hydrate 吸收顺序：先 providers 快照（旧 host 兼容），再顶层
 * models/model/modelProvider（新 host 字段胜出）。
 */
export function absorbHydrateModels(
  state: ChatModelState,
  snapshot: {
    providers?: unknown;
    models?: unknown;
    model?: unknown;
    modelProvider?: unknown;
  }
): ChatModelState {
  const fromProviders = absorbChatModelFields(state, asRecord(snapshot.providers));
  return absorbChatModelFields(fromProviders, {
    models: snapshot.models,
    model: snapshot.model,
    modelProvider: snapshot.modelProvider
  });
}

/**
 * 紧凑「事件脉络」条：host 下发的 timeline 事件在前，transcript 中的
 * evidence 便签（confidence 三态）在后；host 不发 timeline 时仅证据也能撑起条带。
 */
export function buildTimelineStrip(
  timeline: readonly ChatTimelineEvent[],
  items: readonly TranscriptItem[],
  cap = 12
): TimelineStripEntry[] {
  const entries: TimelineStripEntry[] = timeline.map((event) => ({
    id: `tl-${event.id}`,
    label: event.title,
    tone: event.severity
  }));
  for (const item of items) {
    if (item.kind === 'evidence') {
      entries.push({
        id: `ev-${item.id}`,
        label: item.note.summary,
        tone: normalizeConfidence(item.note.confidence)
      });
    }
  }
  return entries.slice(-cap);
}
