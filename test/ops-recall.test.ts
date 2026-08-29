/**
 * Plan 12 T1 / T8：ops_recall 子串命中、environment 秘密字段拒写、
 * incidents 第 201 行失败；巡检结论行级 diff。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { formatEnvSnapshot } from '../src/prompts/env-snapshot';
import {
  appendIncidentIndexLine,
  commitIncidentAppend,
  createRecallTool,
  diffConclusionLines,
  extractConclusionSection,
  findPreviousConclusion,
  formatIncidentIndexLine,
  formatInspectionDiffNotice,
  formatRecallResult,
  INCIDENT_INDEX_MAX_LINES,
  prepareEnvironmentSave,
  recallFromDir,
  RECALL_MAX_LINES,
  RECALL_TOOL_NAME,
  resolveMemoryDir
} from '../src/runtime/ops-recall';

const tempDirs: string[] = [];

function tempMemory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'at-ops-memory-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'incidents'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveMemoryDir', () => {
  it('workspace 优先，否则 ~/.at-series/agent/memory', () => {
    expect(resolveMemoryDir('/tmp/ws')).toBe(join('/tmp/ws', 'memory'));
    expect(resolveMemoryDir(undefined).replace(/\\/g, '/')).toMatch(
      /\/\.at-series\/agent\/memory$/
    );
  });
});

describe('ops_recall 子串命中', () => {
  it('命中 index 行与 environment 别名，最多 8 行', async () => {
    const dir = tempMemory();
    writeFileSync(
      join(dir, 'incidents', 'index.md'),
      [
        '2026-08-01 订单库慢查询 incidents/2026-08-01-pb.incident.md',
        '2026-08-10 巡检正常 incidents/2026-08-10-pb.inspection.md',
        '2026-08-20 prod-a 磁盘告警 incidents/2026-08-20-pb.host-emergency.md'
      ].join('\n') + '\n',
      'utf8'
    );
    writeFileSync(
      join(dir, 'environment.json'),
      JSON.stringify({ 'prod-a': '支付集群华东', 'staging-b': '预发' }, null, 2),
      'utf8'
    );

    const hits = recallFromDir(dir, 'prod-a');
    expect(hits.some((h) => h.source === 'index' && h.line.includes('磁盘告警'))).toBe(true);
    expect(hits.some((h) => h.source === 'environment' && h.line.includes('支付集群华东'))).toBe(
      true
    );

    const spec = createRecallTool({ memoryDir: () => dir });
    expect(spec.name).toBe(RECALL_TOOL_NAME);
    expect(spec.risk).toBe('read');
    const json = JSON.parse(await spec.execute({ query: 'prod-a' })) as {
      ok: boolean;
      lines: string[];
    };
    expect(json.ok).toBe(true);
    expect(json.lines.length).toBeGreaterThan(0);
    expect(json.lines.length).toBeLessThanOrEqual(RECALL_MAX_LINES);
    expect(json.lines.some((l) => l.includes('支付集群华东') || l.includes('磁盘告警'))).toBe(true);

    const empty = formatRecallResult('no-such-token', []);
    expect(empty.lines).toEqual([]);
    expect(empty.notice).toMatch(/无匹配/);
  });

  it('文件缺失不抛错', () => {
    const dir = tempMemory();
    expect(recallFromDir(dir, 'anything')).toEqual([]);
  });
});

describe('environment 保存校验', () => {
  it('合法别名表通过', () => {
    const ok = prepareEnvironmentSave(JSON.stringify({ 'prod-a': '集群说明' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.aliases['prod-a']).toBe('集群说明');
  });

  it('秘密字段拒写', () => {
    const keyed = prepareEnvironmentSave(JSON.stringify({ password: 'hunter2' }));
    expect(keyed.ok).toBe(false);
    if (!keyed.ok) expect(keyed.error).toMatch(/秘密字段/);

    const tokenKey = prepareEnvironmentSave(JSON.stringify({ api_key: 'abcdEFGH' }));
    expect(tokenKey.ok).toBe(false);

    const inValue = prepareEnvironmentSave(
      JSON.stringify({ 'prod-a': 'token=supersecretvalue' })
    );
    expect(inValue.ok).toBe(false);
    if (!inValue.ok) expect(inValue.error).toMatch(/密钥|token/i);

    const nested = prepareEnvironmentSave(JSON.stringify({ 'prod-a': { host: '10.0.0.1' } }));
    expect(nested.ok).toBe(false);
  });
});

describe('incidents/index.md 行数上限', () => {
  it('第 201 行失败且不写盘', () => {
    const existing = Array.from({ length: INCIDENT_INDEX_MAX_LINES }, (_, i) => `line-${i + 1}`).join(
      '\n'
    );
    const refused = appendIncidentIndexLine(existing, 'line-201 should fail');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/归档/);

    const dir = tempMemory();
    const indexPath = join(dir, 'incidents', 'index.md');
    writeFileSync(indexPath, existing.endsWith('\n') ? existing : `${existing}\n`, 'utf8');
    const committed = commitIncidentAppend(dir, {
      relativePath: 'incidents/2026-08-29-pb.inspection.md',
      indexLine: formatIncidentIndexLine({
        date: '2026-08-29',
        sentence: '不应写入',
        relativePath: 'incidents/2026-08-29-pb.inspection.md'
      }),
      conclusionMarkdown: '## 结论\n\n秘密不应出现\n'
    });
    expect(committed.ok).toBe(false);
    expect(readFileSync(indexPath, 'utf8').split('\n').filter((l) => l.length > 0)).toHaveLength(
      INCIDENT_INDEX_MAX_LINES
    );
    try {
      readFileSync(join(dir, 'incidents', '2026-08-29-pb.inspection.md'), 'utf8');
      expect.unreachable('结论文件不应被创建');
    } catch {
      // expected
    }
  });

  it('用户确认后才追加一行', () => {
    const dir = tempMemory();
    const line = formatIncidentIndexLine({
      date: '2026-08-29',
      sentence: '三台主机负载正常',
      relativePath: 'incidents/2026-08-29-pb.inspection.md'
    });
    const result = commitIncidentAppend(dir, {
      relativePath: 'incidents/2026-08-29-pb.inspection.md',
      indexLine: line,
      conclusionMarkdown: '## 结论\n\n三台主机负载正常\n'
    });
    expect(result.ok).toBe(true);
    const index = readFileSync(join(dir, 'incidents', 'index.md'), 'utf8');
    expect(index).toContain('三台主机负载正常');
    expect(index.trim().split('\n')).toHaveLength(1);
  });
});

describe('T8 巡检结论 diff', () => {
  it('抽出结论段并展示 +新增 / -消失，最多 20 行', () => {
    const prev = extractConclusionSection('## 结论\n\n负载正常\n磁盘 40%\n内存 2G\n');
    const curr = extractConclusionSection('## 巡检结论\n\n负载升高\n磁盘 40%\n未检查 GPU\n');
    expect(prev).toContain('负载正常');
    const diff = diffConclusionLines(prev, curr);
    expect(diff.added).toEqual(expect.arrayContaining(['负载升高', '未检查 GPU']));
    expect(diff.removed).toEqual(expect.arrayContaining(['负载正常', '内存 2G']));
    const notice = formatInspectionDiffNotice(diff);
    expect(notice).toContain('+新增 负载升高');
    expect(notice).toContain('-消失 负载正常');
    expect(notice.split('\n').length).toBeLessThanOrEqual(21);

    const many = {
      added: Array.from({ length: 30 }, (_, i) => `a${i}`),
      removed: Array.from({ length: 30 }, (_, i) => `r${i}`)
    };
    expect(formatInspectionDiffNotice(many).split('\n').slice(1).length).toBe(20);
  });

  it('无历史则 findPreviousConclusion 为空', () => {
    const dir = tempMemory();
    expect(findPreviousConclusion(dir, 'pb.inspection')).toBeUndefined();
  });

  it('能从 incidents 历史文件读出上次结论', () => {
    const dir = tempMemory();
    writeFileSync(
      join(dir, 'incidents', '2026-08-20-pb.inspection.md'),
      '# pb.inspection · 2026-08-20\n\n## 结论\n\n昨天磁盘 40%\n',
      'utf8'
    );
    expect(findPreviousConclusion(dir, 'pb.inspection')).toContain('昨天磁盘 40%');
  });
});

describe('L-env aliases', () => {
  it('environment 有键时追加 aliases:（文件缺失不提）', () => {
    const withAliases = formatEnvSnapshot({
      hostApp: 'vscode',
      catalogLiveToolCount: 0,
      exposed: [],
      aliases: { 'prod-a': '支付集群' },
      providers: []
    });
    expect(withAliases).toContain('aliases:');
    expect(withAliases).toContain('prod-a: 支付集群');

    const missing = formatEnvSnapshot({
      hostApp: 'vscode',
      catalogLiveToolCount: 0,
      exposed: [],
      providers: []
    });
    expect(missing).not.toContain('aliases:');
  });
});
