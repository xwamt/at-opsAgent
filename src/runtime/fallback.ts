/**
 * FallbackRuntime 与 prompt 期错误分类（缺配置 / 凭证 / 429 一次退避）。
 *
 * 从 src/runtime/index.ts 搬移，零行为变化。禁止 import vscode。
 */
import { randomUUID } from 'node:crypto';

import type { NoticeAction } from '../protocol';
import { recoverFromPromptError, type CompactableSessionLike } from './compaction';
import { sanitizeErrorText } from './sanitize';
import type {
  DispatchSubagentResult,
  OpsRuntime,
  OpsRuntimeEvent,
  OpsRuntimeHandlers
} from './types';

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 缺凭证/无可用模型时的兜底文案（P0-A：只在确属配置缺失时使用）。 */
export const FALLBACK_NOTICE = '未配置模型：请打开设置，填写 provider 的 API key 并选择模型。';

/** 其它创建期失败（pi 加载失败、会话创建失败等）的文案前缀。 */
export const FALLBACK_INIT_FAILURE_PREFIX = '模型运行时初始化失败：';

/** 运行期 401/403：凭证失效，不要说成「未配置模型」。 */
export const CREDENTIAL_NOTICE = '凭证失效或无权限，请打开设置检查 API key';

/** prompt 期 429/5xx 一次退避的生产默认（测试经 retryDelayMs 注入）。 */
export const TRANSIENT_PROMPT_RETRY_MS = 500;

/** notice 事件的「打开设置」动作（host/webview 映射到 atOpsAgent.openModels）。 */
export const OPEN_SETTINGS_NOTICE_ACTION: NoticeAction = {
  id: 'open-settings',
  label: '打开设置',
  command: 'atOpsAgent.openModels'
};

/** notice 事件的「重试」动作（webview 已有 retryable / chat/retry）。 */
export const RETRY_NOTICE_ACTION: NoticeAction = {
  id: 'retry',
  label: '重试',
  request: 'chat/retry'
};

const MISSING_MODEL_CONFIG_PATTERN = new RegExp(
  [
    // 我们自己的创建期错误（resolveModel）
    '未找到模型',
    '没有任何配置了有效凭证的模型',
    '缺少 API key',
    '未配置模型',
    // 常见配置类错误关键词（不含 401/unauthorized：吊销 key 不是「没配」）
    'api[ _-]?key',
    'credential',
    'no models? (are )?(available|configured)',
    'not configured',
    'missing (api )?key',
    '凭证'
  ].join('|'),
  'i'
);

const CREDENTIAL_ERROR_PATTERN = /\b401\b|\b403\b|unauthorized|forbidden/i;

const TRANSIENT_ERROR_PATTERN =
  /\b429\b|\b5\d{2}\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i;

/** 失败原因是否属于「缺 key / 无可用模型」这类配置缺失（P0-A 文案分流）。 */
export function looksLikeMissingModelConfig(reason?: string): boolean {
  if (reason === undefined || reason.trim().length === 0) return true; // 无原因 = 从未配置
  return MISSING_MODEL_CONFIG_PATTERN.test(reason);
}

/** prompt / 创建期错误分类（先刮密再匹配，避免 Bearer 干扰）。 */
export type PromptErrorClass = 'missing_config' | 'credential' | 'transient' | 'other';

export function classifyPromptError(error: unknown): PromptErrorClass {
  const message = sanitizeErrorText(describeError(error));
  if (looksLikeMissingModelConfig(message)) return 'missing_config';
  if (CREDENTIAL_ERROR_PATTERN.test(message)) return 'credential';
  if (TRANSIENT_ERROR_PATTERN.test(message)) return 'transient';
  return 'other';
}

function emitPromptErrorNotice(
  error: unknown,
  kind: PromptErrorClass,
  onEvent?: (e: OpsRuntimeEvent) => void
): void {
  const sanitized = sanitizeErrorText(describeError(error));
  let text: string;
  let actions: NoticeAction[] | undefined;
  switch (kind) {
    case 'credential':
      text = CREDENTIAL_NOTICE;
      actions = [OPEN_SETTINGS_NOTICE_ACTION];
      break;
    case 'missing_config':
      text = FALLBACK_NOTICE;
      actions = [OPEN_SETTINGS_NOTICE_ACTION];
      break;
    case 'transient':
      text = `模型调用失败：${sanitized}`;
      actions = [RETRY_NOTICE_ACTION];
      break;
    default:
      text = `模型调用失败：${sanitized}`;
      break;
  }
  onEvent?.({ type: 'text_delta', id: randomUUID(), text });
  onEvent?.({
    type: 'notice',
    variant: 'error',
    text,
    ...(actions !== undefined ? { actions } : {})
  });
  onEvent?.({ type: 'idle' });
}

