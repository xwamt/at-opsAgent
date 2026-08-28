/**
 * SecretStorage 封装。LLM key 永远只进 VS Code SecretStorage，
 * models.json 用 "${secret:atOpsAgent.llmApiKey}" 占位（runtime 解析）。
 * 禁止把值写入日志 / Output Channel / LLM 上下文。
 */
import type * as vscode from 'vscode';

export const LLM_API_KEY_SECRET = 'atOpsAgent.llmApiKey';

/** models.json 里引用 SecretStorage 键的占位符语法。 */
export const SECRET_PLACEHOLDER_RE = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

export class OpsSecrets {
  constructor(private readonly storage: vscode.SecretStorage) {}

  get(key: string): Thenable<string | undefined> {
    return this.storage.get(key);
  }

  set(key: string, value: string): Thenable<void> {
    return this.storage.store(key, value);
  }

  delete(key: string): Thenable<void> {
    return this.storage.delete(key);
  }

  getLlmApiKey(): Thenable<string | undefined> {
    return this.get(LLM_API_KEY_SECRET);
  }

  setLlmApiKey(value: string): Thenable<void> {
    return this.set(LLM_API_KEY_SECRET, value);
  }

  clearLlmApiKey(): Thenable<void> {
    return this.delete(LLM_API_KEY_SECRET);
  }

  /** 解析 "${secret:<key>}" 占位；非占位字符串原样返回。 */
  async resolvePlaceholder(value: string): Promise<string | undefined> {
    const match = SECRET_PLACEHOLDER_RE.exec(value);
    if (!match) return value;
    return this.get(match[1]);
  }
}
