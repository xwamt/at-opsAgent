/**
 * settings webview 专用 i18n 包（独立于 src/webview-chat/i18n.ts，避免与
 * chat 侧改动冲突）。模式相同：初始语言取 <html lang>（host 注入，默认 zh-CN），
 * hydrate payload 带 locale 字段时切换；键值扁平随 bundle 内联，无第三方库。
 *
 * 本模块被 node 环境单测直接 import（root tsconfig 无 DOM lib），
 * document 访问必须走 globalThis 收窄。
 */
import { ref } from 'vue';

export type OpsLocale = 'zh-CN' | 'en';

const zhCN = {
  settingsTitle: '设置',
  navGeneral: '常规',
  navModels: '模型',
  navCapabilities: '能力插件',
  navMcp: 'MCP',
  navSessions: '会话',
  save: '保存',
  saved: '已保存',
  saveFailed: '保存失败',
  noChanges: '暂无改动',
  loading: '等待 host 数据…',
  mockBadge: 'mock',

  generalTitle: '常规',
  generalHint: '写入 VS Code 配置；保存只提交改动项。',
  openVsCodeSettings: '打开 VS Code 设置',
  cfgDiscoveryMode: '工具渐进披露',
  cfgDiscoveryModeDesc: 'auto：工具超过阈值才收窄；always：恒收窄；off：全量暴露。',
  cfgDiscoveryThreshold: '披露阈值',
  cfgDiscoveryThresholdDesc: '工具总数超过该值时启用渐进披露（模式为 auto 时生效）。',
  cfgAutoEnableNew: '自动启用新插件',
  cfgAutoEnableNewDesc: '新发现的 AT 系列能力插件自动接入，无需手动确认。',
  cfgSessionRequiredFor: '会话内审批范围',
  cfgSessionRequiredForDesc: '哪些风险等级需要会话内审批简报：写+执行 / 仅执行 / 从不。',
  cfgDedupePluginModal: '合并插件确认弹窗',
  cfgDedupePluginModalDesc: '开启后以 Agent 审批简报为准，尽量抑制插件自身的确认弹窗。',
  cfgSessionReadAllowlist: '只读工具免审名单',
  cfgSessionReadAllowlistDesc:
    '这些只读工具在会话内跳过审批（逗号分隔工具名）。批准只读工具时选「本会话不再询问」也会加入。写 / 执行类工具永远需要审批。',
  cfgDefaultThinkingLevel: '默认思考等级',
  cfgDefaultThinkingLevelDesc: '模型页未单独设置思考等级时的默认值。',
  cfgToolCallPromptFallback: '工具调用提示词兜底',
  cfgToolCallPromptFallbackDesc: '模型不支持原生 tool call 时改走提示词协议。',
  cfgWorkspaceShell: '工作区 Shell',
  cfgWorkspaceShellDesc: '允许受限的工作区内 shell 命令（默认关闭）。',
  cfgSubagentMaxParallel: '子代理并行上限',
  cfgSubagentMaxParallelDesc: '同时运行的子代理数量上限（1–4）。',
  cfgStreamingBatchMs: '流式合批间隔（毫秒）',
  cfgStreamingBatchMsDesc: '事件流合批下发的毫秒间隔。',
  cfgListPlaceholder: '用逗号分隔，例如 db_query, log_search',

  modelsTitle: '模型',
  modelsHint: '配置写入 models.json；API key 只存 VS Code SecretStorage，文件中保留占位符、绝不回显。',
  modelsSectionConnect: '连接模型',
  modelsSectionReasoning: '深度思考',
  modelsSectionCompat: '兼容性',
  modelsSectionOauth: 'OAuth 登录',
  mAdvanced: '高级',
  mAdvancedHint: '深度思考 · 兼容性 · OAuth 登录 · 按角色指定模型',
  mFirstRunHint:
    '首次配置三步即可：选择模型服务（不确定就问平台组，通常是「内部网关」），粘贴 API Key，点「保存并测试」；成功后回到聊天开始对话。',
  mProvider: '模型服务（Provider）',
  pInternalGateway: '公司内部网关（OpenAI 兼容）',
  pOpenai: 'OpenAI',
  pAnthropic: 'Anthropic（支持浏览器登录，无需手输 key）',
  pDeepseek: 'DeepSeek',
  pQwen: '通义千问（Qwen）',
  pCustom: '自定义（OpenAI 兼容）',
  mProviderId: 'Provider ID（写入 models.json 的键名）',
  mApiStyle: 'API 风格',
  mBaseUrl: 'Base URL',
  mModelId: '模型 ID',
  mModelIdHint: '可手输，或点「拉取模型列表」后从建议中选择。',
  mModelName: '显示名（可选）',
  mReasoning: '支持深度思考（reasoning）',
  mThinkingLevel: '思考等级',
  mApiKey: 'API Key',
  mApiKeyPlaceholder: '留空 = 保持现有 key',
  mApiKeyPlaceholderFirstRun: '粘贴 API Key',
  mKeySecretNote: 'Key 只保存在 VS Code 安全存储（SecretStorage），不会写入任何文件或日志。',
  mKeySaved: 'API key 已保存于 SecretStorage',
  mKeyMissing: '尚未保存 API key',
  mKeyMissingWarn: '尚未填写 API Key，问答将失败。粘贴 Key 后再次保存，或改用 OAuth 登录。',
  mSaveTest: '保存并测试',
  mTesting: '已保存，正在测试连接…',
  mTestOk: '连接成功，可以开始问答',
  mTest401: '服务返回 401：Key 无效或已过期，请检查后重试。',
  mTestFail: '连接失败：',
  mFetchModels: '拉取模型列表',
  mFetching: '正在拉取模型列表…',
  mFetchOk: '已拉取模型列表：',
  mFetchOkUnit: '个模型（模型 ID 输入框已带建议）',
  mFetchFail: '拉取失败：',
  mThinkingFormat: '思考字段兼容格式',
  mThinkingFormatDefault: 'default（不写入，走 pi-ai 默认）',
  mSupportsDeveloperRole: '支持 developer role 消息（取消勾选写 false）',
  mCompatHint: '保存后写入 models.json 的 compat 段；默认值不落字段，其他 compat 字段原样保留。',
  mRolesTitle: '按角色指定模型（可选）',
  mRolesHint:
    '默认全部跟随当前模型。可为 Investigator 指定便宜模型、Writer / Verifier 指定强模型；留空 = 跟随当前模型。',
  roleInvestigator: 'Investigator（调查，只读）',
  roleExecutor: 'Executor（执行）',
  roleWriter: 'Writer（报告撰写）',
  roleVerifier: 'Verifier（复核）',
  mRoleProviderPh: 'provider（留空 = 当前）',
  mRoleModelPh: '模型 ID（留空 = 跟随当前模型）',
  mOauthProvider: 'Provider',
  mOauthCustom: '自定义…',
  mOauthCustomPh: '输入 provider id',
  mOauthLogin: '开始登录',
  mOauthPending: 'OAuth 登录进行中…（浏览器 / 输入框交互见 VS Code 提示）',
  mOpenAuth: '打开 auth.json',
  mOpenModels: '打开 models.json',
  mOauthNote: 'OAuth 凭证只写入 ~/.at-series/agent/auth.json（0600），绝不进 models.json、绝不写日志。',
  mAuthPathLabel: 'auth.json 路径：',
  mRequired: 'Base URL 与模型 ID 不能为空。',

  capTitle: '能力插件',
  capHint: '来自 AT 系列插件的能力桥（HubHost providers），不是第三方 MCP。',
  capRefresh: '刷新',
  capDiagnose: '诊断',
  capHealthy: 'healthy',
  capUnhealthy: 'unhealthy',
  capTools: '工具',
  capBridges: 'bridges',
  capEmpty:
    '尚未发现能力插件。安装 AT 系列插件（AT Terminal / AT Grafana / AT Jenkins…）即可自动接入，无需任何 MCP 配置。',

  mcpTitle: '第三方 MCP',
  mcpHint: '第三方 MCP 服务器接入（AT 系列插件无需在此配置）。',
  mcpHubWarn: 'AT Series hub.js 条目会被跳过：内置 HubHost 已覆盖同一能力，无需在 mcp.json 配置。',
  mcpRedactHint: '敏感字段显示为 ***；保持 *** 保存即维持原值，改成新值则覆盖。',
  mcpServers: '已配置的 server',
  mcpEmpty: '尚未配置第三方 MCP server。展开下方「高级」编辑 mcp.json 即可添加。',
  mcpSkippedBadge: '内置已覆盖，跳过',
  mcpAdvanced: '高级：直接编辑 mcp.json',
  mcpInvalid: 'JSON 无效：',
  mcpServerCount: '个 server',
  mcpSkipped: '以下条目命中 AT Series 去重规则，保存后不会被拉起：',
  mcpSave: '保存 mcp.json',
  mcpOpen: '打开 mcp.json',

  sessionsTitle: '会话',
  sessionsNew: '新建会话',
  sessionsEmpty: '暂无历史会话',
  sessionsActive: '当前'
} as const;

