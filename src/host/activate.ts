/**
 * 扩展入口（src/extension.ts re-export 自此）。
 *
 * activate 保持廉价（docs/08-performance.md）：
 * detectHostApp → Output Channel → 注册命令/Chat WebviewView → 状态栏 →
 * 经 OpsCore facade 静态创建 HubHost 并 void start()。不 await LLM /
 * createOpsRuntime——runtime 由首个 chat/prompt 懒创建
 * （HostController.ensureRuntime）。
 *
 * UI 收敛（Cline 式单视图）：活动栏只保留 atOpsAgent.chat 一个 webview；
 * 会话/能力/审批/技能/模型不再注册 TreeView，全部收敛到设置页
 * （settingsView.ts）与聊天内卡片；Ops 看板经 atOpsAgent.openBoard
 * 以编辑器页（WebviewPanel）按需打开。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectHostApp } from '@at-series/mcp-hub';
import { createOpsCore } from '../core';
import { CHAT_VIEW_ID, ChatViewProvider } from './chatView';
import { registerCommands } from './commands';
import { HostController } from './hostController';
import { handleChatDeeplink } from './services/approvalNotify';
import { OpsSecrets } from './secrets';
import { pruneToolResults } from './retention';
import { inspectLatestAuditChain } from './services/auditChain';
import { registerEnvironmentSaveGuard } from './services/longTermMemory';
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

  // running context key：菜单 when 子句（abort 仅运行中可见）初始为 false。
  void vscode.commands.executeCommand('setContext', 'atOpsAgent.running', false);

  const secrets = new OpsSecrets(context.secrets);
  // P1-3：会话持久化到 ~/.at-series/agent/ui-sessions.json，构造期同步回载。
  const agentDir = path.join(os.homedir(), '.at-series', 'agent');
  const store = new SessionStore({ agentDir });
  context.subscriptions.push({ dispose: () => store.dispose() });

  // ── HubHost：OpsCore facade 静态创建（P1-8：动态装载器与 fallback 已删） ──
  const core = createOpsCore();
  const config = vscode.workspace.getConfiguration('atOpsAgent');
  const hub = core.createHub({
    hostApp,
    discovery: {
      mode: config.get<'auto' | 'always' | 'off'>('discovery.mode', 'auto'),
      threshold: config.get<number>('discovery.threshold', 20)
    },
    selectionIdleMs: 0,
    log
  });
  context.subscriptions.push({ dispose: () => hub.dispose() });
  // 不阻塞 activate：watch + 后台基线探测在 start 内部进行。
  void hub
    .start()
    .catch((err) =>
      log(`[hub] start 失败: ${err instanceof Error ? err.message : String(err)}`)
    );

  const controller = new HostController({
    hub,
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

  // ── 状态栏：AT Ops + 待审批数；未配置 key 时警示并指向 Models 设置 ─────
  const statusBar = vscode.window.createStatusBarItem(
    'atOpsAgent.status',
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = 'AT Ops Agent';
  /** HubHost 无 setDiscovery：discovery.mode/threshold 改了只提示重载，禁止静默 no-op。 */
  let discoveryReloadNeeded = false;
  const updateStatusBar = () => {
    const pending = store.pendingBriefs.length;
    if (!controller.hasModelApiKey) {
      // P1-11：未配置 API key → 黄色警示，点击直达 Models 设置页。
      statusBar.text = vscode.l10n.t('$(warning) AT Ops 未配置');
      statusBar.tooltip = discoveryReloadNeeded
        ? vscode.l10n.t('AT Ops Agent：尚未配置模型 API Key。发现设置将在重载窗口后生效。')
        : vscode.l10n.t('AT Ops Agent：尚未配置模型 API Key（点击打开 Models 设置）');
      statusBar.command = 'atOpsAgent.openModels';
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (discoveryReloadNeeded) {
      statusBar.text = vscode.l10n.t('$(warning) AT Ops 需重载');
      statusBar.tooltip = vscode.l10n.t('AT Ops Agent：发现设置将在重载窗口后生效（点击重载窗口）');
      statusBar.command = 'workbench.action.reloadWindow';
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBar.text =
        pending > 0
          ? vscode.l10n.t('$(shield) AT Ops {0}', pending)
          : vscode.l10n.t('$(shield) AT Ops');
      statusBar.tooltip =
        pending > 0
          ? vscode.l10n.t('AT Ops Agent：{0} 条待审批简报（点击打开对话处理）', pending)
          : vscode.l10n.t('AT Ops Agent：点击打开对话');
      // 视图贡献自动生成的 focus 命令：聚焦活动栏 chat 视图。
      statusBar.command = `${CHAT_VIEW_ID}.focus`;
      statusBar.backgroundColor = undefined;
    }
  };
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(
    statusBar,
    store.onDidChangeApprovals(() => updateStatusBar()),
    controller.onDidChangeStatus(() => updateStatusBar()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('atOpsAgent.discovery')) return;
      // HubHost 构造后不支持 setDiscovery；销毁重建会拆掉 controller 已持有的 hub。
      discoveryReloadNeeded = true;
      log('[hub] discovery.mode/threshold 已更改，将在重载窗口后生效（HubHost 无 setDiscovery）');
      updateStatusBar();
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t('AT Ops Agent：发现设置将在重载窗口后生效'),
          vscode.l10n.t('重载窗口')
        )
        .then((choice) => {
          if (choice === vscode.l10n.t('重载窗口')) {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    })
  );

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
    }),
    registerEnvironmentSaveGuard(() => controller.memoryDir())
  );

  // vscode://at-series.at-ops-agent/chat?sessionId= — 只切会话，不是批准 API。
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        void handleChatDeeplink(uri, {
          switchSession: (id) => controller.switchSession(id),
          focusChat: () => vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`),
          log
        }).then((outcome) => {
          if (outcome === 'missing') {
            void vscode.window.showWarningMessage(`AT Ops Agent：深链会话不存在（${uri.query}）`);
          }
        });
      }
    })
  );

  // ── 定时巡检提醒（P2）：到点弹提示，人点了才启动 pb.inspection ──────────
  scheduleInspectionReminder(context, controller, log);

  log(`[activate] 完成，耗时 ${Date.now() - startedAt}ms`);

  // 过期 tool-results / 未被引用的 sessions JSONL：不阻塞启动，失败只记日志。
  void pruneToolResults(agentDir).catch((err) =>
    log(`[retention] prune 失败: ${err instanceof Error ? err.message : String(err)}`)
  );
  // 最新审计日文件链断只警告，不重写历史。
  void inspectLatestAuditChain(agentDir)
    .then((result) => {
      if (!result.ok) {
        log(
          `[audit] 最新审计文件链校验失败（不重写历史）${
            result.file !== undefined ? ` file=${result.file}` : ''
          }: ${result.reason ?? 'broken'}`
        );
      }
    })
    .catch((err) =>
      log(`[audit] 链校验异常: ${err instanceof Error ? err.message : String(err)}`)
    );
}

/**
 * atOpsAgent.inspection.intervalMinutes > 0 时按间隔弹 InformationMessage，
 * 用户点「启动巡检」才跑 pb.inspection——绝不静默自动执行任何链路。
 * 配置变更即时生效（重建定时器）。
 */
function scheduleInspectionReminder(
  context: vscode.ExtensionContext,
  controller: HostController,
  log: (message: string) => void
): void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const arm = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const minutes = vscode.workspace
      .getConfiguration('atOpsAgent')
      .get<number>('inspection.intervalMinutes', 0);
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return;
    const intervalMs = Math.max(1, Math.round(minutes)) * 60_000;
    timer = setInterval(() => {
      void vscode.window
        .showInformationMessage('AT Ops Agent：到达巡检时间，是否启动例行巡检链路？', '启动巡检')
        .then(async (choice) => {
          if (choice !== '启动巡检') return;
          const result = await controller.startPlaybook('pb.inspection');
          if (result.ok) {
            await vscode.commands.executeCommand('atOpsAgent.chat.focus');
          } else {
            void vscode.window.showWarningMessage(
              `无法启动巡检链路：${result.error ?? '未知原因'}`
            );
          }
        });
    }, intervalMs);
    log(`[inspection] 巡检提醒已启用（每 ${minutes} 分钟）`);
  };

  arm();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('atOpsAgent.inspection.intervalMinutes')) arm();
    }),
    {
      dispose: () => {
        if (timer !== undefined) clearInterval(timer);
      }
    }
  );
}

export function deactivate(): void {
  // 清理走 context.subscriptions（含状态栏）；Bridge registry 由各插件自持（Agent 不写）。
}
