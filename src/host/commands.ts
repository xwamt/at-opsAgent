/**
 * package.json contributes.commands 中命令的实现与注册，
 * 外加两条不进 contributes 的程序化命令（escalateSelect / openArtifact）。
 *
 * UI 收敛后：openSettings / openModels 打开自有设置页（settingsView.ts，
 * openModels 聚焦 Models 页签）；openBoard 以编辑器页打开 Ops 看板；
 * toggleHistory 让 chat webview 开关历史抽屉。
 */
import * as vscode from 'vscode';
import { showBoardPanel } from './boardView';
import type { ChatViewProvider } from './chatView';
import { diagnoseHub } from './diagnose';
import type { HostController } from './hostController';
import { showSettingsPanel } from './settingsView';

export interface CommandDeps {
  controller: HostController;
  chatView: ChatViewProvider;
  hostApp: string;
  output: vscode.OutputChannel;
  /** 状态栏 + 技能缓存刷新（原 refreshTrees；树视图已收敛到设置页）。 */
  refresh: () => void;
  extensionUri: vscode.Uri;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { controller, chatView, hostApp, output, refresh, extensionUri } = deps;
  const settingsDeps = { extensionUri, controller };

  const newSession = vscode.commands.registerCommand('atOpsAgent.newSession', () => {
    controller.newSession();
    chatView.postHydrate();
    refresh();
  });

  const toggleHistory = vscode.commands.registerCommand('atOpsAgent.toggleHistory', () => {
    chatView.postHistoryToggle();
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
    showSettingsPanel(settingsDeps);
  });

  const openModels = vscode.commands.registerCommand('atOpsAgent.openModels', () => {
    showSettingsPanel(settingsDeps, 'models');
  });

  const openBoard = vscode.commands.registerCommand('atOpsAgent.openBoard', () => {
    showBoardPanel({ extensionUri, controller });
  });

  const refreshBridges = vscode.commands.registerCommand('atOpsAgent.refreshBridges', async () => {
    try {
      await controller.hub.refresh();
    } catch (err) {
      output.appendLine(
        `[hub] refresh 失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    refresh();
  });

  const diagnose = vscode.commands.registerCommand('atOpsAgent.diagnoseHub', async () => {
    await diagnoseHub({ hostApp, hub: controller.hub, output });
  });

  const approve = vscode.commands.registerCommand('atOpsAgent.approveChange', () =>
    respondToApproval(controller, 'approved')
  );

  const reject = vscode.commands.registerCommand('atOpsAgent.rejectChange', () =>
    respondToApproval(controller, 'rejected')
  );

  const abort = vscode.commands.registerCommand('atOpsAgent.abort', async () => {
    await controller.abort();
  });

  // 不进 package.json contributes：escalateSelect 绝不自动触发（首轮
  // investigating 之后由用户/模型显式驱动），这里给 webview 深链 /
  // 程序化调用留一个入口，等价于 host 请求 playbook/escalate-select。
  const escalateSelect = vscode.commands.registerCommand('atOpsAgent.escalateSelect', async () => {
    const result = await controller.applyEscalateSelect();
    if (result.ok) {
      void vscode.window.showInformationMessage('已按当前阶段 escalateSelect 扩充工具面。');
    } else {
      void vscode.window.showWarningMessage(`无法扩面：${result.reason ?? '未知原因'}`);
    }
  });

  // 不进 package.json contributes（也就不进命令面板）：只服务 webview 的
  // command: 深链（需要 enableCommandUris），registerCommand 即可被调用。
  const openArtifact = vscode.commands.registerCommand(
    'atOpsAgent.openArtifact',
    async (uri?: string | vscode.Uri) => {
      if (uri === undefined || (typeof uri === 'string' && uri.trim().length === 0)) {
        void vscode.window.showWarningMessage('没有可打开的产物 URI（结果可能已截断且未落盘）。');
        return;
      }
      try {
        const parsed = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
        const doc = await vscode.workspace.openTextDocument(parsed);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[artifact/open] 打开失败: ${message}`);
        void vscode.window.showErrorMessage(`无法打开产物：${message}`);
      }
    }
  );

  return [
    newSession,
    toggleHistory,
    pickPlaybook,
    openSettings,
    openModels,
    openBoard,
    refreshBridges,
    diagnose,
    approve,
    reject,
    abort,
    escalateSelect,
    openArtifact
  ];
}

/** 审批命令（命令面板兜底入口；审批主路径是聊天内 ApprovalBar）。 */
async function respondToApproval(
  controller: HostController,
  decision: 'approved' | 'rejected'
): Promise<void> {
  let briefId: string | undefined;
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
  if (!briefId) return;
  await controller.applyApproval({ briefId, decision });
}
