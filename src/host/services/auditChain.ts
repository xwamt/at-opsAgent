/**
 * 审计 JSONL + 链式哈希（Plan 12 T4）。
 *
 * 路径：{agentDir}/audit/YYYY-MM-DD.jsonl（UTC 日切）append-only。
 * 行：{ ts, type, sessionId, payload, prevSha256, sha256 }
 *   sha256 = sha256(prevSha256 + canonical(payload))
 * payload 先经 redactSecrets，再参与哈希与落盘。
 *
 * 失败只 log，不抛给主会话。启动时发现最新文件链断只警告，不重写历史。
 * 零 vscode。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../../runtime/sanitize';
import {
  isAuditEventType,
  type DutyEvent,
  type DutyEventType
} from './dutyEvents';

export const AUDIT_DIRNAME = 'audit';
/** 文件内首条记录的 prevSha256（空串；日切后新文件重新起链）。 */
export const AUDIT_GENESIS_PREV = '';

export interface AuditRecord {
  ts: number;
  type: DutyEventType;
  sessionId: string;
  payload: Record<string, unknown>;
  prevSha256: string;
  sha256: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  /** 0-based 行号；ok 时缺省。 */
  brokenAt?: number;
  reason?: string;
}

export interface InspectLatestAuditResult {
  ok: boolean;
  file?: string;
  reason?: string;
}

export interface CopyAuditWindowResult {
  ok: boolean;
  files: string[];
  lines: number;
  error?: string;
}

export interface AuditWriterOptions {
  agentDir: string;
  now?: () => Date;
  log?: (message: string) => void;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function utcDateStamp(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function auditDir(agentDir: string): string {
  return join(agentDir, AUDIT_DIRNAME);
}

export function auditFilePath(agentDir: string, now: Date): string {
  return join(auditDir(agentDir), `${utcDateStamp(now)}.jsonl`);
}

/** 递归刮密：字符串走 redactSecrets，对象/数组下钻。 */
export function redactPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactPayload(child);
    }
    return out;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asPayloadRecord(value: unknown): Record<string, unknown> {
  const redacted = redactPayload(value ?? {});
  return isPlainRecord(redacted) ? redacted : { value: redacted };
}

/** 键排序的 canonical JSON（稳定哈希输入）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const child = obj[key];
    if (child === undefined) continue;
    out[key] = canonicalize(child);
  }
  return out;
}

export function computeRecordSha256(prevSha256: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${prevSha256}${canonicalJson(payload)}`, 'utf8')
    .digest('hex');
}

export function buildAuditRecord(
  event: DutyEvent,
  prevSha256: string
): AuditRecord {
  const payload = asPayloadRecord(event.payload);
  const sha256 = computeRecordSha256(prevSha256, payload);
  return {
    ts: event.ts ?? Date.now(),
    type: event.type,
    sessionId: event.sessionId,
    payload,
    prevSha256,
    sha256
  };
}

function parseAuditLine(line: string): AuditRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  if (typeof parsed.ts !== 'number' || typeof parsed.type !== 'string') return undefined;
  if (typeof parsed.sessionId !== 'string') return undefined;
  if (typeof parsed.prevSha256 !== 'string' || typeof parsed.sha256 !== 'string') return undefined;
  const payload = isPlainRecord(parsed.payload) ? parsed.payload : {};
  return {
    ts: parsed.ts,
    type: parsed.type as DutyEventType,
    sessionId: parsed.sessionId,
    payload,
    prevSha256: parsed.prevSha256,
    sha256: parsed.sha256
  };
}

/** 校验一段 JSONL 文本（空文件视为完好）。 */
export function verifyAuditText(text: string): AuditVerifyResult {
  const lines = text.split(/\r?\n/);
  let prev = AUDIT_GENESIS_PREV;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    const rec = parseAuditLine(raw);
    if (!rec) {
      return { ok: false, brokenAt: i, reason: `第 ${i + 1} 行不是合法审计记录` };
    }
    if (rec.prevSha256 !== prev) {
      return {
        ok: false,
        brokenAt: i,
        reason: `第 ${i + 1} 行 prevSha256 与上一条 sha256 不一致`
      };
    }
    const expected = computeRecordSha256(rec.prevSha256, rec.payload);
    if (rec.sha256 !== expected) {
      return {
        ok: false,
        brokenAt: i,
        reason: `第 ${i + 1} 行 sha256 与 payload 不匹配`
      };
    }
    prev = rec.sha256;
    seen += 1;
  }
  return { ok: true, ...(seen === 0 ? { reason: 'empty' } : {}) };
}

