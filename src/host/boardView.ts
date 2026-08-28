/**
 * Ops 看板（atOpsAgent.openBoard 打开的编辑器区 WebviewPanel，单例）：
 * 脚本 = dist/webview/board.js；hydrate 发送时间线快照，此后 timeline/upsert 直发。
 * 视图收敛后不再作为 WebviewView 常驻底部面板——按需以编辑器页打开
 * （retainContextWhenHidden 保持切页后的滚动位置等状态）。
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { envelope, type Envelope } from '../protocol';
import type { HostController } from './hostController';
import { buildWebviewHtml } from './webviewHtml';

export interface BoardPanelDeps {
  extensionUri: vscode.Uri;
  controller: HostController;
}

function isRequestEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as Partial<Envelope>;
  return env.v === 1 && env.dir === 'req' && typeof env.type === 'string';
}

let currentPanel: vscode.WebviewPanel | undefined;

function boardTitle(): string {
  return vscode.env.language.toLowerCase().startsWith('zh') ? 'Ops 看板' : 'Ops Board';
}

/** 打开（或聚焦）Ops 看板编辑器页；单例。 */
export function showBoardPanel(deps: BoardPanelDeps): void {
  const { extensionUri, controller } = deps;
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'atOpsAgent.boardPanel',
    boardTitle(),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // 看板卡片可经 command: 深链打开产物 / 日志。
      enableCommandUris: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(extensionUri, 'media')
      ]
    }
  );
  currentPanel = panel;
  panel.webview.html = buildWebviewHtml({
    webview: panel.webview,
    extensionUri,
    scriptFile: 'board.js',
    title: boardTitle()
  });

  const hydratePayload = (): { sessionId: string; events: unknown[] } => ({
    sessionId: controller.store.activeSessionId,
    events: [...controller.store.timeline]
  });

  const eventSub = controller.onBoardEvent((env) => {
    void panel.webview.postMessage(env);
  });
  const messageSub = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (!isRequestEnvelope(message)) return;
    if (message.type === 'hydrate') {
      void panel.webview.postMessage(envelope('res', 'hydrate', hydratePayload(), message.id));
    }
  });
  panel.onDidDispose(() => {
    eventSub.dispose();
    messageSub.dispose();
    if (currentPanel === panel) currentPanel = undefined;
  });

  void panel.webview.postMessage(envelope('evt', 'hydrate', hydratePayload(), randomUUID()));
}
