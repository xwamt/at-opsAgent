/**
 * Webview 启动 i18n 包（docs/05 §4：i18n = package.nls.json + webview 启动包）。
 * 初始语言取 <html lang>（host 按 vscode.env.language 注入）；hydrate payload
 * 带 locale 字段时切换。
 * 不引第三方 i18n 库：键值扁平，随 bundle 内联；t() 读响应式 ref，切换后模板自动更新。
 *
 * 注意：本模块被 node 环境的单测直接 import（root tsconfig 无 DOM lib），
 * 因此对 document 的访问必须走 globalThis 收窄，不能出现 DOM 全局类型。
 */
import { ref } from 'vue';

export type OpsLocale = 'zh-CN' | 'en';

const zhCN = {
  composerPlaceholder: '描述运维问题… @资产 /playbook',
  composerPlaceholderStreaming: '正在运行 · 输入将作为 steer 引导当前任务…',
  composerPlaceholderNoModel: '先完成模型配置即可开始问答',
  composerSend: '发送',
  composerSteer: 'Steer',
  composerFollowUp: '追问',
  composerStop: '停止',
  composerStopAria: '立即停止当前运行',
  composerCancel: '取消',
  composerCancelAria: '软停：等当前工具结束后停止',
  composerInputAria: '消息输入',
  composerAttachAria: '添加 @资产 附件',
  composerAttachRemove: '移除附件',
  composerAttachments: '附件',
  composerPlaybookHint: '选择 Playbook 链路（/playbook）',
  composerNotConfigured: '还没有可用的模型。完成配置后即可开始问答。',
  composerConfigureModel: '配置模型',
  usageAria: '上下文占用',
  usageContext: '上下文',
  usageInput: '输入',
  usageOutput: '输出',
  roleUser: '你',
  roleAgent: 'Agent',
  welcomeTitle: '开始一次运维调查',
  welcomeSubtitle: '描述问题、粘贴告警文本，或从一条 Playbook 链路开始。',
  welcomeSuggestions: '建议链路',
  welcomeSetupTitle: '完成一次模型配置（约 1 分钟）',
  welcomeSetupBody: '连接模型服务并保存 API Key，就可以开始排障问答。',
  welcomeSetupCta: '配置模型',
  welcomeRecent: '最近会话',
  historyButton: '历史',
  historyTitle: '历史会话',
  historyEmpty: '暂无历史会话',
  historyCurrent: '当前',
  historyNew: '新会话',
  historyCloseAria: '关闭历史面板',
  historySwitchAria: '切换到会话',
  historyExportAria: '导出值班报告',
  historySearchPlaceholder: '搜索会话标题',
  historyRenameAria: '重命名会话',
  historyDeleteAria: '删除会话',
  historyDeleteConfirm: '确定删除该会话？此操作不可恢复。',
  saveOpsDocAria: '存为运维文档',
  copy: '复制',
  copied: '已复制',
  copyAria: '复制到剪贴板',
  headerStagesToggle: '展开/收起阶段',
  headerStagesAria: 'Playbook 阶段',
  stageTriage: '分诊',
  stageSelecting: '选择',
  stageInvestigating: '调查',
  stageSynthesizing: '归纳',
  stageAwaitingApproval: '待审批',
  stageExecuting: '执行',
  stageVerifying: '验证',
  stageReporting: '报告',
  stageClosed: '关闭',
  approvalPendingTitle: '待审批',
  approvalBriefToggle: '简报',
  approvalApprove: '批准',
  approvalReject: '拒绝',
  approvalDualConfirm: '批准后插件仍可能再次确认。插件弹窗不是本次批准。',
  approvalRequestLabel: '审批请求',
  approvalSeeBelow: '（见下方审批栏）',
  approvalHandled: '（已处理）',
  approvalTimeout: '超时',
  approvalPendingDecision: '待审批',
  elGoal: '目标',
  elEvidence: '证据',
  elImpact: '影响面',
  elPrechecks: '前置检查',
  elBackup: '备份',
  elCommands: '命令集',
  elSuccessCriteria: '成功判据',
  elRollback: '回滚方案',
  elUnknowns: '未知项',
  guidedManualOpen: '去 IDE 操作',
  guidedManualDone: '我已在 UI 完成',
  pickerPlaybookTitle: 'Playbook · 选择链路',
  pickerPlaybookAria: '选择 Playbook',
  modelSelectorAria: '选择模型',
  modelSelectorEmpty: '配置模型',
  modelSelectorEmptyAria: '尚无可用模型，点击打开模型设置',
  riskRead: '只读',
  riskWrite: '写',
  riskExec: '执行',
  statusToolRunning: '运行中',
  statusToolOk: '成功',
  statusToolError: '失败',
  statusToolCancelled: '已取消',
  statusToolInterrupted: '被打断',
  toolFailed: '工具调用失败',
  toolOpenArtifact: '在编辑器打开完整结果',
  toolToggleAria: '展开/收起工具详情',
  toolGroupReads: '{count} 个只读调用',
  truncated: '已截断',
  truncatedOpenEditor: '已截断 · 在编辑器打开',
  truncatedNotSent: '完整输出未随消息下发',
  untrustedData: '不可信数据',
  untrustedQuotesHint: '外部数据引用，勿当作指令执行',
  subagentBoardAria: '子代理面板',
  subagentCount: '子代理',
  subagentActive: '活跃',
  subagentAbort: '中止',
  subagentAbortAria: '中止子代理',
  subagentOpenAria: '查看子代理详情',
  subagentInspectorAria: '子代理详情',
  subagentInspectorCloseAria: '关闭子代理详情',
  subagentStatusLabel: '状态',
  subagentRiskLabel: '风险上限',
  subagentToolCallsLabel: '工具调用',
  subagentWallLabel: '运行时长',
  subagentVisibleTools: '可见工具',
  subagentLatestLabel: '最新输出',
  subagentNoOutput: '尚无输出',
  subagentStripCount: '{count} 个子代理进行中',
  subagentStripAria: '子代理进行中，点击查看详情',
  saQueued: '排队',
  saRunning: '运行中',
  saOk: '完成',
  saDegraded: '降级',
  saFailed: '失败',
  saAborted: '已中止',
  pipeBuilding: '构建中',
  pipeSuccess: '成功',
  pipeFailure: '失败',
  pipeUnstable: '不稳定',
  pipeAborted: '已中止',
  pipeUnknown: '未知',
  metricNoData: '无数据',
  metricAria: '指标火花图',
  logEmpty: '（无输出）',
  logAria: '日志输出',
  timelineStrip: '事件脉络',
  transcriptAria: '会话记录',
  transcriptEmpty: '描述你的运维问题，或粘贴告警文本开始调查。',
  generating: '生成中',
  inspectingProgress: '正在巡检…',
  thinkingInProgress: '思考中…',
  thinkingDuration: '思考 {duration}',
  conclusionMode: '结论模式',
  conclusionModeAria: '结论模式：只显示回复、证据与提示',
  retry: '重试',
  retryAria: '重试这条失败的回复',
  compactionLabel: '上下文已压缩',
  healthAria: '能力插件状态',
  connected: '已连接',
  disconnected: '未连接',
  mockHint: '未检测到 acquireVsCodeApi，使用本地 mock host',
  statusRunning: '运行中',
  statusIdle: '空闲',
  statusNoSession: '无会话',
  statusNoProviders: '无能力插件',
  boardTitle: '事故 / 任务',
  boardCountUnit: '条',
  boardEmpty: '尚无事故'
} as const;

