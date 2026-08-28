/**
 * webview-settings 纯 TS helper：页签清单、配置 diff、密钥打码/还原、
 * mcp.json 解析、models 保存载荷、hydrate 快照归一化。
 *
 * 约束：不引 DOM / vue / vscode（root tsconfig 无 DOM lib，node 单测直接 import；
 * host 侧 settingsView 也可以复用 restoreRedactedSecrets 等纯函数）。
 */

// ── 页签（Roo Code 式左侧竖排导航；宽度 <420px 折为顶部横排） ──────────────

export type SettingsTabId =
  | 'general'
  | 'models'
  | 'capabilities'
  | 'mcp'
  | 'skills'
  | 'sessions';

export interface SettingsTabMeta {
  id: SettingsTabId;
  /** settings i18n 键（zh-CN / en 双语）。 */
  labelKey:
    | 'navGeneral'
    | 'navModels'
    | 'navCapabilities'
    | 'navMcp'
    | 'navSkills'
    | 'navSessions';
}

export const SETTINGS_TABS: readonly SettingsTabMeta[] = [
  { id: 'general', labelKey: 'navGeneral' },
  { id: 'models', labelKey: 'navModels' },
  { id: 'capabilities', labelKey: 'navCapabilities' },
  { id: 'mcp', labelKey: 'navMcp' },
  { id: 'skills', labelKey: 'navSkills' },
  { id: 'sessions', labelKey: 'navSessions' }
] as const;

export function normalizeTabId(raw: unknown): SettingsTabId {
  const value = String(raw ?? '');
  return SETTINGS_TABS.some((tab) => tab.id === value) ? (value as SettingsTabId) : 'general';
}

// ── 常规配置（package.json contributes.configuration atOpsAgent.*） ────────

export type DiscoveryMode = 'auto' | 'always' | 'off';
export type SessionApprovalScope = 'write-exec' | 'exec-only' | 'never';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
];

export interface OpsConfig {
  'discovery.mode': DiscoveryMode;
  'discovery.threshold': number;
  'plugins.autoEnableNew': boolean;
  'approval.sessionRequiredFor': SessionApprovalScope;
  'approval.dedupePluginModal': boolean;
  'models.defaultThinkingLevel': ThinkingLevel;
  'models.toolCallPromptFallback': boolean;
  'workspaceShell.enabled': boolean;
  'subagent.maxParallel': number;
  'streaming.batchMs': number;
}

export const CONFIG_DEFAULTS: OpsConfig = {
  'discovery.mode': 'auto',
  'discovery.threshold': 20,
  'plugins.autoEnableNew': true,
  'approval.sessionRequiredFor': 'write-exec',
  'approval.dedupePluginModal': false,
  'models.defaultThinkingLevel': 'medium',
  'models.toolCallPromptFallback': true,
  'workspaceShell.enabled': false,
  'subagent.maxParallel': 3,
  'streaming.batchMs': 40
};

export type ConfigKey = keyof OpsConfig;

export interface ConfigFieldMeta {
  key: ConfigKey;
  kind: 'enum' | 'boolean' | 'number';
  options?: readonly string[];
  min?: number;
  max?: number;
  labelKey: string;
  descKey: string;
}

/** GeneralTab 渲染顺序即此清单顺序。 */
export const CONFIG_FIELDS: readonly ConfigFieldMeta[] = [
  {
    key: 'discovery.mode',
    kind: 'enum',
    options: ['auto', 'always', 'off'],
    labelKey: 'cfgDiscoveryMode',
    descKey: 'cfgDiscoveryModeDesc'
  },
  {
    key: 'discovery.threshold',
    kind: 'number',
    min: 1,
    labelKey: 'cfgDiscoveryThreshold',
    descKey: 'cfgDiscoveryThresholdDesc'
  },
  {
    key: 'plugins.autoEnableNew',
    kind: 'boolean',
    labelKey: 'cfgAutoEnableNew',
    descKey: 'cfgAutoEnableNewDesc'
  },
  {
    key: 'approval.sessionRequiredFor',
    kind: 'enum',
    options: ['write-exec', 'exec-only', 'never'],
    labelKey: 'cfgSessionRequiredFor',
    descKey: 'cfgSessionRequiredForDesc'
  },
  {
    key: 'approval.dedupePluginModal',
    kind: 'boolean',
    labelKey: 'cfgDedupePluginModal',
    descKey: 'cfgDedupePluginModalDesc'
  },
  {
    key: 'models.defaultThinkingLevel',
    kind: 'enum',
    options: THINKING_LEVELS,
    labelKey: 'cfgDefaultThinkingLevel',
    descKey: 'cfgDefaultThinkingLevelDesc'
  },
  {
    key: 'models.toolCallPromptFallback',
    kind: 'boolean',
    labelKey: 'cfgToolCallPromptFallback',
    descKey: 'cfgToolCallPromptFallbackDesc'
  },
  {
    key: 'workspaceShell.enabled',
    kind: 'boolean',
    labelKey: 'cfgWorkspaceShell',
    descKey: 'cfgWorkspaceShellDesc'
  },
  {
    key: 'subagent.maxParallel',
    kind: 'number',
    min: 1,
    max: 4,
    labelKey: 'cfgSubagentMaxParallel',
    descKey: 'cfgSubagentMaxParallelDesc'
  },
  {
    key: 'streaming.batchMs',
    kind: 'number',
    min: 0,
    labelKey: 'cfgStreamingBatchMs',
    descKey: 'cfgStreamingBatchMsDesc'
  }
] as const;

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

