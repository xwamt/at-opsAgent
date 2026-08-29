/**
 * 运维文档落盘（docs/15 P1-4）：只写 ops-docs/ 白名单目录。
 *
 * 本文件禁止 import vscode。路径校验 / 补「未检查」段 / 刮密是纯函数；
 * 真正 fs.writeFile 在 host `writeOpsDoc` handler（applyToolGate 批准之后）。
 * 绝不注入 pi write/edit/bash。
 */
import { isAbsolute, resolve, sep } from 'node:path';

import type { OpsCustomToolSpec } from './resource-loader';
import { redactSecrets } from './sanitize';

export const WRITE_OPS_DOC_TOOL_NAME = 'ops_write_ops_doc';

/** 单文件上限 256KB（utf8 字节）。 */
export const OPS_DOC_MAX_BYTES = 256 * 1024;

export const OPS_DOC_TYPES = [
  'operation-record',
  'troubleshooting-report',
  'deployment',
  'inspection-report',
  'handoff',
  'emergency-plan'
] as const;

export type OpsDocType = (typeof OPS_DOC_TYPES)[number];

/** 六类模板共用的必填 ## 标题（缺则补「未检查」）。 */
export const OPS_DOC_HEADINGS = [
  '文档信息',
  '背景目标',
  '现状证据',
  '步骤',
  '验证',
  '回滚',
  '交接'
] as const;

export type WriteOpsDocRequest = {
  docType: OpsDocType;
  title: string;
  markdown: string;
  overwritePath?: string;
};

export type WriteOpsDocResult =
  | { ok: true; path: string; markdown: string }
  | { ok: false; error: string };

export type WriteOpsDocHandler = (
  req: WriteOpsDocRequest
) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;

export function isOpsDocType(value: unknown): value is OpsDocType {
  return typeof value === 'string' && (OPS_DOC_TYPES as readonly string[]).includes(value);
}

/** 标题 → 文件名片段：保留字母数字与 CJK，其余收成连字符。 */
export function slugTitle(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s.length > 0 ? s : 'untitled';
}

export function defaultOpsDocRelPath(title: string, now = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}/${slugTitle(title)}.md`;
}

/**
 * 缺 ## 标题则追加 `## X\n\n（未检查）\n`。docType 预留（六类共用同一组标题）。
 */
export function ensureTemplateHeadings(markdown: string, _docType?: OpsDocType): string {
  let out = markdown.replace(/\s+$/, '');
  for (const heading of OPS_DOC_HEADINGS) {
    const re = new RegExp(`^##\\s*${heading}\\s*$`, 'm');
    if (re.test(out)) continue;
    out = `${out}${out.length > 0 ? '\n\n' : ''}## ${heading}\n\n（未检查）\n`;
  }
  return out.endsWith('\n') ? out : `${out}\n`;
}

function hasDotDot(relPath: string): boolean {
  return relPath.split(/[/\\]/).some((segment) => segment === '..');
}

function isUnderRoot(rootAbs: string, abs: string): boolean {
  return abs === rootAbs || abs.startsWith(rootAbs + sep);
}

/**
 * overwritePath → 绝对路径：必须落在 docsRoot 下。
 * 相对路径按 docsRoot 解析；绝对路径也要 prefix-ok。拒绝 ..、反斜杠、NUL。
 */
export function resolveOpsDocOverwrite(docsRoot: string, overwritePath: string): string | undefined {
  const trimmed = overwritePath.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes('\0') || trimmed.includes('\\')) return undefined;
  if (hasDotDot(trimmed)) return undefined;
  const rootAbs = resolve(docsRoot);
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootAbs, trimmed);
  if (!isUnderRoot(rootAbs, abs) || abs === rootAbs) return undefined;
  return abs;
}

export type PrepareWriteOpsDocResult =
  | { ok: true; absPath: string; markdown: string; relPath: string }
  | { ok: false; error: string };

/**
 * 校验路径、刮密、补必填段。不写盘。
 * docsRoot = `<workspace>/ops-docs` 或 `~/.at-series/agent/ops-docs`。
 */