/**
 * compact 恢复之后的分类 + 429/5xx **严格一次**退避。
 * 从不抛错：失败一律转 notice + idle。闭包 flag 与 compact 同一纪律。
 */
export async function handleClassifiedPromptError(input: {
  error: unknown;
  retry: () => Promise<void>;
  onEvent?: (e: OpsRuntimeEvent) => void;
  retryDelayMs?: number;
}): Promise<void> {
  let retried = false;
  const kind = classifyPromptError(input.error);
  if (kind === 'transient' && !retried) {
    retried = true;
    const delay = input.retryDelayMs ?? TRANSIENT_PROMPT_RETRY_MS;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    try {
      await input.retry();
      return;
    } catch (retryError) {
      emitPromptErrorNotice(retryError, classifyPromptError(retryError), input.onEvent);
      return;
    }
  }
  emitPromptErrorNotice(input.error, kind, input.onEvent);
}

/**
 * prompt() catch 装配：先 compact 一次，再分类/一次退避。供单测直接驱动。
 */
export async function runPromptWithRecovery(input: {
  run: () => Promise<void>;
  session: CompactableSessionLike;
  onEvent?: (e: OpsRuntimeEvent) => void;
  onCompaction?: (summary: string) => void;
  retryDelayMs?: number;
}): Promise<void> {
  try {
    await input.run();
  } catch (error) {
    try {
      await recoverFromPromptError({
        session: input.session,
        error,
        retry: input.run,
        ...(input.onCompaction !== undefined ? { onCompaction: input.onCompaction } : {})
      });
    } catch (finalError) {
      await handleClassifiedPromptError({
        error: finalError,
        retry: input.run,
        ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}),
        retryDelayMs: input.retryDelayMs ?? TRANSIENT_PROMPT_RETRY_MS
      });
    }
  }
}

/**
 * 模型运行时创建失败时的兜底实现。prompt 时用中文说明现状并回到 idle，
 * 绝不抛错，保证扩展可激活。文案分流（P0-A）：
 * - 缺 key / 无可用模型 → FALLBACK_NOTICE + notice 事件带「打开设置」动作；
 * - 其它失败 → 「模型运行时初始化失败：<reason>」。
 * 两类都绝不提内部实现（能力插件树 / src 路径）。
 */
export function createFallbackRuntime(handlers: OpsRuntimeHandlers, reason?: string): OpsRuntime {
  const missingConfig = looksLikeMissingModelConfig(reason);
  const credential =
    !missingConfig && reason !== undefined && classifyPromptError(reason) === 'credential';
  const message = missingConfig
    ? reason !== undefined && reason.length > 0
      ? `${FALLBACK_NOTICE}\n（原因：${reason}）`
      : FALLBACK_NOTICE
    : credential
      ? CREDENTIAL_NOTICE
      : `${FALLBACK_INIT_FAILURE_PREFIX}${reason}`;
  return {
    async prompt(): Promise<void> {
      handlers.onEvent?.({ type: 'text_delta', id: `fallback-${randomUUID()}`, text: message });
      handlers.onEvent?.({
        type: 'notice',
        variant: 'error',
        text: message,
        ...(missingConfig || credential ? { actions: [OPEN_SETTINGS_NOTICE_ACTION] } : {})
      });
      handlers.onEvent?.({ type: 'idle' });
    },
    abort(): void {
      // 无进行中的模型调用，无事可做（cancel/stop 同为 no-op）。
    },
    async dispose(): Promise<void> {
      // 无资源可释放。
    },
    setSystemPrompt(): void {
      // 无会话，忽略；等模型配置好后重建 runtime 时再生效。
    },
    setThinkingLevel(): void {
      // 无会话，忽略；host 重建 runtime 时经 options.thinkingLevel 生效。
    },
    async dispatchSubagent(): Promise<DispatchSubagentResult> {
      // no-op：模型不可用时不派发，也不抛错。
      return { taskId: '', status: 'unavailable', notice: `无法派发子代理：${message}` };
    },
    abortSubagent(): void {
      // 无子代理在跑，无事可做。
    },
    async probeModel(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
      return { ok: false, error: message };
    }
  };
}
