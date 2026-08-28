/**
 * 从 models.json / settings.json 读出聊天模型选择器需要的清单。
 * 不 import vscode：设置页保存后与 chat hydrate 共用同一解析。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ConfiguredModel {
  provider: string;
  model: string;
  label: string;
}

export interface LastModelSelection {
  provider: string;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 models.json 根对象：遍历每一个 provider 下的 models[]。 */
export function listConfiguredModelsFromJson(raw: unknown): ConfiguredModel[] {
  if (!isRecord(raw) || !isRecord(raw.providers)) return [];
  const out: ConfiguredModel[] = [];
  for (const [providerId, provider] of Object.entries(raw.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const entry of provider.models) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (id.length === 0) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      out.push({
        provider: providerId,
        model: id,
        label: name.length > 0 ? name : id
      });
    }
  }
  return out;
}

/** 读盘；文件缺失 / 坏 JSON → 空列表（聊天选择器显示「去设置添加」）。 */
export function listConfiguredModels(modelsPath: string): ConfiguredModel[] {
  try {
    return listConfiguredModelsFromJson(JSON.parse(readFileSync(modelsPath, 'utf8')));
  } catch {
    return [];
  }
}

/** settings.json 里上次选中的模型（不含凭证）。 */
export function readLastModel(agentDir: string): LastModelSelection | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    if (!isRecord(raw) || !isRecord(raw.lastModel)) return undefined;
    const provider =
      typeof raw.lastModel.provider === 'string' ? raw.lastModel.provider.trim() : '';
    const model = typeof raw.lastModel.model === 'string' ? raw.lastModel.model.trim() : '';
    if (provider.length === 0 || model.length === 0) return undefined;
    return { provider, model };
  } catch {
    return undefined;
  }
}

/** 上次选择仍在清单里则用之，否则回落到清单第一项。 */
export function pickSelectedModel(
  models: readonly ConfiguredModel[],
  preferred: LastModelSelection | undefined
): LastModelSelection | undefined {
  if (preferred && models.some((m) => m.provider === preferred.provider && m.model === preferred.model)) {
    return preferred;
  }
  const first = models[0];
  return first ? { provider: first.provider, model: first.model } : undefined;
}
