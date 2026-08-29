/**
 * 激活时尽力清理过期落盘（不阻塞 activate）：
 * - `tool-results/*.json`：mtime 超过 30 天则删；
 * - `sessions/*.jsonl`：mtime 超过 30 天且未被 ui-sessions.json 任何
 *   sessionFile 引用才删。读不到引用表时跳过 JSONL（宁可漏删）。
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TOOL_RESULTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const TOOL_RESULTS_DIRNAME = 'tool-results';
const SESSIONS_DIRNAME = 'sessions';
const UI_SESSIONS_FILE = 'ui-sessions.json';

export interface PruneToolResultsOptions {
  nowMs?: number;
  maxAgeMs?: number;
}

export interface PruneToolResultsResult {
  deletedToolResults: string[];
  deletedSessions: string[];
}

export async function pruneToolResults(
  agentDir: string,
  options: PruneToolResultsOptions = {}
): Promise<PruneToolResultsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? TOOL_RESULTS_RETENTION_MS;
  const cutoff = nowMs - maxAgeMs;
  const deletedToolResults = await pruneExpiredJson(join(agentDir, TOOL_RESULTS_DIRNAME), cutoff);
  const deletedSessions = await pruneUnreferencedSessionJsonl(agentDir, cutoff);
  return { deletedToolResults, deletedSessions };
}

async function pruneExpiredJson(dir: string, cutoff: number): Promise<string[]> {
  const deleted: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return deleted;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const st = await stat(file);
      if (st.mtimeMs >= cutoff) continue;
      await unlink(file);
      deleted.push(file);
    } catch {
      // 宁可漏删：单文件 stat/unlink 失败不影响其余。
    }
  }
  return deleted;
}

/** 读 ui-sessions.json 的 sessionFile；失败返回 undefined → 跳过 JSONL 清理。 */
function referencedSessionFiles(agentDir: string): Set<string> | undefined {
  try {
    const raw = readFileSync(join(agentDir, UI_SESSIONS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { sessions?: Array<{ sessionFile?: unknown }> };
    const refs = new Set<string>();
    if (!Array.isArray(parsed.sessions)) return refs;
    for (const session of parsed.sessions) {
      if (typeof session?.sessionFile === 'string' && session.sessionFile.length > 0) {
        refs.add(resolve(session.sessionFile));
      }
    }
    return refs;
  } catch {
    return undefined;
  }
}

async function pruneUnreferencedSessionJsonl(agentDir: string, cutoff: number): Promise<string[]> {
  const referenced = referencedSessionFiles(agentDir);
  if (referenced === undefined) return [];

  const dir = join(agentDir, SESSIONS_DIRNAME);
  const deleted: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return deleted;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = resolve(dir, name);
    if (referenced.has(file)) continue;
    try {
      const st = await stat(file);
      if (st.mtimeMs >= cutoff) continue;
      await unlink(file);
      deleted.push(file);
    } catch {
      // 宁可漏删。
    }
  }
  return deleted;
}