/** 兼容三种下发形状：平铺 key、带 atOpsAgent. 前缀、嵌套 { discovery: { mode } }。 */
function lookupConfigValue(rec: AnyRecord, key: string): unknown {
  if (rec[key] !== undefined) {
    return rec[key];
  }
  const prefixed = rec[`atOpsAgent.${key}`];
  if (prefixed !== undefined) {
    return prefixed;
  }
  const dot = key.indexOf('.');
  if (dot > 0) {
    return asRecord(rec[key.slice(0, dot)])[key.slice(dot + 1)];
  }
  return undefined;
}

function toEnum<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toNum(value: unknown, fallback: number, min?: number, max?: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) {
    return fallback;
  }
  let out = num;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

export function normalizeConfig(raw: unknown): OpsConfig {
  const rec = asRecord(raw);
  const get = (key: ConfigKey): unknown => lookupConfigValue(rec, key);
  return {
    'discovery.mode': toEnum(get('discovery.mode'), ['auto', 'always', 'off'], 'auto'),
    'discovery.threshold': toNum(get('discovery.threshold'), CONFIG_DEFAULTS['discovery.threshold'], 1),
    'plugins.autoEnableNew': toBool(get('plugins.autoEnableNew'), true),
    'approval.sessionRequiredFor': toEnum(
      get('approval.sessionRequiredFor'),
      ['write-exec', 'exec-only', 'never'],
      'write-exec'
    ),
    'approval.dedupePluginModal': toBool(get('approval.dedupePluginModal'), false),
    'models.defaultThinkingLevel': toEnum(get('models.defaultThinkingLevel'), THINKING_LEVELS, 'medium'),
    'models.toolCallPromptFallback': toBool(get('models.toolCallPromptFallback'), true),
    'workspaceShell.enabled': toBool(get('workspaceShell.enabled'), false),
    'subagent.maxParallel': toNum(get('subagent.maxParallel'), CONFIG_DEFAULTS['subagent.maxParallel'], 1, 4),
    'streaming.batchMs': toNum(get('streaming.batchMs'), CONFIG_DEFAULTS['streaming.batchMs'], 0)
  };
}

/**
 * 配置 diff：只保留改动键。无改动返回 null（保存按钮置灰依据）。
 */
export function buildConfigPatch(saved: OpsConfig, edited: OpsConfig): Partial<OpsConfig> | null {
  const patch: AnyRecord = {};
  for (const field of CONFIG_FIELDS) {
    if (saved[field.key] !== edited[field.key]) {
      patch[field.key] = edited[field.key];
    }
  }
  return Object.keys(patch).length > 0 ? (patch as Partial<OpsConfig>) : null;
}

/**
 * settings/patchConfig 请求序列：host 侧契约是单键 { key, value }
 * （SettingsPatchConfigReq，白名单校验），改了几个键就发几个 req。
 */
export function buildConfigPatchRequests(
  saved: OpsConfig,
  edited: OpsConfig
): Array<{ key: ConfigKey; value: unknown }> {
  const patch = buildConfigPatch(saved, edited);
  if (!patch) {
    return [];
  }
  return (Object.keys(patch) as ConfigKey[]).map((key) => ({ key, value: patch[key] }));
}

// ── 密钥打码（mcp.json 等下行内容） ────────────────────────────────────────

