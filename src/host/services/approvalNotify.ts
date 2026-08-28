/**
 * 审批简报的对外呈现（ApprovalService 拆件）：
 * - ApprovalBriefLike → webview 视图（9 要素 + 双确认提示）；
 * - IM webhook（P2）：待审批时 POST 脱敏摘要 JSON（无令牌 / 无凭证 /
 *   无完整命令集），提示值班人回 IDE 批准。失败只记日志，不影响主链路。
 */
import * as vscode from 'vscode';
import type { ApprovalBriefView } from '../../protocol';
import type { ApprovalBriefLike } from '../hostTypes';
import { describeError, type HostContext } from './context';

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

export function postApprovalWebhook(
  ctx: HostContext,
  view: ApprovalBriefView,
  sessionId: string
): void {
  const url = vscode.workspace.getConfiguration('atOpsAgent').get<string>('im.webhookUrl', '');
  if (typeof url !== 'string' || url.trim().length === 0) return;
  const body = JSON.stringify({
    type: 'approval/request',
    briefId: view.id,
    risk: view.risk,
    target: view.targetLabel,
    sessionId,
    ts: Date.now(),
    hint: '请回到 IDE 的 AT Ops Agent 会话中查看 9 要素简报并批准/拒绝。'
  });
  void fetch(url.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000)
  })
    .then((res) => {
      if (!res.ok) ctx.log(`[im] webhook 返回 ${res.status}`);
    })
    .catch((err) => ctx.log(`[im] webhook 推送失败: ${describeError(err)}`));
}
