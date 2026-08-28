/**
 * atOpsAgent.incidentBoard WebviewView（Panel）：
 * 脚本 = dist/webview/board.js；hydrate 发送时间线快照，此后 timeline/upsert 直发。
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { envelope, type Envelope } from '../protocol';
import type { HostController } from './hostController';
import { buildWebviewHtml } from './webviewHtml';

export const BOARD_VIEW_ID = 'atOpsAgent.incidentBoard';

function isRequestEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as Partial<Envelope>;
  return env.v === 1 && env.dir === 'req' && typeof env.type === 'string';
}

export class BoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly controllerSub: { dispose(): void };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: HostController
  ) {
    this.controllerSub = controller.onBoardEvent((env) => {
      void this.view?.webview.postMessage(env);
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // 看板卡片同样可经 command: 深链打开产物 / 日志。
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media')
      ]
    };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.extensionUri,
      scriptFile: 'board.js',
      title: 'Ops Board'
    });

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isRequestEnvelope(message)) return;
        if (message.type === 'hydrate') {
          void view.webview.postMessage(
            envelope('res', 'hydrate', this.hydratePayload(), message.id)
          );
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      })
    );

    void view.webview.postMessage(envelope('evt', 'hydrate', this.hydratePayload(), randomUUID()));
  }

  dispose(): void {
    this.controllerSub.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private hydratePayload(): { sessionId: string; events: unknown[] } {
    return {
      sessionId: this.controller.store.activeSessionId,
      events: [...this.controller.store.timeline]
    };
  }
}