export type SettingsMessageKey = keyof typeof zhCN;

const en: Record<SettingsMessageKey, string> = {
  settingsTitle: 'Settings',
  navGeneral: 'General',
  navModels: 'Models',
  navCapabilities: 'Capabilities',
  navMcp: 'MCP',
  navSessions: 'Sessions',
  save: 'Save',
  saved: 'Saved',
  saveFailed: 'Save failed',
  noChanges: 'No changes',
  loading: 'Waiting for host data…',
  mockBadge: 'mock',

  generalTitle: 'General',
  generalHint: 'Written to VS Code settings; saving only submits changed keys.',
  openVsCodeSettings: 'Open VS Code Settings',
  cfgDiscoveryMode: 'Progressive tool discovery',
  cfgDiscoveryModeDesc:
    'auto: narrows only above the threshold; always: always narrows; off: exposes everything.',
  cfgDiscoveryThreshold: 'Discovery threshold',
  cfgDiscoveryThresholdDesc:
    'Progressive discovery kicks in when the tool count exceeds this value (mode auto).',
  cfgAutoEnableNew: 'Auto-enable new plugins',
  cfgAutoEnableNewDesc: 'Newly discovered AT Series capability plugins connect without confirmation.',
  cfgSessionRequiredFor: 'In-session approval scope',
  cfgSessionRequiredForDesc:
    'Which risk levels require an in-session approval brief: write+exec / exec only / never.',
  cfgDedupePluginModal: 'Merge plugin confirmation dialogs',
  cfgDedupePluginModalDesc:
    'When on, the agent approval brief is authoritative and plugin confirmation dialogs are suppressed when possible.',
  cfgSessionReadAllowlist: 'Approval-exempt read-only tools',
  cfgSessionReadAllowlistDesc:
    'These read-only tools skip in-session approval (comma-separated tool names). Choosing “don’t ask again this session” when approving a read tool also adds it. Write / exec tools always require approval.',
  cfgDefaultThinkingLevel: 'Default thinking level',
  cfgDefaultThinkingLevelDesc: 'Used when the Models tab does not set a thinking level explicitly.',
  cfgToolCallPromptFallback: 'Tool-call prompt fallback',
  cfgToolCallPromptFallbackDesc:
    'Fall back to the prompt protocol when the model lacks native tool calls.',
  cfgWorkspaceShell: 'Workspace shell',
  cfgWorkspaceShellDesc: 'Allow restricted shell commands inside the workspace (off by default).',
  cfgSubagentMaxParallel: 'Max parallel subagents',
  cfgSubagentMaxParallelDesc: 'Upper bound of concurrently running subagents (1–4).',
  cfgStreamingBatchMs: 'Streaming batch interval (ms)',
  cfgStreamingBatchMsDesc: 'Milliseconds between batched event flushes to the webview.',
  cfgListPlaceholder: 'Comma-separated, e.g. db_query, log_search',

  modelsTitle: 'Models',
  modelsHint:
    'Written to models.json; the API key lives only in VS Code SecretStorage — the file keeps a placeholder and the key is never echoed back.',
  modelsSectionConnect: 'Connect model',
  modelsSectionReasoning: 'Reasoning',
  modelsSectionCompat: 'Compatibility',
  modelsSectionOauth: 'OAuth login',
  mAdvanced: 'Advanced',
  mAdvancedHint: 'Reasoning · compatibility · OAuth login · per-role models',
  mFirstRunHint:
    'First-time setup takes three steps: pick a provider (unsure? ask your platform team — usually the internal gateway), paste your API key, then “Save & test”. Once connected, head back to chat.',
  mProvider: 'Provider',
  pInternalGateway: 'Internal gateway (OpenAI-compatible)',
  pOpenai: 'OpenAI',
  pAnthropic: 'Anthropic (browser login supported, no key needed)',
  pDeepseek: 'DeepSeek',
  pQwen: 'Qwen',
  pCustom: 'Custom (OpenAI-compatible)',
  mProviderId: 'Provider ID (key written to models.json)',
  mApiStyle: 'API style',
  mBaseUrl: 'Base URL',
  mModelId: 'Model ID',
  mModelIdHint: 'Type it in, or hit “Fetch model list” and pick from suggestions.',
  mModelName: 'Display name (optional)',
  mReasoning: 'Supports deep reasoning',
  mThinkingLevel: 'Thinking level',
  mApiKey: 'API Key',
  mApiKeyPlaceholder: 'Leave empty to keep the current key',
  mApiKeyPlaceholderFirstRun: 'Paste your API key',
  mKeySecretNote:
    'The key is stored only in VS Code SecretStorage — never written to any file or log.',
  mKeySaved: 'API key stored in SecretStorage',
  mKeyMissing: 'No API key stored yet',
  mKeyMissingWarn:
    'No API key yet — chat will fail. Paste a key and save again, or use OAuth login instead.',
  mSaveTest: 'Save & test',
  mTesting: 'Saved. Testing the connection…',
  mTestOk: 'Connected — you are ready to chat',
  mTest401: 'The service returned 401: the key is invalid or expired. Please check and retry.',
  mTestFail: 'Connection failed: ',
  mFetchModels: 'Fetch model list',
  mFetching: 'Fetching model list…',
  mFetchOk: 'Model list fetched: ',
  mFetchOkUnit: 'models (suggestions added to the Model ID field)',
  mFetchFail: 'Fetch failed: ',
  mThinkingFormat: 'Thinking field compatibility',
  mThinkingFormatDefault: 'default (not written; pi-ai default)',
  mSupportsDeveloperRole: 'Supports developer-role messages (uncheck to write false)',
  mCompatHint:
    'Saved into the compat section of models.json; defaults are omitted and other compat fields are preserved.',
  mRolesTitle: 'Per-role models (optional)',
  mRolesHint:
    'All roles follow the current model by default. Point Investigator at a cheap model and Writer / Verifier at a strong one; leave empty to follow the current model.',
  roleInvestigator: 'Investigator (read-only)',
  roleExecutor: 'Executor',
  roleWriter: 'Writer (reports)',
  roleVerifier: 'Verifier',
  mRoleProviderPh: 'provider (empty = current)',
  mRoleModelPh: 'model ID (empty = follow current model)',
  mOauthProvider: 'Provider',
  mOauthCustom: 'Custom…',
  mOauthCustomPh: 'Enter a provider id',
  mOauthLogin: 'Start login',
  mOauthPending: 'OAuth login in progress… (browser / input interactions appear via VS Code)',
  mOpenAuth: 'Open auth.json',
  mOpenModels: 'Open models.json',
  mOauthNote:
    'OAuth credentials go only to ~/.at-series/agent/auth.json (0600) — never into models.json, never into logs.',
  mAuthPathLabel: 'auth.json path: ',
  mRequired: 'Base URL and Model ID are required.',

  capTitle: 'Capabilities',
  capHint: 'Capability bridges from AT Series plugins (HubHost providers), not third-party MCP.',
  capRefresh: 'Refresh',
  capDiagnose: 'Diagnose',
  capHealthy: 'healthy',
  capUnhealthy: 'unhealthy',
  capTools: 'tools',
  capBridges: 'bridges',
  capEmpty:
    'No capability plugins found. Install AT Series plugins (AT Terminal / AT Grafana / AT Jenkins…) and they connect automatically — no MCP configuration needed.',

  mcpTitle: 'Third-party MCP',
  mcpHint: 'Third-party MCP servers (AT Series plugins never need an entry here).',
  mcpHubWarn:
    'AT Series hub.js entries are skipped: the embedded HubHost already covers them, no mcp.json entry needed.',
  mcpRedactHint:
    'Secrets are shown as ***; keeping *** on save preserves the old value, a new value overwrites it.',
  mcpServers: 'Configured servers',
  mcpEmpty: 'No third-party MCP servers yet. Expand “Advanced” below to edit mcp.json.',
  mcpSkippedBadge: 'covered built-in, skipped',
  mcpAdvanced: 'Advanced: edit mcp.json directly',
  mcpInvalid: 'Invalid JSON: ',
  mcpServerCount: 'server(s)',
  mcpSkipped: 'These entries match the AT Series dedupe rule and will not be spawned:',
  mcpSave: 'Save mcp.json',
  mcpOpen: 'Open mcp.json',

  sessionsTitle: 'Sessions',
  sessionsNew: 'New session',
  sessionsEmpty: 'No sessions yet',
  sessionsActive: 'current'
};

