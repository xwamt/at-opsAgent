/**
 * pruneToolResults：temp dir 内伪造 mtime，旧 tool-results 删除、新文件保留。
 * 不读写真实 ~/.at-series。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneToolResults, TOOL_RESULTS_RETENTION_MS } from '../src/host/retention';

const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'at-ops-retention-'));
  tempDirs.push(dir);
  return dir;
}

function ageFile(file: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pruneToolResults', () => {
  it('删除 mtime 超过 30 天的 tool-results，保留新文件', async () => {
    const agentDir = tempAgentDir();
    const resultsDir = join(agentDir, 'tool-results');
    mkdirSync(resultsDir, { recursive: true });
    const oldFile = join(resultsDir, 'old.json');
    const newFile = join(resultsDir, 'new.json');
    const keepTxt = join(resultsDir, 'notes.txt');
    writeFileSync(oldFile, '{"ok":true}', 'utf8');
    writeFileSync(newFile, '{"ok":true}', 'utf8');
    writeFileSync(keepTxt, 'not json', 'utf8');
    ageFile(oldFile, TOOL_RESULTS_RETENTION_MS + 86_400_000);

    const result = await pruneToolResults(agentDir);
    expect(result.deletedToolResults).toEqual([oldFile]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(keepTxt)).toBe(true);
  });

  it('目录不存在时不抛错', async () => {
    const agentDir = tempAgentDir();
    await expect(pruneToolResults(agentDir)).resolves.toEqual({
      deletedToolResults: [],
      deletedSessions: []
    });
  });

  it('未引用且过期的 sessions/*.jsonl 删除；仍被 sessionFile 引用的保留', async () => {
    const agentDir = tempAgentDir();
    const sessionsDir = join(agentDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const referenced = join(sessionsDir, 'live.jsonl');
    const oldOrphan = join(sessionsDir, 'orphan.jsonl');
    const newOrphan = join(sessionsDir, 'recent.jsonl');
    writeFileSync(referenced, '{"type":"session"}\n', 'utf8');
    writeFileSync(oldOrphan, '{"type":"session"}\n', 'utf8');
    writeFileSync(newOrphan, '{"type":"session"}\n', 'utf8');
    ageFile(referenced, TOOL_RESULTS_RETENTION_MS + 86_400_000);
    ageFile(oldOrphan, TOOL_RESULTS_RETENTION_MS + 86_400_000);
    writeFileSync(
      join(agentDir, 'ui-sessions.json'),
      JSON.stringify({ sessions: [{ id: 's1', sessionFile: referenced }] }),
      'utf8'
    );

    const result = await pruneToolResults(agentDir);
    expect(result.deletedSessions).toEqual([oldOrphan]);
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(referenced)).toBe(true);
    expect(existsSync(newOrphan)).toBe(true);
  });

  it('读不到 ui-sessions.json 时不删任何 JSONL（宁可漏删）', async () => {
    const agentDir = tempAgentDir();
    const sessionsDir = join(agentDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const orphan = join(sessionsDir, 'orphan.jsonl');
    writeFileSync(orphan, '{}\n', 'utf8');
    ageFile(orphan, TOOL_RESULTS_RETENTION_MS + 86_400_000);

    const result = await pruneToolResults(agentDir);
    expect(result.deletedSessions).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
  });
});
