/**
 * Compaction 第 2–3 层（docs/03 §5）。
 *
 * 第 1 层（工具结果 8KB 截断 + 完整 JSON 落盘 tool-results/）在
 * src/runtime/index.ts 的 executeBusinessTool 里，保持不变。
 *
 * 本模块处理 prompt 期的上下文溢出（prompt too long / context overflow）：
 * - 第 2 层：AgentSession 支持 .compact() 时强制压缩一次；
 * - 第 3 层：压缩后重试同一条 prompt 一次；仍失败（或会话不支持
 *   compact、compact 本身失败）则抛中文错误请用户开新会话。
 * 严格「compact 一次 + retry 一次」，绝不无限重试。
 *
 * 挂接点：src/runtime/index.ts 的 prompt() catch 路径。非溢出错误原样
 * 上抛（保留原始错误信息），不触发 compact。
 */

/** 压缩后仍失败时抛出的中文提示（请用户开新会话）。 */
export const COMPACTION_NEW_SESSION_MESSAGE =
  '上下文已超过模型窗口，自动压缩后仍无法继续；请开启新会话，' +
  '并把关键结论（证据便签、审批简报）带到新会话继续。';

const PROMPT_TOO_LONG_PATTERN = new RegExp(
  [
    'prompt is too long',
    'prompt too long',
    'prompt_too_long',
    'too many tokens',
    'input is too long',
    'input length',
    'request too large',
    'maximum context',
    'context length',
    'context window',
    'context_length_exceeded',
    'context overflow',
    'exceeds? the (maximum )?(context|token)'
  ].join('|'),
  'i'
);

/** 是否为「prompt 过长 / 上下文溢出」类错误（按 message 关键词识别）。 */
export function isPromptTooLongError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return PROMPT_TOO_LONG_PATTERN.test(message);
}

/** 恢复流程需要的会话最小面（pi AgentSession 的 compact() 可选存在）。 */
export interface CompactableSessionLike {
  compact?: (customInstructions?: string) => Promise<unknown>;
}

/** compact 成功但结果形状未知时的兜底摘要（P1-4 compaction 事件文案）。 */
export const COMPACTION_FALLBACK_SUMMARY = '上下文超过模型窗口，已自动压缩早期对话后重试。';

/** 从 pi 的 CompactionResult（或任意返回值）提取 summary 文本。 */
function extractCompactionSummary(result: unknown): string {
  if (result !== null && typeof result === 'object') {
    const summary = (result as { summary?: unknown }).summary;
    if (typeof summary === 'string' && summary.trim().length > 0) return summary;
  }
  return COMPACTION_FALLBACK_SUMMARY;
}

/**
 * prompt() catch 路径的恢复入口：
 * - error 不是溢出类 → 原样 rethrow（调用方继续走原有错误上报）；
 * - 溢出 → compact 一次并 retry 一次；任何一步失败都抛
 *   COMPACTION_NEW_SESSION_MESSAGE（不再重试）；
 * - compact 成功后回调 onCompaction(summary)（P1-4：runtime 借此发
 *   { type:'compaction' } 事件，UI 在时间线插系统事件）。回调时机在
 *   retry 之前——即使重试仍失败，用户也能看到「已压缩」的事实。
 */
export async function recoverFromPromptError(input: {
  session: CompactableSessionLike;
  error: unknown;
  retry: () => Promise<void>;
  onCompaction?: (summary: string) => void;
}): Promise<void> {
  if (!isPromptTooLongError(input.error)) {
    throw input.error;
  }
  const compact = input.session.compact;
  if (typeof compact !== 'function') {
    throw new Error(COMPACTION_NEW_SESSION_MESSAGE);
  }
  let compactionResult: unknown;
  try {
    compactionResult = await compact.call(input.session);
  } catch {
    throw new Error(COMPACTION_NEW_SESSION_MESSAGE);
  }
  input.onCompaction?.(extractCompactionSummary(compactionResult));
  try {
    await input.retry();
  } catch {
    throw new Error(COMPACTION_NEW_SESSION_MESSAGE);
  }
}
