/**
 * 扩展入口（src/extension.ts re-export 自此）。
 *
 * activate 保持廉价（docs/08-performance.md）：
 * detectHostApp → Output Channel → 注册命令/TreeView/WebviewView →
 * 创建 HubHost 并 void start()。不 await LLM / createOpsRuntime——
 * runtime 由首个 chat/prompt 懒创建（HostController.ensureRuntime）。
 */
import * as vscode from 'vscode';
import { detectHostApp } from '@at-series/mcp-hub';
import type { HubHost } from '../protocol';
import { BOARD_VIEW_ID, BoardViewProvider } from './boardView';
import { CHAT_VIEW_ID, ChatViewProvider } from './chatView';
import { registerCommands } from './commands';
import { FallbackHubHost } from './fallback/fallbackHub';
import { HostController } from './hostController';
import { loadHubHostModule } from './modules';
import { OpsSecrets } from './secrets';
import { SessionStore } from './sessionStore';
import { ApprovalsTreeProvider } from './trees/approvalsTree';
import { CapabilitiesTreeProvider } from './trees/capabilitiesTree';
import { ModelsTreeProvider } from './trees/modelsTree';
import { SessionsTreeProvider } from './trees/sessionsTree';
import { SkillsTreeProvider } from './trees/skillsTree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const startedAt = Date.now();
  const output = vscode.window.createOutputChannel('AT Ops Agent');
  context.subscriptions.push(output);
  const log = (message: string) => output.appendLine(message);

  const hostApp = detectHostApp({
    appName: vscode.env.appName,
    appRoot: vscode.env.appRoot,
    uriScheme: vscode.env.uriScheme,
    extensionPath: context.extensionPath
  });
  log(`[activate] hostApp=${hostApp}`);

  const secrets = new OpsSecrets(context.secrets);
  const store = new SessionStore();
  context.subscriptions.push({ dispose: () => store.dispose() });

  // ── HubHost：并行模块优先，缺失则内置只读兜底（阶段 0 底线） ─────────────
  const config = vscode.workspace.getConfiguration('atOpsAgent');
  const discovery = {
    mode: config.get<'auto' | 'always' | 'off'>('discovery.mode', 'auto'),
    threshold: config.get<number>('discovery.threshold', 20)
  };
  let hub: HubHost | undefined;
  const hubModule = await loadHubHostModule(log);
  if (hubModule) {
    try {
      hub = await Promise.resolve(hubModule.createAtSeriesHubHost({ hostApp, discovery, log }));
    } catch (err) {
      log(
        `[hub] createAtSeriesHubHost 失败（${err instanceof Error ? err.message : String(err)}），使用内置只读 Hub`
      );
    }
  }
  if (!hub) {
    hub = new FallbackHubHost({ hostApp, discovery, log });
  }
  const hubRef = hub;
  context.subscriptions.push({ dispose: () => hubRef.dispose() });
  // 不阻塞 activate：watch + 后台基线探测在 start 内部进行。
  void hubRef
    .start()
    .catch((err) =>
      log(`[hub] start 失败: ${err instanceof Error ? err.message : String(err)}`)
    );

  const controller = new HostController({
    hub: hubRef,
    store,
    secrets,
    output,
    extensionPath: context.extensionPath
  });
  context.subscriptions.push({ dispose: () => controller.dispose() });

  // ── TreeViews ───────────────────────────────────────────────────────────
  const capabilitiesProvider = new CapabilitiesTreeProvider(() => hubRef);
  const capabilitiesView = vscode.window.createTreeView('atOpsAgent.capabilities', {
    treeDataProvider: capabilitiesProvider,
    showCollapseAll: true
  });
  const sessionsProvider = new SessionsTreeProvider(store);
  const approvalsProvider = new ApprovalsTreeProvider(store);
  const approvalsView = vscode.window.createTreeView('atOpsAgent.approvals', {
    treeDataProvider: approvalsProvider
  });
  const skillsProvider = new SkillsTreeProvider(context.extensionPath);
  const modelsProvider = new ModelsTreeProvider(controller.modelsPath);
  context.subscriptions.push(
    capabilitiesProvider,
    capabilitiesView,
    sessionsProvider,
    vscode.window.registerTreeDataProvider('atOpsAgent.sessions', sessionsProvider),
    approvalsProvider,
    approvalsView,
    skillsProvider,
    vscode.window.registerTreeDataProvider('atOpsAgent.skills', skillsProvider),
    modelsProvider,
    vscode.window.registerTreeDataProvider('atOpsAgent.models', modelsProvider)
  );

  // context key atOpsAgent.bridgeCount（viewsWelcome 空态依赖）+ unhealthy badge
  const updateCapabilities = () => {
    capabilitiesProvider.refresh();
    const { bridges, unhealthy } = capabilitiesProvider.counts();
    void vscode.commands.executeCommand('setContext', 'atOpsAgent.bridgeCount', bridges);
    capabilitiesView.badge =
      unhealthy > 0 ? { value: unhealthy, tooltip: `${unhealthy} 个能力插件不健康` } : undefined;
  };
  void vscode.commands.executeCommand('setContext', 'atOpsAgent.bridgeCount', 0);
  context.subscriptions.push(hubRef.onDidChangeTools(() => updateCapabilities()));

  // 审批 badge
  const updateApprovalsBadge = () => {
    const count = store.pendingBriefs.length;
    approvalsView.badge =
      count > 0 ? { value: count, tooltip: `${count} 条待审批简报` } : undefined;
  };
  context.subscriptions.push(store.onDidChangeApprovals(() => updateApprovalsBadge()));

  // ── WebviewViews ───────────────────────────────────────────────────────
  const chatView = new ChatViewProvider(context.extensionUri, controller);
  const boardView = new BoardViewProvider(context.extensionUri, controller);
  context.subscriptions.push(
    chatView,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatView, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    boardView,
    vscode.window.registerWebviewViewProvider(BOARD_VIEW_ID, boardView)
  );

  // ── 命令 ───────────────────────────────────────────────────────────────
  const refreshTrees = () => {
    updateCapabilities();
    updateApprovalsBadge();
    skillsProvider.refresh();
    modelsProvider.refresh();
  };
  context.subscriptions.push(
    ...registerCommands({ controller, chatView, hostApp, output, refreshTrees })
  );

  log(`[activate] 完成，耗时 ${Date.now() - startedAt}ms`);
}

export function deactivate(): void {
  // 清理走 context.subscriptions；Bridge registry 由各插件自持（Agent 不写）。
}
