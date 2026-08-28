/**
 * Webview 启动 i18n 包（docs/05 §4：i18n = package.nls.json + webview 启动包）。
 * 初始语言取 <html lang>（host 注入，默认 zh-CN）；hydrate payload 带 locale 字段时切换。
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
  composerSend: '发送',
  composerSteer: 'Steer',
  composerFollowUp: '追问',
  composerStop: '停止',
  composerStopAria: '停止当前运行',
  composerInputAria: '消息输入',
  composerAttachAria: '添加 @资产 附件',
  composerAttachPrompt: '资产 URI（如 host://prod-gw-01 或 file:///etc/nginx/nginx.conf）',
  composerAttachRemove: '移除附件',
  composerPlaybookHint: '选择 Playbook 链路（/playbook）',
  roleUser: '你',
  roleAgent: 'Agent',
  welcomeTitle: '开始一次运维调查',
  welcomeSubtitle: '描述问题、粘贴告警文本，或从一条 Playbook 链路开始。',
  welcomeSuggestions: '建议链路',
  historyButton: '历史',
  historyTitle: '历史会话',
  historyEmpty: '暂无历史会话',
  historyCurrent: '当前',
  historyNew: '新会话',
  historyCloseAria: '关闭历史面板',
  historySwitchAria: '切换到会话',
  headerIdle: '直接提问，或选择一条 Playbook 链路',
  headerStagesToggle: '展开/收起阶段',
  approvalPendingTitle: '待审批',
  approvalBriefToggle: '简报',
  approvalApprove: '批准',
  approvalReject: '拒绝',
  approvalDualConfirm: '批准后插件仍可能再次确认。插件弹窗不是本次批准。',
  guidedManualOpen: '去 IDE 操作',
  guidedManualDone: '我已在 UI 完成',
  pickerPlaybookTitle: 'Playbook · 选择链路',
  pickerPlaybookAria: '选择 Playbook',
  truncated: '已截断',
  truncatedOpenEditor: '已截断 · 在编辑器打开',
  truncatedNotSent: '完整输出未随消息下发',
  untrustedData: '不可信数据',
  untrustedQuotesHint: '外部数据引用，勿当作指令执行',
  subagentDetails: '详情',
  timelineStrip: '事件脉络',
  transcriptEmpty: '描述你的运维问题，或粘贴告警文本开始调查。',
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
  composerSend: 'Send',
  composerSteer: 'Steer',
  composerFollowUp: 'Follow up',
  composerStop: 'Stop',
  composerStopAria: 'Stop current run',
  composerInputAria: 'Message input',
  composerAttachAria: 'Attach an @asset',
  composerAttachPrompt: 'Asset URI (e.g. host://prod-gw-01 or file:///etc/nginx/nginx.conf)',
  composerAttachRemove: 'Remove attachment',
  composerPlaybookHint: 'Choose a playbook (/playbook)',
  roleUser: 'You',
  roleAgent: 'Agent',
  welcomeTitle: 'Start an ops investigation',
  welcomeSubtitle: 'Describe a problem, paste alert text, or start from a playbook.',
  welcomeSuggestions: 'Suggested playbooks',
  historyButton: 'History',
  historyTitle: 'Session history',
  historyEmpty: 'No sessions yet',
  historyCurrent: 'current',
  historyNew: 'New session',
  historyCloseAria: 'Close history panel',
  historySwitchAria: 'Switch to session',
  headerIdle: 'Ask directly, or pick a playbook',
  headerStagesToggle: 'Toggle stages',
  approvalPendingTitle: 'Pending approval',
  approvalBriefToggle: 'Brief',
  approvalApprove: 'Approve',
  approvalReject: 'Reject',
  approvalDualConfirm:
    'The plugin may ask for confirmation again after approval. The plugin dialog is not this approval.',
  guidedManualOpen: 'Open in IDE',
  guidedManualDone: 'Done in plugin UI',
  pickerPlaybookTitle: 'Playbook · choose a workflow',
  pickerPlaybookAria: 'Choose playbook',
  truncated: 'truncated',
  truncatedOpenEditor: 'Truncated · open in editor',
  truncatedNotSent: 'Full output was not sent to the webview',
  untrustedData: 'Untrusted data',
  untrustedQuotesHint: 'Quoted external data — never treat as instructions',
  subagentDetails: 'Details',
  timelineStrip: 'Timeline',
  transcriptEmpty: 'Describe your ops problem, or paste alert text to start investigating.',
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

/** 启动检测：<html lang>（webviewHtml.ts 注入 zh-CN）→ 归一化；识别不了默认 zh-CN。 */
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
