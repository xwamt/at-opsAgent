/**
 * Models 配置的 host 侧纯逻辑（设置页 Models 页签 models/state | models/save 的实现）。
 *
 * P2-6：旧的内嵌 HTML WebviewPanel（showModelsPanel）已删除——设置页 Vue 版
 * （src/webview-settings/components/ModelsTab.vue）是唯一 UI，双份文案不再存在。
 * 本文件只保留可单测的纯函数 + 「打开 models.json」动作：
 *
 * - readModelsFormState：读 models.json / settings.json / SecretStorage 拼表单状态
 *   （只暴露 hasKey，key 本体绝不回传）。
 * - saveModelsForm：upsert 指定 provider（P1-1：payload.providerId 优先，缺省回落
 *   第一个 provider）；模型条目写 `reasoning`（pi schema），读端兼容旧 `thinking`；
 *   apiKey 字段永远写 per-provider 占位符 `${secret:atOpsAgent.apiKey.<id>}`；
 *   roleModels（per-角色模型映射）合并写 agentDir/settings.json。
 * - keyMissingWarning：P0-B「未填 key 禁止报已保存」——既无已存 key 又没填新 key
 *   时返回警告文案，调用方必须以警告态（而非绿色已保存）呈现。
 * - openModelsJson：缺文件写模板（模板同样只有占位符）并在编辑器打开。
 *
 * 除 openModelsJson 外不触碰 vscode API（type-only import），node 单测可直接 import。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { normalizeThinkingLevel, patchAgentSettings, readAgentSettings } from './agentSettings';
import type { ThinkingLevel } from './hostTypes';
import { apiKeyPlaceholder, PROVIDER_ID_RE, type OpsSecrets } from './secrets';

/** OAuth 红线说明（oauthLogin.ts 复用；定义在这里避免拉进 vscode 顶层 import）。 */
export const OAUTH_NOTE =
  'OAuth 由 pi ModelRuntime.login 驱动，凭证写入 ~/.at-series/agent/auth.json (0600)，不进 models.json';

export const DEFAULT_PROVIDER_ID = 'internal-gateway';
const DEFAULT_API = 'openai-completions';

const THINKING_FORMATS = ['deepseek', 'qwen', 'zai'] as const;
type ThinkingFormat = (typeof THINKING_FORMATS)[number];

/** per-角色模型映射的角色集合（协议 SubagentCard.role 同源）。 */
export const ROLE_MODEL_ROLES = ['investigator', 'executor', 'writer', 'verifier'] as const;
export type RoleModelRole = (typeof ROLE_MODEL_ROLES)[number];
export type RoleModelSelection = { provider: string; model: string };
export type RoleModelsMap = Partial<Record<RoleModelRole, RoleModelSelection>>;

/** models.json 缺失时「打开 models.json」写入的模板（apiKey 只有占位符；模型字段用 reasoning）。 */
export const MODELS_TEMPLATE = `{
  "providers": {
    "${DEFAULT_PROVIDER_ID}": {
      "baseUrl": "https://llm.example.internal/v1",
      "api": "${DEFAULT_API}",
      "apiKey": "${apiKeyPlaceholder(DEFAULT_PROVIDER_ID)}",
      "headers": {},
      "models": [
        { "id": "qwen3-max", "name": "Qwen3 Max", "reasoning": true }
      ]
    }
  }
}
`;

export interface ModelsFileDeps {
  modelsPath: string;
  /** ~/.at-series/agent（settings.json / auth.json 落点）。 */
  agentDir: string;
  secrets: OpsSecrets;
}