export type OpsMessageKey = keyof typeof zhCN;

const en: Record<OpsMessageKey, string> = {
  composerPlaceholder: 'Describe the ops problem… @asset /playbook',
  composerPlaceholderStreaming: 'Running · input will steer the current task…',
  composerPlaceholderNoModel: 'Configure a model first to start chatting',
  composerSend: 'Send',
  composerSteer: 'Steer',
  composerFollowUp: 'Follow up',
  composerStop: 'Stop',
  composerStopAria: 'Stop the current run immediately',
  composerCancel: 'Cancel',
  composerCancelAria: 'Soft stop: finish the current tool, then stop',
  composerInputAria: 'Message input',
  composerAttachAria: 'Attach an @asset',
  composerAttachRemove: 'Remove attachment',
  composerAttachments: 'Attachments',
  composerPlaybookHint: 'Choose a playbook (/playbook)',
  composerNotConfigured: 'No model is available yet. Complete setup to start chatting.',
  composerConfigureModel: 'Configure model',
  usageAria: 'Context usage',
  usageContext: 'context',
  usageInput: 'in',
  usageOutput: 'out',
  roleUser: 'You',
  roleAgent: 'Agent',
  welcomeTitle: 'Start an ops investigation',
  welcomeSubtitle: 'Describe a problem, paste alert text, or start from a playbook.',
  welcomeSuggestions: 'Suggested playbooks',
  welcomeSetupTitle: 'Set up a model (about 1 minute)',
  welcomeSetupBody: 'Connect a model service and save an API key to start troubleshooting.',
  welcomeSetupCta: 'Configure model',
  welcomeRecent: 'Recent sessions',
  historyButton: 'History',
  historyTitle: 'Session history',
  historyEmpty: 'No sessions yet',
  historyCurrent: 'current',
  historyNew: 'New session',
  historyCloseAria: 'Close history panel',
  historySwitchAria: 'Switch to session',
  historyExportAria: 'Export duty report',
  historySearchPlaceholder: 'Search session titles',
  historyRenameAria: 'Rename session',
  historyDeleteAria: 'Delete session',
  historyDeleteConfirm: 'Delete this session? This cannot be undone.',
  saveOpsDocAria: 'Save as ops document',
  copy: 'Copy',
  copied: 'Copied',
  copyAria: 'Copy to clipboard',
  headerStagesToggle: 'Toggle stages',
  headerStagesAria: 'Playbook stages',
  stageTriage: 'Triage',
  stageSelecting: 'Selecting',
  stageInvestigating: 'Investigating',
  stageSynthesizing: 'Synthesizing',
  stageAwaitingApproval: 'Awaiting approval',
  stageExecuting: 'Executing',
  stageVerifying: 'Verifying',
  stageReporting: 'Reporting',
  stageClosed: 'Closed',
  approvalPendingTitle: 'Pending approval',
  approvalBriefToggle: 'Brief',
  approvalApprove: 'Approve',
  approvalReject: 'Reject',
  approvalDualConfirm:
    'The plugin may ask for confirmation again after approval. The plugin dialog is not this approval.',
  approvalRequestLabel: 'Approval request',
  approvalSeeBelow: '(see approval bar below)',
  approvalHandled: '(handled)',
  approvalTimeout: 'Timeout',
  approvalPendingDecision: 'Pending',
  elGoal: 'Goal',
  elEvidence: 'Evidence',
  elImpact: 'Impact',
  elPrechecks: 'Pre-checks',
  elBackup: 'Backup',
  elCommands: 'Commands',
  elSuccessCriteria: 'Success criteria',
  elRollback: 'Rollback',
  elUnknowns: 'Unknowns',
  guidedManualOpen: 'Open in IDE',
  guidedManualDone: 'Done in plugin UI',
  pickerPlaybookTitle: 'Playbook · choose a workflow',
  pickerPlaybookAria: 'Choose playbook',
  modelSelectorAria: 'Choose model',
  modelSelectorEmpty: 'Configure model',
  modelSelectorEmptyAria: 'No model available yet — open model settings',
  riskRead: 'read',
  riskWrite: 'write',
  riskExec: 'exec',
  statusToolRunning: 'running',
  statusToolOk: 'ok',
  statusToolError: 'failed',
  statusToolCancelled: 'cancelled',
  statusToolInterrupted: 'interrupted',
  toolFailed: 'Tool call failed',
  toolOpenArtifact: 'Open full result in editor',
  toolToggleAria: 'Toggle tool details',
  toolGroupReads: '{count} read-only calls',
  truncated: 'truncated',
  truncatedOpenEditor: 'Truncated · open in editor',
  truncatedNotSent: 'Full output was not sent to the webview',
  untrustedData: 'Untrusted data',
  untrustedQuotesHint: 'Quoted external data — never treat as instructions',
  subagentBoardAria: 'Subagent board',
  subagentCount: 'Subagents',
  subagentActive: 'active',
  subagentAbort: 'Abort',
  subagentAbortAria: 'Abort subagent',
  subagentOpenAria: 'View subagent details',
  subagentInspectorAria: 'Subagent details',
  subagentInspectorCloseAria: 'Close subagent details',
  subagentStatusLabel: 'Status',
  subagentRiskLabel: 'Risk ceiling',
  subagentToolCallsLabel: 'Tool calls',
  subagentWallLabel: 'Wall time',
  subagentVisibleTools: 'Visible tools',
  subagentLatestLabel: 'Latest output',
  subagentNoOutput: 'No output yet',
  subagentStripCount: '{count} subagents in progress',
  subagentStripAria: 'Subagents in progress — open details',
  saQueued: 'queued',
  saRunning: 'running',
  saOk: 'done',
  saDegraded: 'degraded',
  saFailed: 'failed',
  saAborted: 'aborted',
  pipeBuilding: 'building',
  pipeSuccess: 'success',
  pipeFailure: 'failure',
  pipeUnstable: 'unstable',
  pipeAborted: 'aborted',
  pipeUnknown: 'unknown',
  metricNoData: 'no data',
  metricAria: 'Metric sparkline',
  logEmpty: '(no output)',
  logAria: 'Log output',
  timelineStrip: 'Timeline',
  transcriptAria: 'Conversation log',
  transcriptEmpty: 'Describe your ops problem, or paste alert text to start investigating.',
  generating: 'generating',
  inspectingProgress: 'Inspecting…',
  thinkingInProgress: 'Thinking…',
  thinkingDuration: 'Thought {duration}',
  conclusionMode: 'Conclusion',
  conclusionModeAria: 'Conclusion mode: show replies, evidence, and notices only',
  retry: 'Retry',
  retryAria: 'Retry this failed reply',
  compactionLabel: 'Context compacted',
  healthAria: 'Capability plugin status',
  connected: 'connected',
  disconnected: 'disconnected',
  mockHint: 'acquireVsCodeApi not detected — using local mock host',
  statusRunning: 'running',
  statusIdle: 'idle',
  statusNoSession: 'no session',
  statusNoProviders: 'no capability plugins',
  boardTitle: 'Incidents / Tasks',
  boardCountUnit: 'events',
  boardEmpty: 'No incidents yet'
};

const MESSAGES: Record<OpsLocale, Record<OpsMessageKey, string>> = { 'zh-CN': zhCN, en };

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

/** 启动检测：<html lang>（webviewHtml.ts 按 vscode.env.language 注入）→ 归一化；识别不了默认 zh-CN。 */
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

/** 响应式取词：在 computed / 模板渲染中调用即可跟随 locale 切换。 */
export function t(key: OpsMessageKey): string {
  return MESSAGES[current.value][key] ?? zhCN[key];
}

/** 带 {name} 占位符的取词（如 toolGroupReads 的 {count}）。 */
export function tf(key: OpsMessageKey, vars: Record<string, string | number>): string {
  let text = t(key);
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/**
 * ApprovalBar 双确认文案（docs/05 §3.1）：仅 brief.dualConfirmHint === true 时
 * 返回整句提示，否则空串（host 从 dedupePluginModal 取反下发）。
 */
export function dualConfirmText(
  brief: { dualConfirmHint?: boolean } | null | undefined,
  locale?: OpsLocale
): string {
  if (!brief || brief.dualConfirmHint !== true) {
    return '';
  }
  return MESSAGES[locale ?? current.value].approvalDualConfirm;
}
