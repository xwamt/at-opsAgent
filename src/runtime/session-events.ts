/**
 * 主会话 pi 事件 → OpsRuntimeEvent（text/thinking/tool/usage/compaction/idle）。
 *
 * 从 src/runtime/index.ts 搬移，零行为变化。禁止 import vscode。
 */
import { randomUUID } from 'node:crypto';

import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import type { UsageView } from '../protocol';
import { truncatePreview } from './tool-gate';
import type { OpsRuntimeEvent, OpsRuntimeHandlers } from './types';

/** 从 pi 的 AgentToolResult（或任意 result）提取文本用于 UI 预览。 */
function extractResultText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (c): c is { type: 'text'; text: string } =>
            !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' &&
            typeof (c as { text?: unknown }).text === 'string'
        )
        .map((c) => c.text);
      if (texts.length > 0) return texts.join('\n');
    }
  }
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result);
  }
}

/** pi Usage（pi-ai）+ 会话上下文水位 → 协议 UsageView 的宽松映射。 */
export function toUsageView(
  usage: { input?: unknown; output?: unknown; cost?: { total?: unknown } },
  contextUsage?: { tokens?: number | null; contextWindow?: number }
): UsageView {
  const view: UsageView = {};
  if (typeof usage.input === 'number') view.inputTokens = usage.input;
  if (typeof usage.output === 'number') view.outputTokens = usage.output;
  const cost = usage.cost?.total;
  if (typeof cost === 'number') view.costUsd = cost;
  if (typeof contextUsage?.tokens === 'number') view.contextUsed = contextUsage.tokens;
  if (typeof contextUsage?.contextWindow === 'number') {
    view.contextWindow = contextUsage.contextWindow;
  }
  return view;
}

export interface SessionEventHooks {
  /** agent_end（会话回 idle）后回调——P1-15 的目录重建排队在这里冲刷。 */
  onIdle?: () => void;
  /** 工具执行开始/结束（软停 abort('cancel') 依赖 in-flight 计数）。 */
  onToolActivity?: (kind: 'start' | 'end', toolCallId: string) => void;
}

export function subscribeSessionEvents(
  session: AgentSession,
  handlers: OpsRuntimeHandlers,
  hooks: SessionEventHooks = {}
): () => void {
  // P0-C：事件 id 用 randomUUID——续接/重建会话后 id 绝不与历史消息串写。
  let currentMessageId = randomUUID();
  const emit = (e: OpsRuntimeEvent): void => handlers.onEvent?.(e);

  return session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_start': {
        const role = (event.message as { role?: string }).role;
        if (role === 'assistant') {
          currentMessageId = randomUUID();
        }
        break;
      }
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') {
          emit({ type: 'text_delta', id: currentMessageId, text: e.delta });
        } else if (e.type === 'thinking_delta') {
          emit({ type: 'thinking_delta', id: currentMessageId, text: e.delta });
        }
        break;
      }
      case 'message_end': {
        // P1-4：assistant 消息落定时上报 token/成本/上下文水位。
        const message = event.message as { role?: string; usage?: Record<string, unknown> };
        if (message.role === 'assistant' && message.usage !== undefined) {
          emit({
            type: 'usage',
            ...toUsageView(message.usage, session.getContextUsage())
          });
        }
        break;
      }
      case 'compaction_end': {
        // 自动 compaction（threshold/overflow）在这里上报；manual（含
        // recoverFromPromptError 的恢复路径）由发起方自行发事件，避免重复。
        if (!event.aborted && event.reason !== 'manual') {
          const summary = event.result?.summary;
          emit({
            type: 'compaction',
            summary:
              typeof summary === 'string' && summary.trim().length > 0
                ? summary
                : '上下文接近模型窗口，已自动压缩早期对话。'
          });
        }
        break;
      }
      case 'tool_execution_start':
        emit({ type: 'tool_start', id: event.toolCallId, name: event.toolName });
        hooks.onToolActivity?.('start', event.toolCallId);
        break;
      case 'tool_execution_end': {
        const preview = truncatePreview(extractResultText(event.result));
        emit({
          type: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          preview: event.isError ? undefined : preview,
          error: event.isError ? preview : undefined
        });
        hooks.onToolActivity?.('end', event.toolCallId);
        break;
      }
      case 'agent_end':
        emit({ type: 'idle' });
        hooks.onIdle?.();
        break;
      default:
        break;
    }
  });
}
