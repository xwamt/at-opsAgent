/**
 * 审批简报的对外呈现（ApprovalService 拆件）：
 * - ApprovalBriefLike → webview 视图（9 要素 + 双确认提示）；
 * - IM webhook（Plan 12 T7）：待审批时 POST 脱敏摘要 JSON（无令牌 / 无凭证 /
 *   无完整命令集），含 vscode:// 深链，提示值班人回 IDE 批准。失败只记日志，
 *   不影响主链路。
 *
 * 单向：只出站 POST。没有 inbound HTTP、没有 IM 上点批准的回调。
 * 深链 UriHandler 只切会话，不是批准 API。
 */
import { createHmac } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalBriefView } from '../../protocol';
import type { ApprovalBriefLike } from '../hostTypes';
import { IM_WEBHOOK_SECRET_KEY } from '../secrets';
import { describeError } from './context';

/** package.json publisher + name；vscode:// 深链 authority。 */
export const IM_EXTENSION_ID = 'at-series.at-ops-agent';

/** HMAC-SHA256(hex) 放在此请求头；密钥只在 SecretStorage。 */
export const IM_SIGNATURE_HEADER = 'X-At-Ops-Signature';

const APPROVE_IN_IDE_HINT =
  '请回到 IDE 的 AT Ops Agent 会话中查看 9 要素简报并批准/拒绝。';

export type ApprovalWebhookContext = {
  log: (message: string) => void;
  secrets: { get(key: string): Thenable<string | undefined> };
};

export function toBriefView(brief: ApprovalBriefLike): ApprovalBriefView {
  const elements: Record<string, string | unknown> = { ...(brief.elements ?? {}) };
  if (brief.commandSet !== undefined && elements.commands === undefined) {
    elements.commands = brief.commandSet;
  }
  // 默认双确认（会话审批 + 插件内确认弹窗）；仅当用户显式开启
  // dedupePluginModal 去重时 UI 才不再提示第二道闸。
  const dedupePluginModal = vscode.workspace
    .getConfiguration('atOpsAgent')
    .get<boolean>('approval.dedupePluginModal', false);
  return {
    id: brief.briefId,
    risk: brief.risk,
    targetLabel: brief.elements?.goal ?? `${brief.risk} 变更（run ${brief.runId}）`,
    elements,
    dualConfirmHint: !dedupePluginModal
  };
}

/** `vscode://at-series.at-ops-agent/chat?sessionId=`（scheme 随宿主，缺省 vscode）。 */
export function approvalChatDeeplink(
  sessionId: string,
  uriScheme: string = vscode.env.uriScheme || 'vscode'
): string {
  const scheme = uriScheme.trim().length > 0 ? uriScheme.trim() : 'vscode';
  return `${scheme}://${IM_EXTENSION_ID}/chat?sessionId=${encodeURIComponent(sessionId)}`;
}

export function hmacSha256Hex(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function buildApprovalWebhookBody(
  view: ApprovalBriefView,
  sessionId: string,
  options?: { ts?: number; uriScheme?: string }
): string {
  return JSON.stringify({
    type: 'approval/request',
    briefId: view.id,
    risk: view.risk,
    target: view.targetLabel,
    sessionId,
    ts: options?.ts ?? Date.now(),
    deeplink: approvalChatDeeplink(sessionId, options?.uriScheme),
    hint: APPROVE_IN_IDE_HINT
  });
}

/**
 * 解析 `…/chat?sessionId=` 深链。其它 path 一律忽略——
 * 本 handler 只切会话，不是批准入口。
 */
export function parseChatDeeplinkSessionId(uri: {
  path?: string;
  query?: string;
}): string | undefined {
  const rawPath = (uri.path ?? '').replace(/\/+$/, '');
  const leaf = rawPath.slice(rawPath.lastIndexOf('/') + 1);
  if (leaf !== 'chat') return undefined;
  const sessionId = new URLSearchParams(uri.query ?? '').get('sessionId')?.trim();
  return sessionId !== undefined && sessionId.length > 0 ? sessionId : undefined;
}

export async function handleChatDeeplink(
  uri: { path?: string; query?: string },
  deps: {
    switchSession: (id: string) => { ok: boolean };
    focusChat: () => Thenable<unknown>;
    log: (message: string) => void;
  }
): Promise<'switched' | 'ignored' | 'missing'> {
  const sessionId = parseChatDeeplinkSessionId(uri);
  if (sessionId === undefined) {
    deps.log('[im] deeplink 已忽略（只接受 /chat?sessionId=，不是批准入口）');
    return 'ignored';
  }
  const result = deps.switchSession(sessionId);
  if (!result.ok) {
    deps.log(`[im] deeplink 会话不存在: ${sessionId}`);
    return 'missing';
  }
  await deps.focusChat();
  return 'switched';
}

/**
 * 待审 IM 摘要。密钥空：仍 POST（兼容现状）并 log「未加签」。
 * 密钥在 SecretStorage（`IM_WEBHOOK_SECRET_KEY`），不进 settings 明文。
 */
export function postApprovalWebhook(
  ctx: ApprovalWebhookContext,
  view: ApprovalBriefView,
  sessionId: string
): void {
  void sendApprovalWebhook(ctx, view, sessionId);
}

export async function sendApprovalWebhook(
  ctx: ApprovalWebhookContext,
  view: ApprovalBriefView,
  sessionId: string
): Promise<void> {
  const url = vscode.workspace.getConfiguration('atOpsAgent').get<string>('im.webhookUrl', '');
  if (typeof url !== 'string' || url.trim().length === 0) return;
  const body = buildApprovalWebhookBody(view, sessionId);
  let secret = '';
  try {
    const stored = await ctx.secrets.get(IM_WEBHOOK_SECRET_KEY);
    if (typeof stored === 'string') secret = stored.trim();
  } catch (err) {
    ctx.log(`[im] 读取 webhook 加签密钥失败: ${describeError(err)}`);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret.length === 0) {
    ctx.log('[im] webhook 未加签（SecretStorage 无 im.webhookSecret）');
  } else {
    headers[IM_SIGNATURE_HEADER] = hmacSha256Hex(body, secret);
  }
  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) ctx.log(`[im] webhook 返回 ${res.status}`);
  } catch (err) {
    ctx.log(`[im] webhook 推送失败: ${describeError(err)}`);
  }
}
