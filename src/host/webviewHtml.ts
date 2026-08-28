/**
 * Webview HTML 生成：CSP + nonce，脚本来自 dist/webview/(chat|board|settings).js。
 *
 * CSP 基线（docs/05-ui-system.md §4）：
 *   default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…' 'unsafe-inline'
 * 'unsafe-inline' 仅为 VS Code 主题变量注入所需；脚本一律 nonce。
 *
 * codicon 字体（P0-E）：@vscode/codicons 的 css+ttf 已 vendored 到
 * media/codicons/（ChatViewProvider / settingsView / boardView 的
 * localResourceRoots 均已包含 media/，host 侧无需新增放行；若未来改回
 * 从 node_modules 直接引用，需要 host 把 node_modules/@vscode/codicons
 * 加进 localResourceRoots）。
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export type WebviewScriptFile = 'chat.js' | 'board.js' | 'settings.js';

export function getNonce(): string {
  return randomBytes(16).toString('hex');
}

export interface BuildWebviewHtmlInput {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  scriptFile: WebviewScriptFile;
  title: string;
}

/** 'zh*' → zh-CN，其余 → en；webview i18n 启动包读 <html lang> 同款归一。 */
function htmlLang(): string {
  const raw = String(vscode.env.language ?? '').toLowerCase();
  return raw.startsWith('zh') ? 'zh-CN' : 'en';
}

/** chat 常驻侧边栏用 sideBar 背景；settings/board 是编辑器页用 editor 背景。 */
function surfaceOf(scriptFile: WebviewScriptFile): 'sidebar' | 'editor' {
  return scriptFile === 'chat.js' ? 'sidebar' : 'editor';
}

export function buildWebviewHtml(input: BuildWebviewHtmlInput): string {
  const { webview, extensionUri, scriptFile, title } = input;
  const nonce = getNonce();
  const lang = htmlLang();
  const bootText = lang === 'zh-CN' ? 'AT Ops Agent 加载中…' : 'AT Ops Agent is loading…';
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', scriptFile)
  );
  const codiconCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  );
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' 'unsafe-inline' ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${lang}" data-surface="${surfaceOf(scriptFile)}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${codiconCssUri.toString()}" />
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
  <div id="app"><div class="ops-boot">${escapeHtml(bootText)}</div></div>
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