export function verifyAuditFileSync(filePath: string): AuditVerifyResult {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true, reason: 'missing' };
    return { ok: false, reason: describeError(err) };
  }
  return verifyAuditText(text);
}

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * 启动钩子：只看最新一份日文件整链。断链只返回原因，调用方 log 警告，
 * **禁止**重写历史。
 */
export async function inspectLatestAuditChain(agentDir: string): Promise<InspectLatestAuditResult> {
  const dir = auditDir(agentDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => DATE_FILE.test(name)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true, reason: 'missing' };
    return { ok: false, reason: describeError(err) };
  }
  if (names.length === 0) return { ok: true, reason: 'empty-dir' };
  const latest = names[names.length - 1];
  const file = join(dir, latest);
  const verified = verifyAuditFileSync(file);
  if (verified.ok) return { ok: true, file };
  return {
    ok: false,
    file,
    reason: verified.reason ?? 'broken'
  };
}

function lastSha256OfText(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parseAuditLine(lines[i]);
    if (rec) return rec.sha256;
  }
  return AUDIT_GENESIS_PREV;
}

export class AuditWriter {
  private readonly agentDir: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** 当前打开的日文件路径 → 链尾 sha；换日后重置。 */
  private fileKey: string | undefined;
  private lastSha: string = AUDIT_GENESIS_PREV;
  /** 串行化 append，避免并发读到同一 prev。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: AuditWriterOptions) {
    this.agentDir = options.agentDir;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  append(event: DutyEvent): Promise<void> {
    const run = this.chain.then(() => this.appendNow(event));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async appendNow(event: DutyEvent): Promise<void> {
    if (!isAuditEventType(event.type)) return;
    const file = auditFilePath(this.agentDir, this.now());
    await mkdir(auditDir(this.agentDir), { recursive: true });
    if (this.fileKey !== file) {
      this.fileKey = file;
      this.lastSha = AUDIT_GENESIS_PREV;
      if (existsSync(file)) {
        try {
          this.lastSha = lastSha256OfText(await readFile(file, 'utf8'));
        } catch (err) {
          this.log(`[audit] 读取链尾失败: ${describeError(err)}`);
          this.lastSha = AUDIT_GENESIS_PREV;
        }
      }
    }
    const rec = buildAuditRecord(event, this.lastSha);
    try {
      await writeFile(file, `${JSON.stringify(rec)}\n`, { encoding: 'utf8', flag: 'a' });
      this.lastSha = rec.sha256;
    } catch (err) {
      this.log(`[audit] 写入失败: ${describeError(err)}`);
    }
  }
}

function utcDayStart(stamp: string): number {
  return Date.parse(`${stamp}T00:00:00Z`);
}

/**
 * 按 UTC 日文件拷贝时间窗内的 jsonl（原行原链，不重算哈希）。
 * days <= 0 表示全部。
 */
export async function copyAuditWindow(input: {
  agentDir: string;
  destPath: string;
  days: number;
  now?: Date;
}): Promise<CopyAuditWindowResult> {
  const dir = auditDir(input.agentDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => DATE_FILE.test(name)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, files: [], lines: 0, error: '没有审计目录' };
    }
    return { ok: false, files: [], lines: 0, error: describeError(err) };
  }
  const now = input.now ?? new Date();
  const todayStamp = utcDateStamp(now);
  const todayStart = utcDayStart(todayStamp);
  const cutoff =
    input.days > 0 ? todayStart - (input.days - 1) * 86_400_000 : Number.NEGATIVE_INFINITY;
  const selected = names.filter((name) => {
    const match = DATE_FILE.exec(name);
    if (!match) return false;
    return utcDayStart(match[1]) >= cutoff;
  });
  if (selected.length === 0) {
    return { ok: false, files: [], lines: 0, error: '所选时间窗内没有审计记录' };
  }
  const chunks: string[] = [];
  let lines = 0;
  for (const name of selected) {
    const text = await readFile(join(dir, name), 'utf8');
    const body = text.endsWith('\n') || text.length === 0 ? text : `${text}\n`;
    chunks.push(body);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length > 0) lines += 1;
    }
  }
  try {
    await writeFile(input.destPath, chunks.join(''), 'utf8');
  } catch (err) {
    return { ok: false, files: selected, lines, error: describeError(err) };
  }
  return { ok: true, files: selected, lines };
}

/** 命令面板 QuickPick 选项（days<=0 = 全部）。 */
export const AUDIT_WINDOW_CHOICES: ReadonlyArray<{
  label: string;
  description: string;
  days: number;
}> = [
  { label: '今天', description: 'UTC 当日审计文件', days: 1 },
  { label: '最近 7 天', description: '含今天共 7 个 UTC 日', days: 7 },
  { label: '最近 30 天', description: '含今天共 30 个 UTC 日', days: 30 },
  { label: '全部', description: '所有已落盘的审计 JSONL', days: 0 }
];