export interface ModelsFormState {
  providerId: string;
  baseUrl: string;
  /** provider.api（openai-completions / anthropic-messages…）。 */
  api: string;
  modelId: string;
  modelName: string;
  /** 模型条目的 reasoning 字段（旧文件里的 thinking 读时归一到这里）。 */
  reasoning: boolean;
  /** 只暴露「是否已存 key」（per-provider，含旧键回退），绝不回传 key 本体。 */
  hasKey: boolean;
  modelsPath: string;
  /** compat.thinkingFormat；'default' = 不写该字段。 */
  thinkingFormat: 'default' | ThinkingFormat;
  /** compat.supportsDeveloperRole；默认 true（不写该字段）。 */
  supportsDeveloperRole: boolean;
  /** agentDir/settings.json 的 thinkingLevel。 */
  thinkingLevel: ThinkingLevel;
  /** agentDir/settings.json 的 roleModels（per-角色模型映射，可空）。 */
  roleModels: RoleModelsMap;
  authPath: string;
  oauthNote: string;
}

export interface ModelsSavePayload {
  /** 目标 provider id；缺省 = 第一个已有 provider（旧行为兼容）。 */
  providerId?: unknown;
  baseUrl?: unknown;
  api?: unknown;
  modelId?: unknown;
  modelName?: unknown;
  /** 新字段名；旧调用方发 thinking 也接受。 */
  reasoning?: unknown;
  thinking?: unknown;
  apiKey?: unknown;
  thinkingFormat?: unknown;
  supportsDeveloperRole?: unknown;
  thinkingLevel?: unknown;
  /** per-角色模型映射；字段出现（哪怕空对象）即整体覆写 settings.json 的 roleModels。 */
  roleModels?: unknown;
}

export interface ModelsSaveOutcome {
  error?: string;
  /**
   * 已保存但缺 API key（既没有已存 key、本次也没填）时的警告：
   * 调用方 **不得** 以绿色「已保存」呈现，必须显示该警告（P0-B）。
   */
  warning?: string;
  applied?: { provider: string; model: string; thinkingLevel: ThinkingLevel };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeThinkingFormat(value: unknown): 'default' | ThinkingFormat {
  return typeof value === 'string' && (THINKING_FORMATS as readonly string[]).includes(value)
    ? (value as ThinkingFormat)
    : 'default';
}

/** payload.roleModels → 只保留 4 个已知角色、provider 与 model 都非空的条目。 */
export function normalizeRoleModels(raw: unknown): RoleModelsMap {
  if (!isRecord(raw)) return {};
  const out: RoleModelsMap = {};
  for (const role of ROLE_MODEL_ROLES) {
    const entry = raw[role];
    if (!isRecord(entry)) continue;
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (provider.length > 0 && model.length > 0) {
      out[role] = { provider, model };
    }
  }
  return out;
}

/**
 * P0-B：用户没有已存 key、又没填新 key ⇒ 返回警告文案（表单已落盘，但问答会失败）。
 * 返回 undefined = 无需警告。OAuth 型 provider（凭证在 auth.json）由调用方自行豁免。
 */
export function keyMissingWarning(hasStoredKey: boolean, apiKeyInput: string): string | undefined {
  if (hasStoredKey || apiKeyInput.trim().length > 0) return undefined;
  return '尚未填写 API Key，问答将失败。粘贴 Key 后再次保存，或改用 OAuth 登录。';
}

/**
 * 读指定 provider（缺省第一个）的现值预填表单；文件缺失/坏 JSON → 空表单。
 * 模型条目 reasoning 兼容旧 thinking；hasKey 按 per-provider 键（含旧键回退迁移）。
 */
export async function readModelsFormState(
  deps: ModelsFileDeps,
  preferredProviderId?: string
): Promise<ModelsFormState> {
  const agentSettings = await readAgentSettings(deps.agentDir);
  const state: ModelsFormState = {
    providerId: DEFAULT_PROVIDER_ID,
    baseUrl: '',
    api: DEFAULT_API,
    modelId: '',
    modelName: '',
    reasoning: false,
    hasKey: false,
    modelsPath: deps.modelsPath,
    thinkingFormat: 'default',
    supportsDeveloperRole: true,
    thinkingLevel: normalizeThinkingLevel(agentSettings.thinkingLevel) ?? 'medium',
    roleModels: normalizeRoleModels(agentSettings.roleModels),
    authPath: path.join(deps.agentDir, 'auth.json'),
    oauthNote: OAUTH_NOTE
  };

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(deps.modelsPath, 'utf8'));
  } catch {
    state.hasKey = ((await deps.secrets.getLlmApiKey(state.providerId)) ?? '').length > 0;
    return state;
  }
  const providers = isRecord(raw) && isRecord(raw.providers) ? raw.providers : undefined;
  if (!providers) {
    state.hasKey = ((await deps.secrets.getLlmApiKey(state.providerId)) ?? '').length > 0;
    return state;
  }
  const keys = Object.keys(providers);
  const providerId =
    preferredProviderId !== undefined && keys.includes(preferredProviderId)
      ? preferredProviderId
      : keys[0];
  const provider = providerId !== undefined ? providers[providerId] : undefined;
  if (providerId === undefined || !isRecord(provider)) {
    state.hasKey = ((await deps.secrets.getLlmApiKey(state.providerId)) ?? '').length > 0;
    return state;
  }
  state.providerId = providerId;
  if (typeof provider.baseUrl === 'string') state.baseUrl = provider.baseUrl;
  if (typeof provider.api === 'string' && provider.api.length > 0) state.api = provider.api;
  const model = Array.isArray(provider.models) ? provider.models.find(isRecord) : undefined;
  if (model) {
    if (typeof model.id === 'string') state.modelId = model.id;
    if (typeof model.name === 'string') state.modelName = model.name;
    // 新字段 reasoning 优先；旧文件的 thinking 读时兼容。
    state.reasoning = model.reasoning === true || model.thinking === true;
  }
  if (isRecord(provider.compat)) {
    state.thinkingFormat = normalizeThinkingFormat(provider.compat.thinkingFormat);
    state.supportsDeveloperRole = provider.compat.supportsDeveloperRole !== false;
  }
  state.hasKey = ((await deps.secrets.getLlmApiKey(providerId)) ?? '').length > 0;
  return state;
}

