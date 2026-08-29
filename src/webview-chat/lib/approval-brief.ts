/**
 * ApprovalBar 纯函数：空要素折叠 + 命令关键词 span（Plan 12 T11）。
 * 不引 Vue/DOM，node 单测可直接 import。
 */

/** 无文本的审批要素不渲染 dt/dd（含 undefined / 空白 / 占位破折号 / 空数组）。 */
export function isBlankApprovalValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed === '—';
  }
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((entry) => isBlankApprovalValue(entry));
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}

/**
 * 命令行关键词切 span：`rm` / `kubectl apply` / `delete`。
 * 只标命中片段，不给整段 `<pre>` 换色。较长短语优先。
 */
const COMMAND_KEYWORD = /\bkubectl apply\b|\brm\b|\bdelete\b/g;

export type CommandSegment = { text: string; keyword?: boolean };

export function annotateCommandKeywords(line: string): CommandSegment[] {
  const re = new RegExp(COMMAND_KEYWORD.source, 'g');
  const segs: CommandSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) {
      segs.push({ text: line.slice(last, match.index) });
    }
    segs.push({ text: match[0], keyword: true });
    last = match.index + match[0].length;
  }
  if (last < line.length) {
    segs.push({ text: line.slice(last) });
  }
  if (segs.length === 0) {
    segs.push({ text: line });
  }
  return segs;
}