export const REDACTED = '***';

const SECRET_KEY_RE =
  /(token|secret|password|passwd|api[-_]?key|apikey|authorization|credential|cookie)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** 深度打码：命中密钥键名的字符串值替换为 ***（其余原样，含 command/args）。 */
export function redactSecretsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsDeep(entry));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const out: AnyRecord = {};
  for (const [key, val] of Object.entries(value as AnyRecord)) {
    if (isSecretKey(key) && typeof val === 'string' && val.length > 0) {
      out[key] = REDACTED;
    } else {
      out[key] = redactSecretsDeep(val);
    }
  }
  return out;
}

/** 整段 JSON 文本打码；解析失败返回 null（调用方决定是否原样展示）。 */
export function redactMcpText(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return `${JSON.stringify(redactSecretsDeep(parsed), null, 2)}\n`;
  } catch {
    return null;
  }
}

/**
 * 保存前还原：编辑稿里保持 *** 的字符串，从原始（未打码）JSON 同路径取回旧值；
 * 原路径没有旧值时保留 ***（host 侧兜底）。空 password 语义：保持 *** 即维持原值。
 */
export function restoreRedactedSecrets(edited: unknown, original: unknown): unknown {
  if (typeof edited === 'string') {
    return edited === REDACTED && typeof original === 'string' ? original : edited;
  }
  if (Array.isArray(edited)) {
    const origArr = Array.isArray(original) ? original : [];
    return edited.map((entry, i) => restoreRedactedSecrets(entry, origArr[i]));
  }
  if (typeof edited !== 'object' || edited === null) {
    return edited;
  }
  const origRec = asRecord(original);
  const out: AnyRecord = {};
  for (const [key, val] of Object.entries(edited as AnyRecord)) {
    out[key] = restoreRedactedSecrets(val, origRec[key]);
  }
  return out;
}

// ── mcp.json 解析（servers / mcpServers；AT Series hub 条目提示跳过） ──────

export interface McpParseResult {
  ok: boolean;
  error?: string;
  serverNames: string[];
  /** 命中 AT Series 去重规则（内置 HubHost 覆盖，保存后不会被拉起）。 */
  skippedAtSeries: string[];
}

/** 与 src/mcp-client/atSeriesDedup 同规则的本地实现（webview 不打包 node 依赖）。 */
function isAtSeriesHubEntry(name: string, entry: AnyRecord): boolean {
  if (name.trim().toLowerCase() === 'at series') {
    return true;
  }
  const candidates: string[] = [];
  if (typeof entry.command === 'string') candidates.push(entry.command);
  if (Array.isArray(entry.args)) {
    for (const arg of entry.args) {
      if (typeof arg === 'string') candidates.push(arg);
    }
  }
  return candidates.some((raw) => raw.replace(/\\/g, '/').includes('.at-series/mcp/hub.js'));
}

export function parseMcpConfig(text: string): McpParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, serverNames: [], skippedAtSeries: [] };
  }
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      serverNames: [],
      skippedAtSeries: []
    };
  }
  const rec = asRecord(root);
  const source = rec.servers ?? rec.mcpServers;
  const serverNames: string[] = [];
  const skippedAtSeries: string[] = [];
  const inspect = (name: string, entry: AnyRecord): void => {
    serverNames.push(name);
    if (isAtSeriesHubEntry(name, entry)) {
      skippedAtSeries.push(name);
    }
  };
  if (Array.isArray(source)) {
    source.forEach((entry, i) => {
      const e = asRecord(entry);
      inspect(String(e.name ?? `server-${i}`), e);
    });
  } else {
    for (const [name, entry] of Object.entries(asRecord(source))) {
      inspect(name, asRecord(entry));
    }
  }
  return { ok: true, serverNames, skippedAtSeries };
}

// ── Models 表单（对齐 src/host/modelsView.ts 的 ModelsFormState / SavePayload） ──

export const THINKING_FORMATS = ['default', 'deepseek', 'qwen', 'zai'] as const;
export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

export interface ModelsForm {
  providerId: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
  thinking: boolean;
  /** host 只下发「是否已存 key」；key 本体绝不回显。 */
  hasKey: boolean;
  modelsPath: string;
  authPath: string;
  oauthNote: string;
  thinkingFormat: ThinkingFormat;
  supportsDeveloperRole: boolean;
  thinkingLevel: ThinkingLevel;
  /** 仅上行字段：'' = 保持现有 key；发送后立即清空。 */
  apiKey: string;
  /** OAuth 页输入（默认取 providerId）。 */
  oauthProvider: string;
}

