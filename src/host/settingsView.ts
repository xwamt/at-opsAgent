/**
 * 设置页（atOpsAgent.openSettings 打开的编辑器区 WebviewPanel，单例）：
 * - CSP/nonce HTML，脚本 = dist/webview/settings.js（Vue 由 webview-settings 侧实现）
 * - 打开时 POST evt settings/hydrate（controller.settingsSnapshot() 全量快照，
 *   不含任何明文凭证；mcp.json 文本已脱敏）
 * - req 信封（v:1）全部路由到 HostController.handleRequest
 * - 支持 tab 参数：evt settings/tab 让 webview 聚焦指定页签（openModels → 'models'）
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { envelope, type Envelope } from '../protocol';
import { webviewResourceRoots } from './chatView';
import type { HostController } from './hostController';
import { buildWebviewHtml } from './webviewHtml';

export type SettingsTab = 'general' | 'models' | 'capabilities' | 'mcp' | 'sessions';

export interface SettingsPanelDeps {
  extensionUri: vscode.Uri;
  controller: HostController;
}

function isRequestEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as Partial<Envelope>;
  return env.v === 1 && env.dir === 'req' && typeof env.type === 'string';
}

let currentPanel: vscode.WebviewPanel | undefined;

function panelTitle(): string {
  return vscode.env.language.toLowerCase().startsWith('zh') ? '设置' : 'Settings';
}

/** 打开（或聚焦）设置页；单例。tab 指定时通知 webview 切换页签。 */
export function showSettingsPanel(deps: SettingsPanelDeps, tab?: SettingsTab): void {
  const { extensionUri, controller } = deps;
  if (currentPanel) {
    currentPanel.reveal();
    if (tab) postTab(currentPanel, tab);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'atOpsAgent.settingsPanel',
    panelTitle(),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewResourceRoots(extensionUri)
    }
  );
  currentPanel = panel;
  panel.webview.html = buildWebviewHtml({
    webview: panel.webview,
    extensionUri,
    scriptFile: 'settings.js',
    title: panelTitle()
  });

  const messageSub = panel.webview.onDidReceiveMessage((message: unknown) => {
    void onMessage(panel, controller, message);
  });
  panel.onDidDispose(() => {
    messageSub.dispose();
    if (currentPanel === panel) currentPanel = undefined;
  });

  void postHydrate(panel, controller, tab);
}

async function postHydrate(
  panel: vscode.WebviewPanel,
  controller: HostController,
  tab?: SettingsTab
): Promise<void> {
  try {
    const snapshot = await controller.settingsSnapshot();
    void panel.webview.postMessage(envelope('evt', 'settings/hydrate', snapshot, randomUUID()));
  } catch (err) {
    controller.log(
      `[settings] hydrate 失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (tab) postTab(panel, tab);
}

function postTab(panel: vscode.WebviewPanel, tab: SettingsTab): void {
  void panel.webview.postMessage(envelope('evt', 'settings/tab', { tab }, randomUUID()));
}

async function onMessage(
  panel: vscode.WebviewPanel,
  controller: HostController,
  message: unknown
): Promise<void> {
  if (!isRequestEnvelope(message)) return;
  let payload: unknown;
  try {
    payload = await controller.handleRequest(message.type, message.payload);
  } catch (err) {
    payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
    controller.log(
      `[settings] 请求 ${message.type} 处理失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  void panel.webview.postMessage(envelope('res', message.type, payload, message.id));
}
