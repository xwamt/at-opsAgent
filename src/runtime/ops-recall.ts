/**
 * 长期记忆只读层（Plan 12 T1 / T8）：environment 别名、incidents 索引、
 * ops_recall 子串检索、巡检结论行级 diff。
 *
 * 禁止 import vscode。模型不能写 environment.json；runtime 只读
 * memoryDir（node:fs）。写入 environment 走 host 命令；incidents 仅在
 * 用户确认 notice 后由 host 追加一行。禁止从工具 preview 自动抽记忆。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { OpsCustomToolSpec } from './resource-loader';
import { redactSecrets } from './sanitize';

export const RECALL_TOOL_NAME = 'ops_recall';

/** incidents/index.md 硬顶（含空行）。第 201 行拒绝追加。 */
export const INCIDENT_INDEX_MAX_LINES = 200;

/** ops_recall 回给模型的命中行上限。 */
export const RECALL_MAX_LINES = 8;

/** 巡检历史 diff notice 最多展示的 `+新增`/`-消失` 行。 */
export const INSPECTION_DIFF_MAX_LINES = 20;

const SECRET_FIELD_KEYS = /^(api[_-]?key|secret|password|passwd|token|credential|private[_-]?key)$/i;

export function defaultHomeMemoryDir(): string {
  return join(homedir(), '.at-series', 'agent', 'memory');
}

/** workspace 优先 `<ws>/memory`，否则 `~/.at-series/agent/memory/`。 */
export function resolveMemoryDir(workspaceRoot?: string): string {
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim().length > 0) {
    return join(workspaceRoot.trim(), 'memory');
  }
  return defaultHomeMemoryDir();
}

export function environmentJsonPath(memoryDir: string): string {
  return join(memoryDir, 'environment.json');
}

export function incidentsIndexPath(memoryDir: string): string {
  return join(memoryDir, 'incidents', 'index.md');
}

export function opsNotesPath(memoryDir: string): string {
  return join(memoryDir, 'OPS.md');
}

export type EnvironmentAliases = Record<string, string>;

export type PrepareEnvironmentResult =
  | { ok: true; aliases: EnvironmentAliases; json: string }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 保存 environment.json：必须是 `{ "别名": "说明" }` 扁平字符串表。
 * 密钥字段名或值里的秘密（redactSecrets hits）一律拒绝，不落盘。
 */
export function prepareEnvironmentSave(raw: string): PrepareEnvironmentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: 'environment.json 不是合法 JSON' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'environment.json 必须是对象（别名 → 说明）' };
  }
  const aliases: EnvironmentAliases = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      return { ok: false, error: '别名键不能为空' };
    }
    if (SECRET_FIELD_KEYS.test(key.trim())) {
      return { ok: false, error: `拒绝秘密字段 "${key}"：环境表只允许主机/集群别名` };
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `别名 "${key}" 的值必须是字符串` };
    }
    const scrubbed = redactSecrets(value);
    if (scrubbed.hits > 0) {
      return { ok: false, error: `别名 "${key}" 的说明含密钥/口令/token，已拒绝写入` };
    }
    aliases[key] = value;
  }
  const keyBlob = redactSecrets(Object.keys(aliases).join('\n'));
  if (keyBlob.hits > 0) {
    return { ok: false, error: '别名键含密钥片段，已拒绝写入' };
  }
  return { ok: true, aliases, json: `${JSON.stringify(aliases, null, 2)}\n` };
}

/** 读 environment.json；缺失 / 非法 / 空对象 → undefined（L-env 不提 aliases）。 */
export function loadEnvironmentAliases(memoryDir: string): EnvironmentAliases | undefined {
  let raw: string;
  try {
    raw = readFileSync(environmentJsonPath(memoryDir), 'utf8');
  } catch {
    return undefined;
  }
  const prepared = prepareEnvironmentSave(raw);
  if (!prepared.ok) return undefined;
  return Object.keys(prepared.aliases).length > 0 ? prepared.aliases : undefined;
}

export type RecallHit = { source: 'index' | 'environment'; line: string };

