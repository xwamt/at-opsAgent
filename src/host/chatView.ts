/**
 * atOpsAgent.chat WebviewView：
 * - CSP/nonce HTML，脚本 = dist/webview/chat.js
 * - resolve 时发送 hydrate 全量快照
 * - req 信封路由到 HostController；evt 经 StreamBatcher 合批（40ms 可配）
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { envelope, type Envelope } from '../protocol';
import type { HostController } from './hostController';
import { StreamBatcher } from './streamBatcher';
import { buildWebviewHtml } from './webviewHtml';

export const CHAT_VIEW_ID = 'atOpsAgent.chat';

function isRequestEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as Partial<Envelope>;
  return env.v === 1 && env.dir === 'req' && typeof env.type === 'string';
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private batcher: StreamBatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly controllerSub: { dispose(): void };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: HostController
  ) {
    this.controllerSub = controller.onUiEvent((env) => this.batcher?.push(env));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // ToolCallCard 等经 command:atOpsAgent.openArtifact 深链打开产物。
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media')
      ]
    };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.extensionUri,
      scriptFile: 'chat.js',
      title: 'AT Ops Agent'
    });

    this.batcher?.dispose();
    this.batcher = new StreamBatcher(
      (env) => void view.webview.postMessage(env),
      () => vscode.workspace.getConfiguration('atOpsAgent').get<number>('streaming.batchMs', 40)
    );

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message)),
      view.onDidDispose(() => {
        this.batcher?.dispose();
        this.batcher = undefined;
        this.view = undefined;
      })
    );

    this.postHydrate();
  }

  /** 主动向 webview 发送 hydrate（新会话 / 视图恢复时）。 */
  postHydrate(): void {
    if (!this.view) return;
    void this.view.webview.postMessage(
      envelope('evt', 'hydrate', this.controller.snapshot(), randomUUID())
    );
  }

  dispose(): void {
    this.controllerSub.dispose();
    this.batcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isRequestEnvelope(message)) return;
    let payload: unknown;
    try {
      payload = await this.controller.handleRequest(message.type, message.payload);
    } catch (err) {
      payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
      this.controller.log(
        `[chat] 请求 ${message.type} 处理失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // res 保序：先冲刷合批中的增量。
    this.batcher?.flush();
    void this.view?.webview.postMessage(envelope('res', message.type, payload, message.id));
  }
}
