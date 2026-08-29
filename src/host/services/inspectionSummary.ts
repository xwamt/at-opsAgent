/**
 * 巡检结论可见性兜底（docs/14 P0-report，vscode-free）：
 * 模型整轮只调工具、不对用户说话时，host 根据本轮工具 preview 合成一份
 * 中文 markdown 巡检结论上屏——先合成再允许 ops_close_playbook 收尾。
 *
 * 只依赖 protocol 的 TranscriptItem 类型；调用方（PlaybookService /
 * ChatService onIdle）通过结构化的 InspectionReportContext 传入 store 与
 * emitAssistantNotice，测试无需 vscode。
 */
import type { TranscriptItem } from '../../protocol';

/** 合成报告的标记（防重：已合成过的结论本身即可见 assistant 正文）。 */
export const SYNTHESIS_MARKER = '（根据工具输出自动汇总）';

/** 可见结论的最低长度（少于此按「没说话」处理）。 */
const MIN_VISIBLE_CHARS = 40;

/** 每个工具 preview 摘录进合成报告的上限。 */
const PREVIEW_CAP = 800;

/** 发现/编排类工具：对结论无信息量，合成时跳过。 */
const NOISE_TOOL_PATTERNS: readonly RegExp[] = [
  /^ops_list_/,
  /^ops_get_tool$/,
  /^ops_search_tools$/,
  /^ops_select/,
  /^ops_read_skill$/,
  /^ops_recall$/,
  /^ops_start_playbook$/,
  /^ops_advance_stage$/,
  /^ops_close_playbook$/
];

function isNoiseTool(name: string): boolean {
  return NOISE_TOOL_PATTERNS.some((re) => re.test(name));
}

/** 最后一条 user 之后的切片（无 user 则整段）。 */
function itemsSinceLastUser(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === 'user') return items.slice(i + 1);
  }
  return items;
}

/** 最后一条 user 之后的 assistant 正文拼接（thinking 永不算可见）。 */
export function visibleAssistantText(items: readonly TranscriptItem[]): string {
  const parts: string[] = [];
  for (const item of itemsSinceLastUser(items)) {
    if (item.kind === 'assistant' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('\n');
}

/** 本轮是否已有可见结论（assistant 正文去空白 ≥ 40 字）。 */
export function hasVisibleReport(items: readonly TranscriptItem[]): boolean {
  return visibleAssistantText(items).trim().length >= MIN_VISIBLE_CHARS;
}

/** preview 摘录：压缩空白、截断到 PREVIEW_CAP。 */
function excerptPreview(preview: string): string {
  const compact = preview.replace(/[ \t]+/g, ' ').trim();
  return compact.length > PREVIEW_CAP ? `${compact.slice(0, PREVIEW_CAP)}…` : compact;
}

/**
 * 根据本轮（最后一条 user 之后）的工具 preview 合成中文巡检结论 markdown。
 * 发现类工具（ops_list_* / ops_get_tool / ops_search_tools / ops_select* /
 * ops_read_skill 等）不进正文；结尾提醒未出现的检查项视为未检查。
 */
export function synthesizeInspectionMarkdown(items: readonly TranscriptItem[]): string {
  const lines: string[] = [`## 巡检结论 ${SYNTHESIS_MARKER}`, ''];
  const tools = itemsSinceLastUser(items).filter(
    (item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool'
  );
  const substantive = tools.filter((item) => !isNoiseTool(item.call.name));
  if (substantive.length === 0) {
    lines.push('本轮没有产生业务工具输出，无法给出任何检查结论。');
  } else {
    lines.push('本轮模型未输出可见结论，以下按工具输出原样汇总（不代表分析判断）：', '');
    for (const item of substantive) {
      const { name, status, preview, errorMessage } = item.call;
      const statusNote = status === 'ok' ? '' : `（${status}${errorMessage ? `：${errorMessage}` : ''}）`;
      lines.push(`### ${name}${statusNote}`, '');
      if (typeof preview === 'string' && preview.trim().length > 0) {
        lines.push('```', excerptPreview(preview), '```', '');
      } else {
        lines.push('（该工具没有输出 preview）', '');
      }
    }
  }
  const skipped = tools.length - substantive.length;
  if (skipped > 0) {
    lines.push(`另有 ${skipped} 次发现/编排类工具调用（select / 目录 / 链路控制），不影响结论。`, '');
  }
  lines.push('**未在上文出现的检查项请视为未检查。**');
  return lines.join('\n');
}

/** ensureVisibleInspectionReport 需要的最小 host 面（HostContext 结构兼容）。 */
export interface InspectionReportContext {
  store: { itemsOf(sessionId?: string): readonly TranscriptItem[] };
  emitAssistantNotice(text: string, sessionId?: string): void;
}

/**
 * 兜底入口：本轮已有可见结论（含此前合成的报告）→ 返回 false 不动；
 * 没有可见结论且本轮有业务工具输出 → 合成报告以 assistant 身份上屏，
 * 返回 true。纯闲聊（本轮无业务工具）不合成，避免短回复被误判。
 */
export function ensureVisibleInspectionReport(
  ctx: InspectionReportContext,
  sessionId: string
): boolean {
  const items = ctx.store.itemsOf(sessionId);
  if (hasVisibleReport(items)) return false;
  const since = itemsSinceLastUser(items);
  // 防重：上一条 assistant 已是合成报告（即便被截短到 <40 字）就不再插。
  for (let i = since.length - 1; i >= 0; i -= 1) {
    const item = since[i];
    if (item.kind === 'assistant') {
      if (item.text.includes(SYNTHESIS_MARKER)) return false;
      break;
    }
  }
  const hasSubstantiveTool = since.some(
    (item) => item.kind === 'tool' && !isNoiseTool(item.call.name)
  );
  if (!hasSubstantiveTool) return false;
  ctx.emitAssistantNotice(synthesizeInspectionMarkdown(items), sessionId);
  return true;
}
