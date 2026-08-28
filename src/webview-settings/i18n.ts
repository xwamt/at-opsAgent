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
  generalHint: '写入 VS Code 配置（atOpsAgent.*）；保存只提交改动项。',
  openVsCodeSettings: '打开 VS Code 设置',
  cfgDiscoveryMode: '渐进披露模式（discovery.mode）',
  cfgDiscoveryModeDesc: 'Hub 工具渐进披露：auto 超阈值才收窄；always 恒收窄；off 全量暴露。',
  cfgDiscoveryThreshold: '披露阈值（discovery.threshold）',
  cfgDiscoveryThresholdDesc: '工具总数超过该值时启用渐进披露（mode=auto 生效）。',
  cfgAutoEnableNew: '自动启用新插件（plugins.autoEnableNew）',
  cfgAutoEnableNewDesc: '新发现的 AT 系列能力插件自动接入，无需手动确认。',
  cfgSessionRequiredFor: '会话级审批范围（approval.sessionRequiredFor）',
  cfgSessionRequiredForDesc: '哪些风险等级需要会话内审批简报：write-exec / exec-only / never。',
  cfgDedupePluginModal: '合并插件二次弹窗（approval.dedupePluginModal）',
  cfgDedupePluginModalDesc: '开启后以 Agent 审批简报为准，尽量抑制插件自身的确认弹窗。',
  cfgDefaultThinkingLevel: '默认思考等级（models.defaultThinkingLevel）',
  cfgDefaultThinkingLevelDesc: '模型页未单独设置 thinkingLevel 时的默认值。',
  cfgToolCallPromptFallback: '工具调用提示词兜底（models.toolCallPromptFallback）',
  cfgToolCallPromptFallbackDesc: '模型不支持原生 tool call 时改走提示词协议。',
  cfgWorkspaceShell: '工作区 Shell（workspaceShell.enabled）',
  cfgWorkspaceShellDesc: '允许受限的工作区内 shell 命令（默认关闭）。',
  cfgSubagentMaxParallel: '子代理并行上限（subagent.maxParallel）',
  cfgSubagentMaxParallelDesc: '同时运行的子代理数量上限（1–4）。',
  cfgStreamingBatchMs: '流式合批间隔（streaming.batchMs）',
  cfgStreamingBatchMsDesc: '事件流合批下发的毫秒间隔。',

  modelsTitle: '模型',
  modelsHint: '配置写入 models.json；API key 只存 VS Code SecretStorage，文件中保留占位符、绝不回显。',
  modelsSectionApi: 'API Key',
  modelsSectionCompat: 'Compat',
  modelsSectionOauth: 'OAuth',
  mBaseUrl: 'Base URL',
  mModelId: '模型 ID',
  mModelName: '显示名（可选）',
  mThinking: '支持思考（thinking）',
  mThinkingLevel: '思考等级（thinkingLevel，持久化到 settings.json）',
  mApiKey: 'API Key',
  mApiKeyPlaceholder: '留空 = 保持现有 key',
  mKeySaved: 'API key 已保存于 SecretStorage',
  mKeyMissing: '尚未保存 API key',
  mThinkingFormat: 'thinkingFormat（思考字段兼容格式）',
  mThinkingFormatDefault: 'default（不写入，走 pi-ai 默认）',
  mSupportsDeveloperRole: '支持 developer role 消息（取消勾选写 false）',
  mCompatHint: '保存后写入 models.json providers[…].compat；默认值不落字段，其他 compat 字段原样保留。',
  mOauthProvider: 'Provider ID',
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
  mcpHint: '编辑 mcp.json 的 servers / mcpServers 段落，供第三方 MCP 服务器接入。',
  mcpHubWarn: 'AT Series hub.js 条目会被跳过：内置 HubHost 已覆盖同一能力，无需在 mcp.json 配置。',
  mcpRedactHint: '敏感字段显示为 ***；保持 *** 保存即维持原值，改成新值则覆盖。',
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
  generalHint: 'Written to VS Code settings (atOpsAgent.*); saving only submits changed keys.',
  openVsCodeSettings: 'Open VS Code Settings',
  cfgDiscoveryMode: 'Progressive discovery mode (discovery.mode)',
  cfgDiscoveryModeDesc:
    'Hub tool discovery: auto narrows only above the threshold; always narrows; off exposes everything.',
  cfgDiscoveryThreshold: 'Discovery threshold (discovery.threshold)',
  cfgDiscoveryThresholdDesc:
    'Progressive discovery kicks in when the tool count exceeds this value (mode=auto).',
  cfgAutoEnableNew: 'Auto-enable new plugins (plugins.autoEnableNew)',
  cfgAutoEnableNewDesc: 'Newly discovered AT Series capability plugins connect without confirmation.',
  cfgSessionRequiredFor: 'Session approval scope (approval.sessionRequiredFor)',
  cfgSessionRequiredForDesc:
    'Which risk levels require an in-session approval brief: write-exec / exec-only / never.',
  cfgDedupePluginModal: 'Dedupe plugin modals (approval.dedupePluginModal)',
  cfgDedupePluginModalDesc:
    'When on, the agent approval brief is authoritative and plugin confirmation dialogs are suppressed when possible.',
  cfgDefaultThinkingLevel: 'Default thinking level (models.defaultThinkingLevel)',
  cfgDefaultThinkingLevelDesc: 'thinkingLevel used when not set explicitly on the Models tab.',
  cfgToolCallPromptFallback: 'Tool-call prompt fallback (models.toolCallPromptFallback)',
  cfgToolCallPromptFallbackDesc:
    'Fall back to the prompt protocol when the model lacks native tool calls.',
  cfgWorkspaceShell: 'Workspace shell (workspaceShell.enabled)',
  cfgWorkspaceShellDesc: 'Allow restricted shell commands inside the workspace (off by default).',
  cfgSubagentMaxParallel: 'Max parallel subagents (subagent.maxParallel)',
  cfgSubagentMaxParallelDesc: 'Upper bound of concurrently running subagents (1–4).',
  cfgStreamingBatchMs: 'Streaming batch interval (streaming.batchMs)',
  cfgStreamingBatchMsDesc: 'Milliseconds between batched event flushes to the webview.',

  modelsTitle: 'Models',
  modelsHint:
    'Written to models.json; the API key lives only in VS Code SecretStorage — the file keeps a placeholder and the key is never echoed back.',
  modelsSectionApi: 'API Key',
  modelsSectionCompat: 'Compat',
  modelsSectionOauth: 'OAuth',
  mBaseUrl: 'Base URL',
  mModelId: 'Model ID',
  mModelName: 'Display name (optional)',
  mThinking: 'Supports thinking',
  mThinkingLevel: 'Thinking level (persisted to settings.json)',
  mApiKey: 'API Key',
  mApiKeyPlaceholder: 'Leave empty to keep the current key',
  mKeySaved: 'API key stored in SecretStorage',
  mKeyMissing: 'No API key stored yet',
  mThinkingFormat: 'thinkingFormat (thinking field compatibility)',
  mThinkingFormatDefault: 'default (not written; pi-ai default)',
  mSupportsDeveloperRole: 'Supports developer-role messages (uncheck to write false)',
  mCompatHint:
    'Saved into models.json providers[…].compat; defaults are omitted and other compat fields are preserved.',
  mOauthProvider: 'Provider ID',
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
  mcpHint: 'Edit the servers / mcpServers section of mcp.json for third-party MCP servers.',
  mcpHubWarn:
    'AT Series hub.js entries are skipped: the embedded HubHost already covers them, no mcp.json entry needed.',
  mcpRedactHint:
    'Secrets are shown as ***; keeping *** on save preserves the old value, a new value overwrites it.',
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
