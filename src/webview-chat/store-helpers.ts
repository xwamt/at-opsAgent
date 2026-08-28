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