function readTextIfExists(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function substringMatch(haystack: string, query: string): boolean {
  if (query.length === 0) return false;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/** 对 index.md + environment.json 子串匹配，最多 RECALL_MAX_LINES 行。 */
export function recallFromDir(memoryDir: string, query: string): RecallHit[] {
  const q = query.trim();
  if (q.length === 0) return [];
  const hits: RecallHit[] = [];

  const indexText = readTextIfExists(incidentsIndexPath(memoryDir));
  if (indexText !== undefined) {
    for (const line of indexText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (substringMatch(trimmed, q)) {
        hits.push({ source: 'index', line: trimmed });
        if (hits.length >= RECALL_MAX_LINES) return hits;
      }
    }
  }

  const aliases = loadEnvironmentAliases(memoryDir);
  if (aliases !== undefined) {
    for (const [key, value] of Object.entries(aliases)) {
      const line = `${key}: ${value}`;
      if (substringMatch(key, q) || substringMatch(value, q)) {
        hits.push({ source: 'environment', line });
        if (hits.length >= RECALL_MAX_LINES) return hits;
      }
    }
  }

  return hits;
}

export type RecallToolResult = {
  ok: true;
  query: string;
  lines: string[];
  notice?: string;
};

export function formatRecallResult(query: string, hits: RecallHit[]): RecallToolResult {
  const lines = hits.map((h) => h.line).slice(0, RECALL_MAX_LINES);
  if (lines.length === 0) {
    return {
      ok: true,
      query,
      lines: [],
      notice: '无匹配。可检查 memory/incidents/index.md 与 environment.json（模型不能写环境表）。'
    };
  }
  return { ok: true, query, lines };
}

export type RecallToolOptions = {
  /** host 代读；优先于 memoryDir 本地 fs。 */
  recallMemory?: (query: string) => Promise<string>;
  /** runtime 用 node:fs 读该目录（禁止 vscode）。 */
  memoryDir?: () => string;
};

/** ops_recall：仅主会话注册的 gated extraTool（risk=read）。 */
export function createRecallTool(opts: RecallToolOptions = {}): OpsCustomToolSpec {
  return {
    name: RECALL_TOOL_NAME,
    label: 'Ops：检索长期记忆',
    description:
      '对 memory/incidents/index.md 与 memory/environment.json 做子串匹配，返回最多 8 行。' +
      '用于查历史事故索引与用户确认的集群别名。不要把工具结果写入记忆；' +
      'environment.json 只能由用户经命令编辑，模型不能写。',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '子串（主机名、集群别名、事故关键词）' }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async (args) => {
      const query = String(args.query ?? '');
      if (typeof opts.recallMemory === 'function') {
        return opts.recallMemory(query);
      }
      const dir = opts.memoryDir?.() ?? defaultHomeMemoryDir();
      return JSON.stringify(formatRecallResult(query, recallFromDir(dir, query)));
    }
  };
}

export function countIndexLines(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

export type AppendIncidentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * 追加一行到 incidents/index.md。已有 200 行则失败（第 201 行拒绝）。
 * 不自动写盘——调用方在用户点「是」之后才 fs.append。
 */
export function appendIncidentIndexLine(existing: string, line: string): AppendIncidentResult {
  const count = countIndexLines(existing);
  if (count >= INCIDENT_INDEX_MAX_LINES) {
    return {
      ok: false,
      error: `incidents/index.md 已有 ${count} 行（上限 ${INCIDENT_INDEX_MAX_LINES}），请先归档后再追加。`
    };
  }
  const trimmed = line.replace(/\s+$/, '');
  const base = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  return { ok: true, text: `${base}${trimmed}\n` };
}

export function formatIncidentIndexLine(input: {
  date: string;
  sentence: string;
  relativePath: string;
}): string {
  const sentence = input.sentence.replace(/\s+/g, ' ').trim();
  return `${input.date} ${sentence} ${input.relativePath}`;
}

/**
 * 用户确认后写 index 一行 + 结论文件。已满 200 行则两处都不写。
 * runtime 工具不得调用本函数；仅 host 在 notice「是」之后调用。
 */
export function commitIncidentAppend(
  memoryDir: string,
  input: { relativePath: string; indexLine: string; conclusionMarkdown: string }
): { ok: true; indexPath: string; filePath: string } | { ok: false; error: string } {
  const indexPath = incidentsIndexPath(memoryDir);
  const existing = readTextIfExists(indexPath) ?? '';
  const appended = appendIncidentIndexLine(existing, input.indexLine);
  if (!appended.ok) return appended;
  const filePath = join(memoryDir, input.relativePath);
  const body = redactSecrets(input.conclusionMarkdown).text;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
    writeFileSync(indexPath, appended.text, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `写入 incidents 失败：${message}` };
  }
  return { ok: true, indexPath, filePath };
}

/** 从 markdown 抽出「结论」段落（## / ### 标题含「结论」至下一同级标题）。 */
export function extractConclusionSection(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,3})\s+(.*)$/.exec(lines[i] ?? '');
    if (m && m[2]!.includes('结论')) {
      start = i + 1;
      startLevel = m[1]!.length;
      break;
    }
  }
  if (start < 0) return '';
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const m = /^(#{1,3})\s+/.exec(lines[i] ?? '');
    if (m && m[1]!.length <= startLevel) break;
    body.push(lines[i] ?? '');
  }
  return body.join('\n').trim();
}

function normalizeDiffLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export type ConclusionDiff = { added: string[]; removed: string[] };

/** 行级差：当前有、上次无 → added；上次有、当前无 → removed。 */
export function diffConclusionLines(previous: string, current: string): ConclusionDiff {
  const prev = normalizeDiffLines(previous);
  const curr = normalizeDiffLines(current);
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  return {
    added: curr.filter((l) => !prevSet.has(l)),
    removed: prev.filter((l) => !currSet.has(l))
  };
}

export function formatInspectionDiffNotice(
  diff: ConclusionDiff,
  maxLines = INSPECTION_DIFF_MAX_LINES
): string {
  const rows: string[] = [];
  for (const line of diff.added) {
    if (rows.length >= maxLines) break;
    rows.push(`+新增 ${line}`);
  }
  for (const line of diff.removed) {
    if (rows.length >= maxLines) break;
    rows.push(`-消失 ${line}`);
  }
  if (rows.length === 0) return '';
  return ['巡检结论相对上次变化：', ...rows].join('\n');
}

function conclusionFromFile(abs: string): string {
  const text = readTextIfExists(abs);
  if (text === undefined) return '';
  const section = extractConclusionSection(text);
  return section.length > 0 ? section : text.trim();
}

/**
 * 查找同 playbook 的上次结论：incidents 下除 index.md 外的 md
 * （文件名/正文含 playbookId 优先），以及 last-export-<playbookId>.md。
 */
export function findPreviousConclusion(memoryDir: string, playbookId: string): string | undefined {
  const incidentsDir = join(memoryDir, 'incidents');
  const candidates: string[] = [];

  const exportSnap = join(incidentsDir, `last-export-${playbookId}.md`);
  if (readTextIfExists(exportSnap) !== undefined) candidates.push(exportSnap);

  let names: string[] = [];
  try {
    names = readdirSync(incidentsDir);
  } catch {
    names = [];
  }
  const mdFiles = names
    .filter((n) => n.endsWith('.md') && n !== 'index.md' && !n.startsWith('last-export-'))
    .sort()
    .reverse();
  const preferred = mdFiles.filter((n) => n.includes(playbookId));
  const rest = mdFiles.filter((n) => !n.includes(playbookId));
  for (const name of [...preferred, ...rest]) {
    candidates.push(join(incidentsDir, name));
  }

  const indexText = readTextIfExists(incidentsIndexPath(memoryDir));
  if (indexText !== undefined) {
    for (const line of indexText.split('\n').reverse()) {
      if (!line.includes(playbookId) && !substringMatch(line, playbookId)) continue;
      const parts = line.trim().split(/\s+/);
      const rel = parts[parts.length - 1];
      if (typeof rel === 'string' && rel.includes('/')) {
        candidates.unshift(join(memoryDir, rel));
      }
    }
  }

  for (const abs of candidates) {
    if (basename(abs) === 'index.md') continue;
    const section = conclusionFromFile(abs);
    if (section.length > 0) return section;
  }
  return undefined;
}

/** 从会话 transcript 拼出可见结论（assistant 正文里的「结论」段，否则全文）。 */
export function conclusionFromTranscript(
  items: ReadonlyArray<{ kind: string; text?: string }>
): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === 'assistant' && typeof item.text === 'string' && item.text.trim().length > 0) {
      parts.push(item.text);
    }
  }
  const blob = parts.join('\n\n');
  const section = extractConclusionSection(blob);
  return section.length > 0 ? section : blob.trim();
}

export function oneSentenceFromConclusion(conclusion: string, fallback: string): string {
  for (const raw of conclusion.split('\n')) {
    const line = raw.replace(/^#{1,6}\s+/, '').replace(/^\*\*?/, '').replace(/\*\*?$/, '').trim();
    if (line.length === 0) continue;
    if (line.startsWith('```')) continue;
    return line.slice(0, 80);
  }
  return fallback.slice(0, 80);
}

export function isoDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