export function prepareWriteOpsDoc(
  docsRoot: string,
  req: WriteOpsDocRequest,
  now = new Date()
): PrepareWriteOpsDocResult {
  if (!isOpsDocType(req.docType)) {
    return { ok: false, error: `docType 不合法：只允许 ${OPS_DOC_TYPES.join(' / ')}。` };
  }
  const title = typeof req.title === 'string' ? req.title.trim() : '';
  if (title.length === 0) {
    return { ok: false, error: 'title 不能为空。' };
  }
  const rawMarkdown = typeof req.markdown === 'string' ? req.markdown : '';
  const redacted = redactSecrets(rawMarkdown).text;
  const markdown = ensureTemplateHeadings(redacted, req.docType);
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > OPS_DOC_MAX_BYTES) {
    return {
      ok: false,
      error: `文档 ${bytes} 字节，超过 ${OPS_DOC_MAX_BYTES} 上限（256KB）。`
    };
  }

  const rootAbs = resolve(docsRoot);
  let absPath: string;
  let relPath: string;
  const overwrite = typeof req.overwritePath === 'string' ? req.overwritePath.trim() : '';
  if (overwrite.length > 0) {
    const resolved = resolveOpsDocOverwrite(rootAbs, overwrite);
    if (resolved === undefined) {
      return {
        ok: false,
        error: `overwritePath "${overwrite}" 不合法：必须落在 ops-docs/ 下（禁止 .. 与白名单外绝对路径）。`
      };
    }
    absPath = resolved;
    relPath = absPath.startsWith(rootAbs + sep) ? absPath.slice(rootAbs.length + 1) : overwrite;
  } else {
    relPath = defaultOpsDocRelPath(title, now);
    absPath = resolve(rootAbs, relPath);
    if (!isUnderRoot(rootAbs, absPath)) {
      return { ok: false, error: '默认路径解析后不在 ops-docs/ 内。' };
    }
  }
  return { ok: true, absPath, markdown, relPath };
}

/** 审批简报 commands：将写入 path（+N/-M 行）+ 前 40 行。 */
export function formatOpsDocApprovalCommands(
  args: Record<string, unknown>,
  existingLineCount = 0
): string {
  const title = typeof args.title === 'string' && args.title.trim().length > 0 ? args.title : 'untitled';
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const overwrite =
    typeof args.overwritePath === 'string' && args.overwritePath.trim().length > 0
      ? args.overwritePath.trim()
      : undefined;
  const rel = overwrite ?? defaultOpsDocRelPath(title);
  const newLines = markdown.length === 0 ? 0 : markdown.split(/\r?\n/).length;
  const added = Math.max(0, newLines - existingLineCount);
  const removed = Math.max(0, existingLineCount - newLines);
  const head = markdown.split(/\r?\n/).slice(0, 40).join('\n');
  return `将写入 \`${rel}\`（+${added}/-${removed} 行）\n${head}`;
}

export function parseWriteOpsDocArgs(
  args: Record<string, unknown>
): WriteOpsDocRequest | { ok: false; error: string } {
  if (!isOpsDocType(args.docType)) {
    return { ok: false, error: `docType 不合法：只允许 ${OPS_DOC_TYPES.join(' / ')}。` };
  }
  const title = typeof args.title === 'string' ? args.title : '';
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const overwritePath =
    typeof args.overwritePath === 'string' && args.overwritePath.trim().length > 0
      ? args.overwritePath
      : undefined;
  return {
    docType: args.docType,
    title,
    markdown,
    ...(overwritePath !== undefined ? { overwritePath } : {})
  };
}

/** ops_write_ops_doc：execute 只调 host handler，不在 runtime 写盘。 */
export function createWriteOpsDocTool(writeOpsDoc: WriteOpsDocHandler): OpsCustomToolSpec {
  return {
    name: WRITE_OPS_DOC_TOOL_NAME,
    label: 'Ops：写入运维文档',
    description:
      '把巡检/排障/交接等运维文档写入工作区 ops-docs/YYYY/MM/ 下的 Markdown（无工作区则写入 ~/.at-series/agent/ops-docs/）。' +
      '先用 ops_read_skill 读 ops-documents/<docType>.md 模板，再调用本工具。不要 bash / 不要通用写文件。' +
      'write 风险：需会话内审批；路径仅限 ops-docs/，单文件 256KB。',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {
        docType: {
          type: 'string',
          enum: [...OPS_DOC_TYPES],
          description:
            '文档类型：operation-record / troubleshooting-report / deployment / inspection-report / handoff / emergency-plan'
        },
        title: { type: 'string', description: '文档标题（用于文件名 slug）' },
        markdown: { type: 'string', description: 'Markdown 正文（缺必填 ## 段会自动补「未检查」）' },
        overwritePath: {
          type: 'string',
          description: '可选：覆盖已有文件。必须仍在 ops-docs/ 下（相对或绝对且 prefix-ok）'
        }
      },
      required: ['docType', 'title', 'markdown'],
      additionalProperties: false
    },
    execute: async (args) => {
      const parsed = parseWriteOpsDocArgs(args);
      if ('ok' in parsed && parsed.ok === false) return JSON.stringify(parsed);
      return JSON.stringify(await writeOpsDoc(parsed as WriteOpsDocRequest));
    }
  };
}