const MESSAGES: Record<OpsLocale, Record<SettingsMessageKey, string>> = { 'zh-CN': zhCN, en };

/** 'zh*' → zh-CN；'en*' → en；其它/空 → null（调用方决定兜底）。 */
export function normalizeLocale(raw: unknown): OpsLocale | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.startsWith('zh')) {
    return 'zh-CN';
  }
  if (value.startsWith('en')) {
    return 'en';
  }
  return null;
}

function documentLang(): string {
  const doc = (globalThis as { document?: { documentElement?: { lang?: string } } }).document;
  return doc?.documentElement?.lang ?? '';
}

/** 启动检测：<html lang>（host 注入 zh-CN）→ 归一化；识别不了默认 zh-CN。 */
export function detectLocale(): OpsLocale {
  return normalizeLocale(documentLang()) ?? 'zh-CN';
}

const current = ref<OpsLocale>(detectLocale());

export function getLocale(): OpsLocale {
  return current.value;
}

/** hydrate payload 的 locale 字段（无法识别时保持当前语言）。 */
export function setLocale(raw: unknown): void {
  const locale = normalizeLocale(raw);
  if (locale) {
    current.value = locale;
  }
}

/** 响应式取词：computed / 模板渲染中调用即可跟随 locale 切换。 */
export function t(key: SettingsMessageKey): string {
  return MESSAGES[current.value][key] ?? zhCN[key];
}
