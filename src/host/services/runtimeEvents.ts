/**
 * runtime 事件 → host-protocol 事件的翻译器（ChatService 的事件面拆件）。
 * 所有写入按事件所属会话定向（store 会话包）；只有活动会话实时广播，
 * 后台席位（sessions.maxParallel=2）切回时经 hydrate 恢复。
 */
import { randomUUID } from 'node:crypto';
import { resolveToolRisk } from '../../mcp-client/riskLookup';
import type { ToolCallView, UsageView } from '../../protocol';
import type { RuntimeEventLike } from '../hostTypes';
import type { HostContext } from './context';

export interface RuntimeEventHooks {
  /** 该会话 idle（清 busy + 释放挂起重建；running context 重算）。 */
  onIdle(sessionId: string): void;
  /** 最近一次 usage 事件（hydrate 回放；席位驱逐清空）。 */
  setUsage(sessionId: string, usage: UsageView): void;
}

export class RuntimeEventRouter {
  /** thinking 项首次 delta 的墙钟起点（itemId → Date.now()）。 */
  private readonly thinkingStartedAt = new Map<string, number>();

  constructor(
    private readonly ctx: HostContext,
    private readonly hooks: RuntimeEventHooks
  ) {}

  route(sid: string, e: RuntimeEventLike): void {
    const ctx = this.ctx;
    switch (e.type) {
      case 'text_delta': {
        // P0-id（docs/14）：runtime 对同一 assistant 消息的 thinking_delta 与
        // text_delta 共用一个消息 id。若两类 delta 落到同一 transcript 项，
        // 先到的 thinking 会把该 id 占成 kind:thinking（ChatTranscript 永不
        // 渲染），随后的正文被 appendAssistantText 静默丢弃。这里按 kind
        // 拆 id（`:assistant` / `:thinking` 后缀），正文永不写入 thinking 项。
        this.finalizeThinking(sid, thinkingItemId(e.id));
        const id = assistantItemId(e.id);
        if (!ctx.store.findItem(id, sid)) {
          const item = { kind: 'assistant' as const, id, text: '', streaming: true };
          ctx.store.appendItem(item, sid);
          ctx.broadcastToSession(sid, 'transcript/append', { item });
        }
        ctx.store.appendAssistantText(id, e.text, sid);
        ctx.broadcastToSession(sid, 'transcript/patch', {
          itemId: id,
          patch: { appendText: e.text }
        });
        break;
      }
      case 'thinking_delta': {
        const id = thinkingItemId(e.id);
        if (!ctx.store.findItem(id, sid)) {
          const item = { kind: 'thinking' as const, id, steps: [] as string[] };
          ctx.store.appendItem(item, sid);
          ctx.broadcastToSession(sid, 'transcript/append', { item });
        }
        if (!this.thinkingStartedAt.has(id)) {
          this.thinkingStartedAt.set(id, Date.now());
        }
        ctx.store.appendThinkingText(id, e.text, sid);
        const untrustedQuotes = this.collectUntrustedQuotes(sid, id);
        ctx.broadcastToSession(sid, 'thinking/delta', {
          itemId: id,
          text: e.text,
          ...(untrustedQuotes !== undefined ? { untrustedQuotes } : {})
        });
        break;
      }
      case 'tool_start': {
        const descriptor = ctx.hub.listAllTools().find((t) => t.name === e.name);
        const call: ToolCallView = {
          name: e.name,
          pluginId: descriptor?.pluginId,
          risk: resolveToolRisk(e.name, descriptor),
          status: 'running',
          preview: e.preview
        };
        ctx.store.appendItem({ kind: 'tool', id: e.id, call }, sid);
        ctx.broadcastToSession(sid, 'tool/start', { itemId: e.id, call });
        break;
      }
      case 'tool_end': {
        const item = ctx.store.findItem(e.id, sid);
        if (item?.kind !== 'tool') break;
        item.call = {
          ...item.call,
          status: e.ok === false ? 'error' : 'ok',
          preview: e.preview ?? item.call.preview,
          errorMessage: e.error
        };
        ctx.broadcastToSession(sid, 'tool/end', { itemId: e.id, call: item.call });
        break;
      }
      case 'usage': {
        const { type: _type, ...usage } = e;
        this.hooks.setUsage(sid, usage);
        ctx.broadcastToSession(sid, 'usage', usage);
        ctx.emitDuty?.('token_usage', sid, { ...usage });
        break;
      }
      case 'compaction': {
        const item = {
          kind: 'system' as const,
          id: randomUUID(),
          text: `上下文已自动压缩：${e.summary}`
        };
        ctx.store.appendItem(item, sid);
        ctx.broadcastToSession(sid, 'transcript/append', { item });
        ctx.broadcastToSession(sid, 'compaction', { summary: e.summary });
        break;
      }
      case 'notice': {
        const item = {
          kind: 'notice' as const,
          id: randomUUID(),
          variant: e.variant,
          text: e.text,
          ...(e.actions !== undefined ? { actions: e.actions } : {})
        };
        ctx.store.appendItem(item, sid);
        ctx.broadcastToSession(sid, 'transcript/append', { item });
        break;
      }
      case 'idle': {
        for (const item of ctx.store.itemsOf(sid)) {
          if (item.kind === 'assistant' && item.streaming) {
            ctx.store.finalizeAssistant(item.id, undefined, sid);
            ctx.broadcastToSession(sid, 'transcript/patch', {
              itemId: item.id,
              patch: { streaming: false }
            });
          }
          if (item.kind === 'thinking') {
            this.finalizeThinking(sid, item.id);
          }
        }
        ctx.broadcastToSession(sid, 'turn/end', {});
        this.hooks.onIdle(sid);
        break;
      }
      default:
        // runtime 可扩展事件面；未知类型忽略。
        break;
    }
  }