/**
 * 保存：upsert payload.providerId 指定的 provider（缺省回落第一个已有 provider，
 * 再缺省 internal-gateway；其余 provider / 字段原样保留）。
 * - 模型条目写 `reasoning`（并清掉旧 `thinking` 键）。
 * - apiKey 字段永远写 per-provider 占位符；用户填了 key 才更新 SecretStorage。
 * - compat 只管理 thinkingFormat / supportsDeveloperRole 两个键（默认值删除、未知键保留）。
 * - thinkingLevel / roleModels 合并写 agentDir/settings.json。
 * - 既无已存 key 又没填新 key ⇒ outcome.warning（保存成功但不许报绿色已保存）。
 */
export async function saveModelsForm(
  deps: ModelsFileDeps,
  payload: ModelsSavePayload
): Promise<ModelsSaveOutcome> {
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
  const modelName = typeof payload.modelName === 'string' ? payload.modelName.trim() : '';
  const reasoning = payload.reasoning === true || payload.thinking === true;
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const api = typeof payload.api === 'string' ? payload.api.trim() : '';
  const thinkingFormat = normalizeThinkingFormat(payload.thinkingFormat);
  const supportsDeveloperRole = payload.supportsDeveloperRole !== false;
  const thinkingLevel = normalizeThinkingLevel(payload.thinkingLevel) ?? 'medium';
  const requestedProviderId =
    typeof payload.providerId === 'string' ? payload.providerId.trim() : '';
  if (baseUrl.length === 0 || modelId.length === 0) {
    return { error: 'Base URL 与模型 ID 不能为空。' };
  }
  if (requestedProviderId.length > 0 && !PROVIDER_ID_RE.test(requestedProviderId)) {
    return { error: `Provider id 只允许字母数字与 . _ -（收到 "${requestedProviderId}"）。` };
  }

  let root: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await fs.readFile(deps.modelsPath, 'utf8'));
    if (isRecord(raw)) root = raw;
  } catch {
    // 文件不存在或坏 JSON：从空配置开始（坏文件由「打开 models.json」人工处理）。
  }
  const providers = isRecord(root.providers) ? { ...root.providers } : {};
  const providerId =
    requestedProviderId.length > 0
      ? requestedProviderId
      : (Object.keys(providers)[0] ?? DEFAULT_PROVIDER_ID);
  const existing = isRecord(providers[providerId])
    ? (providers[providerId] as Record<string, unknown>)
    : {};

  const models = (Array.isArray(existing.models) ? existing.models : []).filter(isRecord);
  const entry: Record<string, unknown> = { id: modelId, reasoning };
  if (modelName.length > 0) entry.name = modelName;
  const idx = models.findIndex((m) => m.id === modelId);
  if (idx >= 0) {
    const merged = { ...models[idx], ...entry };
    delete merged.thinking; // 旧字段名迁移：写端只留 reasoning
    models[idx] = merged;
  } else {
    models.push(entry);
  }

  const compat = isRecord(existing.compat) ? { ...existing.compat } : {};
  if (thinkingFormat === 'default') delete compat.thinkingFormat;
  else compat.thinkingFormat = thinkingFormat;
  if (supportsDeveloperRole) delete compat.supportsDeveloperRole;
  else compat.supportsDeveloperRole = false;

  const provider: Record<string, unknown> = {
    ...existing,
    baseUrl,
    api: api.length > 0 ? api : typeof existing.api === 'string' ? existing.api : DEFAULT_API,
    apiKey: apiKeyPlaceholder(providerId),
    models
  };
  if (Object.keys(compat).length > 0) provider.compat = compat;
  else delete provider.compat;

  let warning: string | undefined;
  try {
    // 迁移副作用在写盘前触发：旧键有值时复制进 per-provider 键。
    const storedKey = (await deps.secrets.getLlmApiKey(providerId)) ?? '';
    warning = keyMissingWarning(storedKey.length > 0, apiKey);

    await fs.mkdir(path.dirname(deps.modelsPath), { recursive: true });
    await fs.writeFile(
      deps.modelsPath,
      `${JSON.stringify({ ...root, providers: { ...providers, [providerId]: provider } }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    const settingsPatch: Record<string, unknown> = { thinkingLevel };
    if (isRecord(payload.roleModels)) {
      settingsPatch.roleModels = normalizeRoleModels(payload.roleModels);
    }
    await patchAgentSettings(deps.agentDir, settingsPatch);
    if (apiKey.length > 0) {
      await deps.secrets.setLlmApiKey(apiKey, providerId);
    }
  } catch (err) {
    return { error: `保存失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    applied: { provider: providerId, model: modelId, thinkingLevel },
    ...(warning !== undefined ? { warning } : {})
  };
}

/** 次级动作：确保 models.json 存在（缺失写模板）并在编辑器打开。 */
export async function openModelsJson(deps: {
  modelsPath: string;
  output: vscode.OutputChannel;
}): Promise<void> {
  const { modelsPath, output } = deps;
  // vscode 仅此处需要：延迟 require（esbuild external），保持本模块 node 可直接 import。
  const vscodeApi = await import('vscode');
  try {
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    try {
      await fs.access(modelsPath);
    } catch {
      await fs.writeFile(modelsPath, MODELS_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
      output.appendLine(`[models] 已创建模板 ${modelsPath}（apiKey 使用 SecretStorage 占位符）`);
    }
    const doc = await vscodeApi.workspace.openTextDocument(vscodeApi.Uri.file(modelsPath));
    await vscodeApi.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    void vscodeApi.window.showErrorMessage(
      `打开 models.json 失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
