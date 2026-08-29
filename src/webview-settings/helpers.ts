/**
 * webview-settings 纯 TS helper：页签清单、配置 diff、密钥打码/还原、
 * mcp.json 解析、models 保存载荷、provider 预设、hydrate 快照归一化。
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
  | 'sessions';

export interface SettingsTabMeta {
  id: SettingsTabId;
  /** settings i18n 键（zh-CN / en 双语）。 */
  labelKey:
    | 'navGeneral'
    | 'navModels'
    | 'navCapabilities'
    | 'navMcp'
    | 'navSessions';
}

/** 内置技能是 Agent 内部资源，无用户可见页签（历史 tab id 'skills' 归 general）。 */
export const SETTINGS_TABS: readonly SettingsTabMeta[] = [
  { id: 'general', labelKey: 'navGeneral' },
  { id: 'models', labelKey: 'navModels' },
  { id: 'capabilities', labelKey: 'navCapabilities' },
  { id: 'mcp', labelKey: 'navMcp' },
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
  /** P1-9：会话内免审的只读工具名（批准只读工具时勾「本会话不再问」也会写入）。 */
  'approval.sessionReadAllowlist': string[];
  /** P0-C：审批 waiter 超时（毫秒）；0 = 禁用超时。 */
  'approval.timeoutMs': number;
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
  'approval.sessionReadAllowlist': [],
  'approval.timeoutMs': 900000,
  'models.defaultThinkingLevel': 'medium',
  'models.toolCallPromptFallback': true,
  'workspaceShell.enabled': false,
  'subagent.maxParallel': 3,
  'streaming.batchMs': 40
};

export type ConfigKey = keyof OpsConfig;

export interface ConfigFieldMeta {
  key: ConfigKey;
  kind: 'enum' | 'boolean' | 'number' | 'list';
  options?: readonly string[];
  min?: number;
  max?: number;
  labelKey: string;
  descKey: string;
}

/** GeneralTab 渲染顺序即此清单顺序。标签走 i18n 人话文案，不再展示裸配置键。 */
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
    key: 'approval.sessionReadAllowlist',
    kind: 'list',
    labelKey: 'cfgSessionReadAllowlist',
    descKey: 'cfgSessionReadAllowlistDesc'
  },
  {
    key: 'approval.timeoutMs',
    kind: 'number',
    min: 0,
    labelKey: 'cfgApprovalTimeoutMs',
    descKey: 'cfgApprovalTimeoutMsDesc'
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

/** 字符串数组归一：数组按元素收，字符串按逗号/换行切（GeneralTab 输入框共用）。 */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
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
    'approval.sessionReadAllowlist': toStringList(get('approval.sessionReadAllowlist')),
    'approval.timeoutMs': toNum(get('approval.timeoutMs'), CONFIG_DEFAULTS['approval.timeoutMs'], 0),
    'models.defaultThinkingLevel': toEnum(get('models.defaultThinkingLevel'), THINKING_LEVELS, 'medium'),
    'models.toolCallPromptFallback': toBool(get('models.toolCallPromptFallback'), true),
    'workspaceShell.enabled': toBool(get('workspaceShell.enabled'), false),
    'subagent.maxParallel': toNum(get('subagent.maxParallel'), CONFIG_DEFAULTS['subagent.maxParallel'], 1, 4),
    'streaming.batchMs': toNum(get('streaming.batchMs'), CONFIG_DEFAULTS['streaming.batchMs'], 0)
  };
}

/** 配置值等价判断（string[] 按元素比较，其余全等）。 */
function configValueEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => entry === b[i]);
  }
  return a === b;
}

/**
 * 配置 diff：只保留改动键。无改动返回 null（保存按钮置灰依据）。
 */