  /**
   * pb.security-triage 的思考卡片附「不可信引用」（docs/07 提示注入防线）：
   * 最近工具输出 preview 里疑似日志/SQL 的片段单独框出，提醒操作者
   * 这些内容来自被调查对象、可能包含注入指令，不能当作 Agent 结论。
   */
  private collectUntrustedQuotes(sessionId: string, thinkingItemId: string): string[] | undefined {
    const ctx = this.ctx;
    if (ctx.store.playbookOf(sessionId)?.id !== 'pb.security-triage') return undefined;
    const item = ctx.store.findItem(thinkingItemId, sessionId);
    if (item?.kind !== 'thinking') return undefined;
    const items = ctx.store.itemsOf(sessionId);
    let idx = items.findIndex((i) => i.id === thinkingItemId);
    if (idx < 0) idx = items.length;
    // 从思考卡片往前扫本轮（遇 user 停）最近的工具输出，最多取 3 条命中。
    const quotes: string[] = [];
    for (let i = idx - 1, scanned = 0; i >= 0 && scanned < 8 && quotes.length < 3; i -= 1) {
      const candidate = items[i];
      if (candidate.kind === 'user') break;
      if (candidate.kind !== 'tool') continue;
      scanned += 1;
      const preview = candidate.call.preview;
      if (typeof preview === 'string' && looksLikeLogOrSql(preview)) {
        quotes.push(truncateUntrustedQuote(preview));
      }
    }
    if (quotes.length === 0) return item.untrustedQuotes;
    const merged = [...new Set([...(item.untrustedQuotes ?? []), ...quotes.reverse()])].slice(0, 5);
    item.untrustedQuotes = merged;
    return merged;
  }

  /** thinking 结束：写 durationMs 一次（text_delta 或 idle）。CoT 正文仍不外泄。 */
  private finalizeThinking(sessionId: string, thinkingId: string): void {
    const started = this.thinkingStartedAt.get(thinkingId);
    this.thinkingStartedAt.delete(thinkingId);
    if (started === undefined) {
      return;
    }
    const item = this.ctx.store.findItem(thinkingId, sessionId);
    if (item?.kind !== 'thinking' || item.durationMs !== undefined) {
      return;
    }
    const durationMs = Math.max(0, Date.now() - started);
    item.durationMs = durationMs;
    this.ctx.broadcastToSession(sessionId, 'transcript/patch', {
      itemId: thinkingId,
      patch: { durationMs }
    });
  }
}

// ── P0-id：thinking / assistant 分 id ────────────────────────────────────

const THINKING_ID_SUFFIX = ':thinking';
const ASSISTANT_ID_SUFFIX = ':assistant';

/** 防御性幂等：runtime 将来若在发射侧就拆 id（已带后缀），不再二次拼接。 */
function thinkingItemId(eventId: string): string {
  return eventId.endsWith(THINKING_ID_SUFFIX) ? eventId : `${eventId}${THINKING_ID_SUFFIX}`;
}

function assistantItemId(eventId: string): string {
  return eventId.endsWith(ASSISTANT_ID_SUFFIX) ? eventId : `${eventId}${ASSISTANT_ID_SUFFIX}`;
}

/** 简单启发式：工具输出是否像日志 / SQL（时间戳、日志级别、异常栈、SQL 关键字）。 */
function looksLikeLogOrSql(text: string): boolean {
  return (
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/.test(text) ||
    /\b(ERROR|WARN(ING)?|FATAL|SEVERE|PANIC)\b/.test(text) ||
    /\b(exception|stack ?trace|traceback)\b/i.test(text) ||
    /^\s*at\s+[\w$.<>]+\s*\(/m.test(text) ||
    /\b(select|insert|update|delete|drop|alter|union)\b[\s\S]{0,200}\b(from|into|table|where|values|set)\b/i.test(
      text
    )
  );
}

function truncateUntrustedQuote(text: string, limit = 240): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}