export function emptyModelsForm(): ModelsForm {
  return {
    providerId: '',
    baseUrl: '',
    modelId: '',
    modelName: '',
    thinking: false,
    hasKey: false,
    modelsPath: '',
    authPath: '',
    oauthNote: '',
    thinkingFormat: 'default',
    supportsDeveloperRole: true,
    thinkingLevel: 'medium',
    apiKey: '',
    oauthProvider: ''
  };
}

/**
 * models/state 载荷归一：apiKey 无论 host 发什么都强制置空（永不回显）；
 * previous 提供时保留用户已输入的 oauthProvider。
 */
export function normalizeModelsState(raw: unknown, previous?: ModelsForm): ModelsForm {
  const rec = asRecord(raw);
  const providerId = typeof rec.providerId === 'string' ? rec.providerId : '';
  return {
    providerId,
    baseUrl: typeof rec.baseUrl === 'string' ? rec.baseUrl : '',
    modelId: typeof rec.modelId === 'string' ? rec.modelId : '',
    modelName: typeof rec.modelName === 'string' ? rec.modelName : '',
    thinking: rec.thinking === true,
    hasKey: rec.hasKey === true,
    modelsPath: typeof rec.modelsPath === 'string' ? rec.modelsPath : '',
    authPath: typeof rec.authPath === 'string' ? rec.authPath : '',
    oauthNote: typeof rec.oauthNote === 'string' ? rec.oauthNote : '',
    thinkingFormat: toEnum(rec.thinkingFormat, THINKING_FORMATS, 'default'),
    supportsDeveloperRole: rec.supportsDeveloperRole !== false,
    thinkingLevel: toEnum(rec.thinkingLevel, THINKING_LEVELS, 'medium'),
    apiKey: '',
    oauthProvider: previous?.oauthProvider ? previous.oauthProvider : providerId
  };
}

export type ModelsSaveResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: 'required' };

/**
 * models/save 载荷：对齐 modelsView SavePayload。apiKey 为空时整键省略
 * （host 语义：留空 = 保持现有 key），任何情况下都不包含 hasKey / 路径字段。
 */
export function buildModelsSavePayload(form: ModelsForm): ModelsSaveResult {
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  if (baseUrl.length === 0 || modelId.length === 0) {
    return { ok: false, error: 'required' };
  }
  const payload: Record<string, unknown> = {
    baseUrl,
    modelId,
    modelName: form.modelName.trim(),
    thinking: form.thinking === true,
    thinkingLevel: toEnum(form.thinkingLevel, THINKING_LEVELS, 'medium'),
    thinkingFormat: toEnum(form.thinkingFormat, THINKING_FORMATS, 'default'),
    supportsDeveloperRole: form.supportsDeveloperRole !== false
  };
  const apiKey = form.apiKey.trim();
  if (apiKey.length > 0) {
    payload.apiKey = apiKey;
  }
  return { ok: true, payload };
}

// ── hydrate 快照归一（settings/hydrate 或 hydrate 兜底） ───────────────────

export interface ProviderRow {
  pluginId: string;
  displayName: string;
  healthy: boolean;
  toolCount: number;
  bridgeCount: number;
}

export function normalizeProviders(raw: unknown): ProviderRow[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(asRecord(raw).providers)
      ? (asRecord(raw).providers as unknown[])
      : [];
  return list.map((entry, i) => {
    const rec = asRecord(entry);
    const pluginId = String(rec.pluginId ?? rec.id ?? `provider-${i}`);
    const toolCount =
      typeof rec.toolCount === 'number'
        ? rec.toolCount
        : Array.isArray(rec.toolNames)
          ? rec.toolNames.length
          : Array.isArray(rec.tools)
            ? rec.tools.length
            : 0;
    return {
      pluginId,
      displayName: String(rec.displayName ?? rec.label ?? rec.name ?? pluginId),
      healthy:
        typeof rec.healthy === 'boolean'
          ? rec.healthy
          : rec.connected !== false && rec.ok !== false && rec.state !== 'error',
      toolCount,
      bridgeCount: typeof rec.bridgeCount === 'number' ? rec.bridgeCount : 0
    };
  });
}

export interface SkillRow {
  name: string;
  description?: string;
  path?: string;
}