export function buildConfigPatch(saved: OpsConfig, edited: OpsConfig): Partial<OpsConfig> | null {
  const patch: AnyRecord = {};
  for (const field of CONFIG_FIELDS) {
    if (!configValueEquals(saved[field.key], edited[field.key])) {
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

/** McpTab 卡片列表条目（P1-12：server 卡片化，textarea 收进高级折叠）。 */
export interface McpServerCard {
  name: string;
  /** command + args 或 url 的一行摘要（渲染前文本已打码）。 */
  summary: string;
  /** 命中 AT Series 去重规则（内置 HubHost 覆盖，保存后不会被拉起）。 */
  skipped: boolean;
}

export interface McpParseResult {
  ok: boolean;
  error?: string;
  serverNames: string[];
  /** 命中 AT Series 去重规则（内置 HubHost 覆盖，保存后不会被拉起）。 */
  skippedAtSeries: string[];
  /** 卡片视图数据（与 serverNames 同序）。 */
  servers: McpServerCard[];
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

function mcpEntrySummary(entry: AnyRecord): string {
  if (typeof entry.command === 'string' && entry.command.length > 0) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === 'string')
      : [];
    return [entry.command, ...args].join(' ');
  }
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    return entry.url;
  }
  return '';
}

export function parseMcpConfig(text: string): McpParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, serverNames: [], skippedAtSeries: [], servers: [] };
  }
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      serverNames: [],
      skippedAtSeries: [],
      servers: []
    };
  }
  const rec = asRecord(root);
  const source = rec.servers ?? rec.mcpServers;
  const serverNames: string[] = [];
  const skippedAtSeries: string[] = [];
  const servers: McpServerCard[] = [];
  const inspect = (name: string, entry: AnyRecord): void => {
    serverNames.push(name);
    const skipped = isAtSeriesHubEntry(name, entry);
    if (skipped) {
      skippedAtSeries.push(name);
    }
    servers.push({ name, summary: mcpEntrySummary(entry), skipped });
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
  return { ok: true, serverNames, skippedAtSeries, servers };
}

// ── Provider 预设（P0-B / P1-1：选完自动预填 baseUrl / api / compat） ──────

export type ThinkingFormat = 'default' | 'deepseek' | 'qwen' | 'zai';

export const THINKING_FORMATS = ['default', 'deepseek', 'qwen', 'zai'] as const;

export interface ProviderPreset {
  /** models.json providers 键（openai-compatible 自定义时可被用户改写）。 */
  id: string;
  /** settings i18n 键。 */
  labelKey:
    | 'pInternalGateway'
    | 'pOpenai'
    | 'pAnthropic'
    | 'pDeepseek'
    | 'pQwen'
    | 'pCustom';
  baseUrl: string;
  api: string;
  thinkingFormat: ThinkingFormat;
  /** 支持浏览器 OAuth 登录（key 可留空，凭证进 auth.json）。 */
  oauth?: boolean;
  /** 常见模型 id（datalist 建议项；「拉取模型列表」成功后被真实目录取代）。 */
  models: readonly string[];
}

export const CUSTOM_PROVIDER_ID = 'openai-compatible';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'internal-gateway',
    labelKey: 'pInternalGateway',
    baseUrl: 'https://llm.example.internal/v1',
    api: 'openai-completions',
    thinkingFormat: 'default',
    models: ['qwen3-max', 'deepseek-v3']
  },
  {
    id: 'openai',
    labelKey: 'pOpenai',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    thinkingFormat: 'default',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini']
  },
  {
    id: 'anthropic',
    labelKey: 'pAnthropic',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
    thinkingFormat: 'default',
    oauth: true,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1']
  },
  {
    id: 'deepseek',
    labelKey: 'pDeepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    thinkingFormat: 'deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'qwen',
    labelKey: 'pQwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    thinkingFormat: 'qwen',
    models: ['qwen3-max', 'qwen-plus', 'qwen-turbo']
  },
  {
    id: CUSTOM_PROVIDER_ID,
    labelKey: 'pCustom',
    baseUrl: '',
    api: 'openai-completions',
    thinkingFormat: 'default',
    models: []
  }
] as const;

export function providerPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 表单的 providerId 归到下拉值：预设 id 直接用，未知 id 视为自定义。 */
export function presetIdForProvider(providerId: string): string {
  return providerPresetById(providerId) ? providerId : CUSTOM_PROVIDER_ID;
}

/** OAuth 登录常见 provider id（P2-5：下拉 + 自定义，不再默认 internal-gateway）。 */
export const OAUTH_PROVIDER_IDS: readonly string[] = [
  'anthropic',
  'openai',
  'google',
  'github-copilot'
];

// ── Models 表单（对齐 src/host/modelsView.ts 的 ModelsFormState / SavePayload） ──

/** per-角色模型映射的角色集合（与 host modelsView.ROLE_MODEL_ROLES 同源）。 */
export const ROLE_MODEL_ROLES = ['investigator', 'executor', 'writer', 'verifier'] as const;
export type RoleModelRole = (typeof ROLE_MODEL_ROLES)[number];
/** UI 绑定用固定形状；空串 = 跟随当前模型。 */
export type RoleModelsForm = Record<RoleModelRole, { provider: string; model: string }>;

