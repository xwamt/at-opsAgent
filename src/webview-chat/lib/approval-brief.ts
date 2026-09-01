/**
 * ApprovalBar 纯函数：空要素折叠 + 命令关键词 span（Plan 12 T11）。
 * 不引 Vue/DOM，node 单测可直接 import。
 */

/** 九要素键（与 ApprovalBar ELEMENT_LABELS 对齐，不含 guidedManual）。 */
export const APPROVAL_ELEMENT_KEYS = [
  'goal',
  'evidence',
  'impact',
  'prechecks',
  'backup',
  'commands',
  'successCriteria',
  'rollback',
  'unknowns'
] as const;

/** 统计九要素中空白字段数量（折叠态摘要「未提供 (N 项)」）。 */
export function countBlankApprovalElements(elements: Record<string, unknown> | null | undefined): number {
  const els = elements ?? {};
  return APPROVAL_ELEMENT_KEYS.filter((key) => isBlankApprovalValue(els[key])).length;
}

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

/** 审批命令行序列化（与 ApprovalBar commandLine 对齐）。 */
export function formatApprovalCommandLine(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  const rec = (entry ?? {}) as Record<string, unknown>;
  const tool = rec.tool ? String(rec.tool) : '';
  const command = rec.command ? String(rec.command) : rec.args ? JSON.stringify(rec.args) : '';
  return [tool, command].filter(Boolean).join('  ') || JSON.stringify(rec);
}

const BRIEF_ELEMENT_LABELS: Record<(typeof APPROVAL_ELEMENT_KEYS)[number], string> = {
  goal: '目标',
  evidence: '证据',
  impact: '影响面',
  prechecks: '前置检查',
  backup: '备份',
  commands: '命令集',
  successCriteria: '成功判据',
  rollback: '回滚方案',
  unknowns: '未知项'
};

/** 九要素正文总字符数（折叠区 overflow 判定）。 */
export function briefContentLength(elements: Record<string, unknown> | null | undefined): number {
  const els = elements ?? {};
  let total = 0;
  for (const key of APPROVAL_ELEMENT_KEYS) {
    const value = els[key];
    if (isBlankApprovalValue(value)) {
      continue;
    }
    if (key === 'commands' && Array.isArray(value)) {
      total += value.map(formatApprovalCommandLine).join('\n').length;
    } else {
      total += typeof value === 'string' ? value.length : JSON.stringify(value).length;
    }
  }
  return total;
}

/** 简报是否超出 webview 折叠区建议高度（默认 320 字）。 */
export function isBriefLong(
  elements: Record<string, unknown> | null | undefined,
  threshold = 320
): boolean {
  return briefContentLength(elements) > threshold;
}

/** 审批九要素 → Markdown（openBrief 虚拟文档 / 编辑器深链）。 */
export function formatApprovalBriefMarkdown(brief: {
  id: string;
  risk: string;
  targetLabel: string;
  elements?: Record<string, unknown>;
}): string {
  const lines: string[] = [
    `# 审批简报 · ${brief.targetLabel}`,
    '',
    `- **简报 ID**: \`${brief.id}\``,
    `- **风险**: ${brief.risk}`,
    ''
  ];
  const elements = brief.elements ?? {};
  for (const key of APPROVAL_ELEMENT_KEYS) {
    const value = elements[key];
    if (isBlankApprovalValue(value)) {
      continue;
    }
    const heading = BRIEF_ELEMENT_LABELS[key];
    if (key === 'commands' && Array.isArray(value)) {
      const commands = value.map(formatApprovalCommandLine).filter((line) => line.trim().length > 0);
      if (commands.length === 0) {
        continue;
      }
      lines.push(`## ${heading}`, '', '```', ...commands, '```', '');
      continue;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    lines.push(`## ${heading}`, '', text, '');
  }
  const extras = Object.keys(elements).filter(
    (key) => key !== 'guidedManual' && !APPROVAL_ELEMENT_KEYS.includes(key as (typeof APPROVAL_ELEMENT_KEYS)[number])
  );
  for (const key of extras) {
    const value = elements[key];
    if (isBlankApprovalValue(value)) {
      continue;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    lines.push(`## ${key}`, '', text, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

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
