/**
 * package.json contributes.commands 中九条命令的实现与注册。
 */
import * as vscode from 'vscode';
import { diagnoseHub } from './diagnose';
import type { HostController } from './hostController';
import { showModelsPanel } from './modelsView';
import type { ApprovalTreeItem } from './trees/approvalsTree';
import type { ChatViewProvider } from './chatView';

export interface CommandDeps {
  controller: HostController;
  chatView: ChatViewProvider;
  hostApp: string;
  output: vscode.OutputChannel;
  refreshTrees: () => void;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { controller, chatView, hostApp, output, refreshTrees } = deps;

  const newSession = vscode.commands.registerCommand('atOpsAgent.newSession', () => {
    controller.newSession();
    chatView.postHydrate();
    refreshTrees();
  });

  const pickPlaybook = vscode.commands.registerCommand('atOpsAgent.pickPlaybook', async () => {
    const playbooks = await controller.getPlaybooks();
    if (playbooks.length === 0) {
      void vscode.window.showWarningMessage('未找到任何 playbook（skills/playbooks 为空）。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      playbooks.map((pb) => ({
        label: pb.title ?? pb.id,
        description: pb.id,
        detail: pb.description
      })),
      { placeHolder: '选择要启动的运维链路（playbook）', matchOnDescription: true }
    );
    if (!picked) return;
    const result = await controller.startPlaybook(picked.description ?? picked.label);
    if (result.ok) {
      void vscode.window.showInformationMessage(
        `Playbook ${picked.description} 已启动（阶段: ${result.stage ?? 'triage'}）。`
      );
    }
  });

  const openSettings = vscode.commands.registerCommand('atOpsAgent.openSettings', () => {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'atOpsAgent');
  });

  const openModels = vscode.commands.registerCommand('atOpsAgent.openModels', () => {
    // 配置页 webview（表单 + SecretStorage key）；「打开 models.json」是页内次级动作。
    showModelsPanel({
      modelsPath: controller.modelsPath,
      secrets: controller.secrets,
      output,
      refreshTrees
    });
  });

  const refreshBridges = vscode.commands.registerCommand('atOpsAgent.refreshBridges', async () => {
    try {
      await controller.hub.refresh();
    } catch (err) {
      output.appendLine(
        `[hub] refresh 失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    refreshTrees();
  });

  const diagnose = vscode.commands.registerCommand('atOpsAgent.diagnoseHub', async () => {
    await diagnoseHub({ hostApp, hub: controller.hub, output });
  });

  const approve = vscode.commands.registerCommand(
    'atOpsAgent.approveChange',
    (item?: ApprovalTreeItem) => respondToApproval(controller, 'approved', item)
  );

  const reject = vscode.commands.registerCommand(
    'atOpsAgent.rejectChange',
    (item?: ApprovalTreeItem) => respondToApproval(controller, 'rejected', item)
  );

  const abort = vscode.commands.registerCommand('atOpsAgent.abort', async () => {
    await controller.abort();
  });

  return [
    newSession,
    pickPlaybook,
    openSettings,
    openModels,
    refreshBridges,
    diagnose,
    approve,
    reject,
    abort
  ];
}

async function respondToApproval(
  controller: HostController,
  decision: 'approved' | 'rejected',
  item?: ApprovalTreeItem
): Promise<void> {
  let briefId = item?.brief.id;
  if (!briefId) {
    const pending = controller.store.pendingBriefs;
    if (pending.length === 0) {
      void vscode.window.showInformationMessage('没有待审批的变更简报。');
      return;
    }
    if (pending.length === 1) {
      briefId = pending[0].id;
    } else {
      const picked = await vscode.window.showQuickPick(
        pending.map((b) => ({
          label: b.targetLabel,
          description: `${b.risk} · ${b.id.slice(0, 8)}`,
          briefId: b.id
        })),
        { placeHolder: `选择要${decision === 'approved' ? '批准' : '拒绝'}的简报` }
      );
      briefId = picked?.briefId;
    }
  }
  if (!briefId) return;
  await controller.applyApproval({ briefId, decision });
}
