/**
 * SecretStorage 封装。LLM key 永远只进 VS Code SecretStorage，
 * models.json 用 "${secret:atOpsAgent.apiKey.<providerId>}" 占位（runtime 解析）。
 * 禁止把值写入日志 / Output Channel / LLM 上下文。
 *
 * 键布局（P0-B / P1-1 多 provider）：
 * - 新键：`atOpsAgent.apiKey.<providerId>`（按 provider 隔离）。
 * - 旧键：`atOpsAgent.llmApiKey`（单 key 时代遗留）。按 provider 读时若新键为空
 *   则回退旧键并一次性迁移（复制进新键；旧键保留给尚未迁移的其他 provider）。
 */
import type * as vscode from 'vscode';

export const LLM_API_KEY_SECRET = 'atOpsAgent.llmApiKey';

/** 按 provider 隔离的 SecretStorage 键前缀。 */
export const PROVIDER_API_KEY_PREFIX = 'atOpsAgent.apiKey.';

/** models.json 里引用 SecretStorage 键的占位符语法。 */
export const SECRET_PLACEHOLDER_RE = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

/** provider id 合法字符（占位符正则的子集，防止拼出非法占位符）。 */
export const PROVIDER_ID_RE = /^[A-Za-z0-9_.-]+$/;

/** SecretStorage 键名：atOpsAgent.apiKey.<providerId>。 */
export function providerApiKeySecret(providerId: string): string {
  return `${PROVIDER_API_KEY_PREFIX}${providerId}`;
}

/** models.json apiKey 占位符：${secret:atOpsAgent.apiKey.<providerId>}；无 provider 时回落旧键。 */
export function apiKeyPlaceholder(providerId?: string): string {
  const key =
    providerId !== undefined && providerId.length > 0
      ? providerApiKeySecret(providerId)
      : LLM_API_KEY_SECRET;
  return `\${secret:${key}}`;
}

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

  /**
   * 读 LLM key：
   * - 带 providerId：先读 `atOpsAgent.apiKey.<id>`；为空则回退旧键
   *   `atOpsAgent.llmApiKey` 并一次性迁移（复制进新键，旧键保留给其他 provider）。
   * - 不带 providerId：旧行为（读旧键），供尚未按 provider 接线的调用方使用。
   */
  async getLlmApiKey(providerId?: string): Promise<string | undefined> {
    if (providerId === undefined || providerId.length === 0) {
      return this.get(LLM_API_KEY_SECRET);
    }
    const scoped = await this.get(providerApiKeySecret(providerId));
    if (typeof scoped === 'string' && scoped.length > 0) {
      return scoped;
    }
    const legacy = await this.get(LLM_API_KEY_SECRET);
    if (typeof legacy === 'string' && legacy.length > 0) {
      await this.set(providerApiKeySecret(providerId), legacy);
      return legacy;
    }
    return undefined;
  }

  /**
   * 写 LLM key。带 providerId 时写 per-provider 键，并同步旧键：
   * 单 provider 场景下未改造的读端（no-arg getLlmApiKey / hasApiKey 标志）
   * 仍然能看到最新 key，多 provider 读端永远优先 per-provider 键。
   */
  async setLlmApiKey(value: string, providerId?: string): Promise<void> {
    if (providerId !== undefined && providerId.length > 0) {
      await this.set(providerApiKeySecret(providerId), value);
    }
    await this.set(LLM_API_KEY_SECRET, value);
  }

  async clearLlmApiKey(providerId?: string): Promise<void> {
    if (providerId !== undefined && providerId.length > 0) {
      await this.delete(providerApiKeySecret(providerId));
      return;
    }
    await this.delete(LLM_API_KEY_SECRET);
  }

  /** 解析 "${secret:<key>}" 占位；非占位字符串原样返回。 */
  async resolvePlaceholder(value: string): Promise<string | undefined> {
    const match = SECRET_PLACEHOLDER_RE.exec(value);
    if (!match) return value;
    const key = match[1];
    // per-provider 占位符享受同一套旧键回退/迁移逻辑。
    if (key.startsWith(PROVIDER_API_KEY_PREFIX)) {
      return this.getLlmApiKey(key.slice(PROVIDER_API_KEY_PREFIX.length));
    }
    return this.get(key);
  }
}