/** 接受 host SkillInfo（label/skillFile）与通用 {name, path} 两种形状。 */
export function normalizeSkills(raw: unknown): SkillRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SkillRow[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ name: entry });
      continue;
    }
    const rec = asRecord(entry);
    const name = String(rec.name ?? rec.label ?? '');
    if (!name) {
      continue;
    }
    const path = rec.path ?? rec.skillFile;
    out.push({
      name,
      description: typeof rec.description === 'string' ? rec.description : undefined,
      path: typeof path === 'string' ? path : undefined
    });
  }
  return out;
}

export interface SessionRow {
  id: string;
  title: string;
  updatedAt?: number;
  active: boolean;
}

/** 接受 host SessionSummary（id/title/createdAt）；activeId 来自快照 sessionId。 */
export function normalizeSessions(raw: unknown, activeId?: string): SessionRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionRow[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = String(rec.id ?? rec.sessionId ?? '');
    if (!id) {
      continue;
    }
    const stamp = rec.updatedAt ?? rec.createdAt;
    out.push({
      id,
      title: String(rec.title ?? rec.label ?? id),
      updatedAt: typeof stamp === 'number' ? stamp : undefined,
      active: rec.active === true || rec.current === true || id === activeId
    });
  }
  return out;
}

export interface McpState {
  path: string;
  /** 已打码文本（下行前 host 已打码；这里再防御性打码一遍）。 */
  text: string;
  /** host 读文件失败 / 坏 JSON 无法脱敏时的说明（text 可能为空）。 */
  error?: string;
}

export function normalizeMcpState(raw: unknown): McpState {
  const rec = asRecord(raw);
  const rawText = typeof rec.text === 'string' ? rec.text : '';
  return {
    path: typeof rec.path === 'string' ? rec.path : '',
    text: rawText.trim().length > 0 ? (redactMcpText(rawText) ?? rawText) : rawText,
    error: typeof rec.error === 'string' && rec.error.length > 0 ? rec.error : undefined
  };
}

export interface SettingsSnapshot {
  locale?: unknown;
  config: OpsConfig;
  /** null = 快照未带 models 字段（host 未实现 models/* 家族时保持现值）。 */
  models: ModelsForm | null;
  /** models 缺席时的兜底路径（settingsSnapshot 顶层 modelsPath / agentDir）。 */
  modelsPath?: string;
  agentDir?: string;
  providers: ProviderRow[];
  mcp: McpState;
  skills: SkillRow[];
  sessions: SessionRow[];
  activeSessionId?: string;
}

export function normalizeSettingsSnapshot(raw: unknown): SettingsSnapshot {
  const rec = asRecord(raw);
  const modelsRaw = rec.models;
  const hasModels =
    typeof modelsRaw === 'object' && modelsRaw !== null && !Array.isArray(modelsRaw);
  const activeRaw = rec.activeSessionId ?? rec.sessionId;
  const activeSessionId = typeof activeRaw === 'string' && activeRaw ? activeRaw : undefined;
  return {
    locale: rec.locale,
    config: normalizeConfig(rec.config ?? rec.settings ?? {}),
    models: hasModels ? normalizeModelsState(modelsRaw) : null,
    modelsPath: typeof rec.modelsPath === 'string' ? rec.modelsPath : undefined,
    agentDir: typeof rec.agentDir === 'string' ? rec.agentDir : undefined,
    providers: normalizeProviders(rec.providers ?? rec.capabilities),
    mcp: normalizeMcpState(rec.mcp),
    skills: normalizeSkills(rec.skills),
    sessions: normalizeSessions(rec.sessions, activeSessionId),
    activeSessionId
  };
}

// ── 请求路由：models/* 通道探测（收到过 models/state 才认为 host 支持该家族） ──

export interface OutgoingReq {
  type: string;
  payload: Record<string, unknown>;
}

/** 打开 models.json：优先 models/openFile，host 未实现该家族时退回 settings/openJson。 */
export function openModelsFileReq(hasModelsChannel: boolean): OutgoingReq {
  return hasModelsChannel
    ? { type: 'models/openFile', payload: {} }
    : { type: 'settings/openJson', payload: { kind: 'models' } };
}

/** 打开 auth.json：同上，kind:'auth' 兜底。 */
export function openAuthFileReq(hasModelsChannel: boolean): OutgoingReq {
  return hasModelsChannel
    ? { type: 'models/openAuth', payload: {} }
    : { type: 'settings/openJson', payload: { kind: 'auth' } };
}
