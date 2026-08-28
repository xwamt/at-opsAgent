/**
 * OAuth 登录（Models 面板 OAuth 页专用）。
 *
 * 优先走 runtime.loginOAuth（HostController 侧尝试）；runtime 缺席或不支持时，
 * host 在这里直接动态 import pi（仅此场景允许）驱动 ModelRuntime.login：
 * 交互经 vscode InputBox / QuickPick / openExternal 完成，凭证由 pi 的
 * AuthStorage 落盘 ~/.at-series/agent/auth.json（0600）。
 * 红线：token / 授权 URL 一律不写日志、不回传 webview、不进 models.json。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';

export const OAUTH_NOTE =
  'OAuth 由 pi ModelRuntime.login 驱动，凭证写入 ~/.at-series/agent/auth.json (0600)，不进 models.json';

export interface OAuthLoginInput {
  providerId: string;
  agentDir: string;
  log: (message: string) => void;
}

export interface OAuthLoginResult {
  ok: boolean;
  /** 面向用户的中文说明；绝不包含 token。 */
  message: string;
}

/** host 直驱 pi 的 OAuth 登录；任何失败都不抛出，转为带说明的结果。 */
export async function loginOAuthViaPi(input: OAuthLoginInput): Promise<OAuthLoginResult> {
  const authPath = path.join(input.agentDir, 'auth.json');
  try {
    // pi 是 ESM-only：与 src/runtime 相同的动态 import 模式（CJS 打包兼容）。
    const pi = await import('@earendil-works/pi-coding-agent');
    const modelRuntime = await pi.ModelRuntime.create({
      authPath,
      modelsPath: path.join(input.agentDir, 'models.json'),
      modelsStorePath: path.join(input.agentDir, 'models-store.json')
    });
    // 返回的 Credential（token 本体）刻意不接收进变量，避免误用/误记。
    await modelRuntime.login(input.providerId, 'oauth', buildVsCodeAuthInteraction(input.log));
    await ensureFileMode(authPath, 0o600);
    return {
      ok: true,
      message: `OAuth 登录成功（${input.providerId}）。${OAUTH_NOTE}`
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    input.log(`[oauth] ${input.providerId} 登录未完成: ${reason}`);
    // 登录未完成也保证 auth.json 以 0600 存在，方便用户人工处理。
    await ensureAuthJson(authPath).catch(() => {});
    return { ok: false, message: `${OAUTH_NOTE}。本次登录未完成：${reason}` };
  }
}

/** 确保 auth.json 存在（0600）并在编辑器打开（login API 不可用时的兜底路径）。 */
export async function openAuthJson(agentDir: string): Promise<void> {
  const authPath = path.join(agentDir, 'auth.json');
  try {
    await ensureAuthJson(authPath);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(authPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    void vscode.window.showErrorMessage(
      `打开 auth.json 失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** pi 登录交互 → vscode UI。prompt 取消即抛错中止整个流程。 */
function buildVsCodeAuthInteraction(log: (message: string) => void): AuthInteraction {
  return {
    async prompt(p: AuthPrompt): Promise<string> {
      if (p.type === 'select') {
        const picked = await vscode.window.showQuickPick(
          p.options.map((o) => ({ label: o.label, description: o.description, id: o.id })),
          { placeHolder: p.message, ignoreFocusOut: true }
        );
        if (!picked) throw new Error('用户取消了 OAuth 登录');
        return picked.id;
      }
      const value = await vscode.window.showInputBox({
        prompt: p.message,
        placeHolder: p.placeholder,
        password: p.type === 'secret',
        ignoreFocusOut: true
      });
      if (value === undefined) throw new Error('用户取消了 OAuth 登录');
      return value;
    },
    notify(event: AuthEvent): void {
      switch (event.type) {
        case 'auth_url':
          // URL 可能携带一次性授权参数：只打开，不写日志。
          void vscode.env.openExternal(vscode.Uri.parse(event.url)).then(undefined, () => {});
          void vscode.window.showInformationMessage(
            event.instructions ?? '已在浏览器打开 OAuth 授权页，请完成登录后回到 VS Code。'
          );
          break;
        case 'device_code':
          void vscode.env
            .openExternal(vscode.Uri.parse(event.verificationUri))
            .then(undefined, () => {});
          void vscode.window.showInformationMessage(
            `请在浏览器打开 ${event.verificationUri} 并输入代码 ${event.userCode}`
          );
          break;
        case 'info':
        case 'progress':
          // 说明/进度文案不含凭证，可进 Output Channel。
          log(`[oauth] ${event.message}`);
          break;
        default:
          break;
      }
    }
  };
}

async function ensureAuthJson(authPath: string): Promise<void> {
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  try {
    await fs.access(authPath);
  } catch {
    await fs.writeFile(authPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
  }
  await ensureFileMode(authPath, 0o600);
}

async function ensureFileMode(file: string, mode: number): Promise<void> {
  try {
    await fs.chmod(file, mode);
  } catch {
    // 无 POSIX 权限语义的平台（Windows）忽略。
  }
}
