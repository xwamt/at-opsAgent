/**
 * 扩展入口（src/extension.ts re-export 自此）。
 *
 * activate 保持廉价（docs/08-performance.md）：
 * detectHostApp → Output Channel → 注册命令/Chat WebviewView → 状态栏 →
 * 创建 HubHost 并 void start()。不 await LLM / createOpsRuntime——
 * runtime 由首个 chat/prompt 懒创建（HostController.ensureRuntime）。
 *
 * UI 收敛（Cline 式单视图）：活动栏只保留 atOpsAgent.chat 一个 webview；
 * 会话/能力/审批/技能/模型不再注册 TreeView，全部收敛到设置页
 * （settingsView.ts）与聊天内卡片；Ops 看板经 atOpsAgent.openBoard
 * 以编辑器页（WebviewPanel）按需打开。
 */
import * as vscode from 'vscode';
import { detectHostApp } from '@at-series/mcp-hub';
import type { HubHost } from '../protocol';
import { CHAT_VIEW_ID, ChatViewProvider } from './chatView';
import { registerCommands } from './commands';
import { FallbackHubHost } from './fallback/fallbackHub';
import { HostController } from './hostController';
import { loadHubHostModule } from './modules';
import { OpsSecrets } from './secrets';
import { SessionStore } from './sessionStore';

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

  // ── Chat WebviewView（活动栏唯一视图） ─────────────────────────────────
  const chatView = new ChatViewProvider(context.extensionUri, controller);
  context.subscriptions.push(
    chatView,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ── 状态栏：AT Ops + 待审批数；点击聚焦对话视图 ────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    'atOpsAgent.status',
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = 'AT Ops Agent';
  // 视图贡献自动生成的 focus 命令：聚焦活动栏 chat 视图。
  statusBar.command = `${CHAT_VIEW_ID}.focus`;
  const updateStatusBar = () => {
    const pending = store.pendingBriefs.length;
    statusBar.text = pending > 0 ? `$(shield) AT Ops ${pending}` : '$(shield) AT Ops';
    statusBar.tooltip =
      pending > 0
        ? `AT Ops Agent：${pending} 条待审批简报（点击打开对话处理）`
        : 'AT Ops Agent：点击打开对话';
  };
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar, store.onDidChangeApprovals(() => updateStatusBar()));

  // ── 命令 ───────────────────────────────────────────────────────────────
  const refresh = () => {
    updateStatusBar();
    controller.refreshSkills();
  };
  context.subscriptions.push(
    ...registerCommands({
      controller,
      chatView,
      hostApp,
      output,
      refresh,
      extensionUri: context.extensionUri
    })
  );

  log(`[activate] 完成，耗时 ${Date.now() - startedAt}ms`);
}

export function deactivate(): void {
  // 清理走 context.subscriptions（含状态栏）；Bridge registry 由各插件自持（Agent 不写）。
}
