/**
 * Webview HTML 生成：CSP + nonce，脚本来自 dist/webview/(chat|board).js。
 *
 * CSP 基线（docs/05-ui-system.md §4）：
 *   default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…' 'unsafe-inline'
 * 'unsafe-inline' 仅为 VS Code 主题变量注入所需；脚本一律 nonce。
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export type WebviewScriptFile = 'chat.js' | 'board.js';

export function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export interface BuildWebviewHtmlInput {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  scriptFile: WebviewScriptFile;
  title: string;
}

export function buildWebviewHtml(input: BuildWebviewHtmlInput): string {
  const { webview, extensionUri, scriptFile, title } = input;
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', scriptFile)
  );
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' 'unsafe-inline' ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
    html, body { height: 100%; margin: 0; padding: 0; }
    #app { height: 100%; }
    .ops-boot {
      padding: 12px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div id="app"><div class="ops-boot">AT Ops Agent 加载中…</div></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