export function emptyRoleModels(): RoleModelsForm {
  return {
    investigator: { provider: '', model: '' },
    executor: { provider: '', model: '' },
    writer: { provider: '', model: '' },
    verifier: { provider: '', model: '' }
  };
}

/** host 下发的 roleModels（partial map）→ UI 固定形状。 */
export function normalizeRoleModelsForm(raw: unknown): RoleModelsForm {
  const rec = asRecord(raw);
  const out = emptyRoleModels();
  for (const role of ROLE_MODEL_ROLES) {
    const entry = asRecord(rec[role]);
    if (typeof entry.provider === 'string') out[role].provider = entry.provider.trim();
    if (typeof entry.model === 'string') out[role].model = entry.model.trim();
  }
  return out;
}

export interface ModelsForm {
  providerId: string;
  baseUrl: string;
  /** provider.api（预设填充；openai-completions / anthropic-messages…）。 */
  api: string;
  modelId: string;
  modelName: string;
  /** 模型条目 reasoning 字段（pi schema；旧 thinking 由归一化收编）。 */
  reasoning: boolean;
  /** host 只下发「是否已存 key」；key 本体绝不回显。 */
  hasKey: boolean;
  modelsPath: string;
  authPath: string;
  oauthNote: string;
  thinkingFormat: ThinkingFormat;
  supportsDeveloperRole: boolean;
  thinkingLevel: ThinkingLevel;
  /** per-角色模型映射（P2：Investigator 便宜模型 / Writer、Verifier 强模型）。 */
  roleModels: RoleModelsForm;
  /** 仅上行字段：发送后立即清空。 */
  apiKey: string;
  /** OAuth 页选择（常见 provider id 下拉；'custom' 时用 oauthProviderCustom）。 */
  oauthProvider: string;
  oauthProviderCustom: string;
}

export function emptyModelsForm(): ModelsForm {
  return {
    providerId: '',
    baseUrl: '',
    api: 'openai-completions',
    modelId: '',
    modelName: '',
    reasoning: false,
    hasKey: false,
    modelsPath: '',
    authPath: '',
    oauthNote: '',
    thinkingFormat: 'default',
    supportsDeveloperRole: true,
    thinkingLevel: 'medium',
    roleModels: emptyRoleModels(),
    apiKey: '',
    oauthProvider: OAUTH_PROVIDER_IDS[0],
    oauthProviderCustom: ''
  };
}

/**
 * models/state 载荷归一：apiKey 无论 host 发什么都强制置空（永不回显）；
 * reasoning 兼容旧字段名 thinking；previous 提供时保留用户已输入的 OAuth 选择。
 */
export function normalizeModelsState(raw: unknown, previous?: ModelsForm): ModelsForm {
  const rec = asRecord(raw);
  const providerId = typeof rec.providerId === 'string' ? rec.providerId : '';
  return {
    providerId,
    baseUrl: typeof rec.baseUrl === 'string' ? rec.baseUrl : '',
    api: typeof rec.api === 'string' && rec.api.length > 0 ? rec.api : 'openai-completions',
    modelId: typeof rec.modelId === 'string' ? rec.modelId : '',
    modelName: typeof rec.modelName === 'string' ? rec.modelName : '',
    reasoning: rec.reasoning === true || rec.thinking === true,
    hasKey: rec.hasKey === true,
    modelsPath: typeof rec.modelsPath === 'string' ? rec.modelsPath : '',
    authPath: typeof rec.authPath === 'string' ? rec.authPath : '',
    oauthNote: typeof rec.oauthNote === 'string' ? rec.oauthNote : '',
    thinkingFormat: toEnum(rec.thinkingFormat, THINKING_FORMATS, 'default'),
    supportsDeveloperRole: rec.supportsDeveloperRole !== false,
    thinkingLevel: toEnum(rec.thinkingLevel, THINKING_LEVELS, 'medium'),
    roleModels: normalizeRoleModelsForm(rec.roleModels),
    apiKey: '',
    oauthProvider: previous?.oauthProvider ? previous.oauthProvider : OAUTH_PROVIDER_IDS[0],
    oauthProviderCustom: previous?.oauthProviderCustom ?? ''
  };
}

/**
 * 应用 provider 预设（返回新表单，不改入参）：
 * - 预设 id 写入 providerId；baseUrl / api / thinkingFormat 按预设覆盖；
 * - 自定义（openai-compatible）保留用户已填的 baseUrl / providerId 手输值；
 * - 模型 id 为空时预填该预设第一个常见模型（不覆盖用户已输入的 id）。
 */
