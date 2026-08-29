/**
 * Plan 12 T4：审计 JSONL 链式哈希。
 * - 写三行，第三行 prevSha256 = 第二行 sha256；
 * - 手改第二行后校验报断链，且不重写历史；
 * - 巡检 close 路径（直接驱动 writer）：文件含 playbook_stage + tool_decision。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditWriter,
  auditFilePath,
  copyAuditWindow,
  inspectLatestAuditChain,
  verifyAuditFileSync,
  verifyAuditText
} from '../src/host/services/auditChain';
import { DutyEventBus } from '../src/host/services/dutyEvents';
import { REDACTED } from '../src/runtime/sanitize';

const tempDirs: string[] = [];
const NOW = new Date('2026-08-29T12:00:00Z');

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'at-ops-audit-'));
  tempDirs.push(dir);
  return dir;
}

function parseLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('audit JSONL chain', () => {
  it('写三行：第三行 prevSha256 等于第二行 sha256，整链可校验', async () => {
    const agentDir = tempAgentDir();
    const writer = new AuditWriter({ agentDir, now: () => NOW });
    await writer.append({
      type: 'playbook_stage',
      sessionId: 'sess-1',
      payload: { playbookId: 'pb.inspection', stage: 'investigating' }
    });
    await writer.append({
      type: 'tool_decision',
      sessionId: 'sess-1',
      payload: { toolName: 'grafana_query_loki', block: false }
    });
    await writer.append({
      type: 'playbook_stage',
      sessionId: 'sess-1',
      payload: { playbookId: 'pb.inspection', stage: 'closed' }
    });

    const file = auditFilePath(agentDir, NOW);
    const lines = parseLines(file);
    expect(lines).toHaveLength(3);
    expect(lines[0].prevSha256).toBe('');
    expect(lines[1].prevSha256).toBe(lines[0].sha256);
    expect(lines[2].prevSha256).toBe(lines[1].sha256);
    expect(typeof lines[0].sha256).toBe('string');
    expect((lines[0].sha256 as string).length).toBe(64);
    expect(verifyAuditFileSync(file).ok).toBe(true);
  });

  it('手改第二行 payload 后校验报断链，inspect 警告且不重写历史', async () => {
    const agentDir = tempAgentDir();
    const writer = new AuditWriter({ agentDir, now: () => NOW });
    await writer.append({
      type: 'playbook_stage',
      sessionId: 's',
      payload: { stage: 'a' }
    });
    await writer.append({
      type: 'tool_decision',
      sessionId: 's',
      payload: { toolName: 'metrics.query', block: false }
    });
    await writer.append({
      type: 'export',
      sessionId: 's',
      payload: { format: 'markdown' }
    });

    const file = auditFilePath(agentDir, NOW);
    const original = readFileSync(file, 'utf8');
    const rawLines = original.split('\n').filter((line) => line.trim().length > 0);
    const second = JSON.parse(rawLines[1]) as Record<string, unknown>;
    (second.payload as Record<string, unknown>).toolName = 'tampered_tool';
    rawLines[1] = JSON.stringify(second);
    const tampered = `${rawLines.join('\n')}\n`;
    writeFileSync(file, tampered, 'utf8');

    const verified = verifyAuditText(tampered);
    expect(verified.ok).toBe(false);
    expect(verified.brokenAt).toBe(1);

    const inspect = await inspectLatestAuditChain(agentDir);
    expect(inspect.ok).toBe(false);
    expect(inspect.file).toBe(file);
    expect(inspect.reason).toMatch(/sha256|不匹配/);

    expect(readFileSync(file, 'utf8')).toBe(tampered);
    expect(readFileSync(file, 'utf8')).toContain('tampered_tool');
  });

  it('close-inspection 路径：audit 文件含 playbook_stage + 至少一次 tool_decision', async () => {
    const agentDir = tempAgentDir();
    const writer = new AuditWriter({ agentDir, now: () => NOW });
    await writer.append({
      type: 'playbook_stage',
      sessionId: 'inspect-1',
      payload: { playbookId: 'pb.inspection', stage: 'investigating' }
    });
    await writer.append({
      type: 'tool_decision',
      sessionId: 'inspect-1',
      payload: { toolName: 'grafana_query_prometheus', block: false, needSessionApproval: false }
    });
    await writer.append({
      type: 'playbook_stage',
      sessionId: 'inspect-1',
      payload: { playbookId: 'pb.inspection', stage: 'closed' }
    });

    const file = auditFilePath(agentDir, NOW);
    const types = parseLines(file).map((row) => row.type);
    expect(types).toContain('playbook_stage');
    expect(types).toContain('tool_decision');
    expect(types.filter((t) => t === 'playbook_stage').length).toBeGreaterThanOrEqual(1);
    expect(verifyAuditFileSync(file).ok).toBe(true);
  });

  it('payload 先 redactSecrets 再哈希：Bearer token 不会落盘', async () => {
    const agentDir = tempAgentDir();
    const writer = new AuditWriter({ agentDir, now: () => NOW });
    await writer.append({
      type: 'approval_request',
      sessionId: 's',
      payload: { reason: 'Authorization: Bearer super-secret-token-value' }
    });
    const line = parseLines(auditFilePath(agentDir, NOW))[0];
    const payload = line.payload as Record<string, unknown>;
    expect(String(payload.reason)).toContain(REDACTED);
    expect(String(payload.reason)).not.toContain('super-secret-token-value');
  });

  it('token_usage 不进审计文件（OTLP 专属）', async () => {
    const agentDir = tempAgentDir();
    const writer = new AuditWriter({ agentDir, now: () => NOW });
    await writer.append({
      type: 'token_usage',
      sessionId: 's',
      payload: { inputTokens: 12 }
    });
    await writer.append({
      type: 'tool_decision',
      sessionId: 's',
      payload: { toolName: 'ops_list_playbooks', block: false }
    });
    const types = parseLines(auditFilePath(agentDir, NOW)).map((row) => row.type);
    expect(types).toEqual(['tool_decision']);
  });

  it('copyAuditWindow 原样拷贝，链哈希不变', async () => {
    const agentDir = tempAgentDir();
    const writer = new AuditWriter({ agentDir, now: () => NOW });
    await writer.append({
      type: 'playbook_stage',
      sessionId: 's',
      payload: { stage: 'triage' }
    });
    await writer.append({
      type: 'tool_decision',
      sessionId: 's',
      payload: { toolName: 'x', block: false }
    });
    const src = auditFilePath(agentDir, NOW);
    const dest = join(agentDir, 'export-copy.jsonl');
    const copied = await copyAuditWindow({ agentDir, destPath: dest, days: 1, now: NOW });
    expect(copied.ok).toBe(true);
    expect(copied.lines).toBe(2);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(src, 'utf8'));
  });

  it('DutyEventBus 一次 emit 同时送达两个订阅方；handler 抛错不扩散', () => {
    const seen: string[] = [];
    const bus = new DutyEventBus();
    bus.subscribe((e) => {
      seen.push(`a:${e.type}`);
    });
    bus.subscribe(() => {
      throw new Error('subscriber boom');
    });
    bus.subscribe((e) => {
      seen.push(`b:${e.type}`);
    });
    expect(() =>
      bus.emit({ type: 'policy_block', sessionId: 's', payload: { toolName: 'rm' } })
    ).not.toThrow();
    expect(seen).toEqual(['a:policy_block', 'b:policy_block']);
  });
});