export function applyProviderPreset(form: ModelsForm, presetId: string): ModelsForm {
  const preset = providerPresetById(presetId);
  if (!preset) {
    return { ...form };
  }
  const next: ModelsForm = { ...form, roleModels: { ...form.roleModels } };
  if (preset.id === CUSTOM_PROVIDER_ID) {
    // 自定义：只有当前是预设 id 时才切换 providerId，不清用户手输内容。
    if (providerPresetById(form.providerId) || form.providerId.length === 0) {
      next.providerId = CUSTOM_PROVIDER_ID;
    }
    next.api = preset.api;
    return next;
  }
  next.providerId = preset.id;
  next.baseUrl = preset.baseUrl;
  next.api = preset.api;
  next.thinkingFormat = preset.thinkingFormat;
  if (next.modelId.trim().length === 0 && preset.models.length > 0) {
    next.modelId = preset.models[0];
  }
  return next;
}

/**
 * P0-B 客户端预检：既没有已存 key、又没在本次表单里填 key ⇒ 保存后不许报绿色
 * 「已保存」。OAuth 型预设（anthropic）豁免——凭证走 auth.json。
 */
export function modelsKeyMissing(form: ModelsForm): boolean {
  if (form.hasKey || form.apiKey.trim().length > 0) {
    return false;
  }
  const preset = providerPresetById(form.providerId);
  return preset?.oauth !== true;
}

export type ModelsSaveResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: 'required' };

/**
 * models/save 载荷：对齐 modelsView SavePayload。
 * - 字段名用 reasoning（host 读端兼容旧 thinking，但本侧不再发旧名）。
 * - providerId / api 随预设上行（host 按 providerId upsert，不再恒取第一个）。
 * - apiKey 为空时整键省略（host 语义：留空 = 保持现有 key）；不含 hasKey / 路径。
 * - roleModels 只带 model 非空的角色；provider 留空回落当前 providerId。
 */
export function buildModelsSavePayload(form: ModelsForm): ModelsSaveResult {
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  if (baseUrl.length === 0 || modelId.length === 0) {
    return { ok: false, error: 'required' };
  }
  const providerId = form.providerId.trim() || CUSTOM_PROVIDER_ID;
  const roleModels: Record<string, { provider: string; model: string }> = {};
  for (const role of ROLE_MODEL_ROLES) {
    const entry = form.roleModels[role];
    const model = entry.model.trim();
    if (model.length === 0) continue;
    roleModels[role] = { provider: entry.provider.trim() || providerId, model };
  }
  const payload: Record<string, unknown> = {
    providerId,
    baseUrl,
    api: form.api.trim() || 'openai-completions',
    modelId,
    modelName: form.modelName.trim(),
    reasoning: form.reasoning === true,
    thinkingLevel: toEnum(form.thinkingLevel, THINKING_LEVELS, 'medium'),
    thinkingFormat: toEnum(form.thinkingFormat, THINKING_FORMATS, 'default'),
    supportsDeveloperRole: form.supportsDeveloperRole !== false,
    roleModels
  };
  const apiKey = form.apiKey.trim();
  if (apiKey.length > 0) {
    payload.apiKey = apiKey;
  }
  return { ok: true, payload };
}

/** OAuth 登录的实际 provider id（下拉选 custom 时取手输值）。 */
export function resolveOauthProvider(form: ModelsForm): string {
  if (form.oauthProvider === 'custom') {
    return form.oauthProviderCustom.trim();
  }
  return form.oauthProvider.trim();
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

/** models/test 载荷（ModelsTestReq）：key 走 SecretStorage，绝不从表单带出。 */
export function buildModelsTestReq(form: ModelsForm): Record<string, unknown> {
  return {
    baseUrl: form.baseUrl.trim(),
    modelId: form.modelId.trim(),
    provider: form.providerId.trim() || CUSTOM_PROVIDER_ID
  };
}

/** models/fetch 载荷（ModelsFetchReq）。 */
export function buildModelsFetchReq(form: ModelsForm): Record<string, unknown> {
  return {
    baseUrl: form.baseUrl.trim(),
    provider: form.providerId.trim() || CUSTOM_PROVIDER_ID
  };
}

/** models/fetch 结果归一：字符串数组（去重、去空白）。 */
export function normalizeFetchedModels(raw: unknown): string[] {
  const rec = asRecord(raw);
  const list = Array.isArray(rec.models) ? rec.models : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const entry of list) {
    const id =
      typeof entry === 'string'
        ? entry.trim()
        : typeof asRecord(entry).id === 'string'
          ? (asRecord(entry).id as string).trim()
          : '';
    if (id.length > 0 && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}
