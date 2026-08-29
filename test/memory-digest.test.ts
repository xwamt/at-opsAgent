/**
 * Plan 08 T2–T3：buildDutyDigest 行数/截断；L-mem 注入 composeSystemPrompt。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue
    })
  },
  commands: { executeCommand: () => Promise.resolve() }
}));
import {
  MEM_LAYER_MAX_LINES,
  buildDutyDigest,
  collectDutyDigestInput
} from '../src/host/services/memoryDigest';
import { StageLayerInjector } from '../src/host/services/stageLayers';
import type { HostContext } from '../src/host/services/context';
import { composeSystemPrompt } from '../src/prompts/layers';
import { buildSystemPrompt } from '../src/runtime';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildDutyDigest', () => {
  it('空输入仍有 playbook 行或 (no playbook)', () => {
    const text = buildDutyDigest({ evidence: [], approvals: [] });
    expect(text).toContain('# L-mem 交接');
    expect(text).toContain('playbook: (no playbook)');
    expect(text.split('\n').length).toBeLessThanOrEqual(MEM_LAYER_MAX_LINES);
  });

  it('含 playbook / evidence / approvals / exposed，不含 preview 长文本', () => {
    const previewDump = `BEGIN_PREVIEW ${'x'.repeat(400)} END_PREVIEW`;
    const text = buildDutyDigest({
      playbook: { id: 'pb.inspection', stage: 'investigating' },
      evidence: [{ confidence: 'confirmed', summary: '18:02 发布后错误率上升' }],
      approvals: [{ briefId: 'abc123', decision: 'approved' }],
      exposed: ['at.grafana', 'at.terminal']
    });
    expect(text).toContain('playbook: pb.inspection @ investigating');
    expect(text).toContain('[confirmed] 18:02 发布后错误率上升');
    expect(text).toContain('brief abc123 approved');
    expect(text).toContain('exposed: at.grafana, at.terminal');
    expect(text).not.toContain(previewDump);
    expect(text.split('\n').length).toBeLessThanOrEqual(MEM_LAYER_MAX_LINES);
  });

  it('8+ 条 evidence 截断；summary ≤80 字；末行 truncated N；总行数 ≤20', () => {
    const evidence = Array.from({ length: 12 }, (_, i) => ({
      confidence: 'hypothesis',
      summary: `证据 ${i + 1} ${'很长摘要'.repeat(40)}`
    }));
    const approvals = Array.from({ length: 6 }, (_, i) => ({
      briefId: `brief-${i}`,
      decision: 'approved'
    }));
    const text = buildDutyDigest({ evidence, approvals });
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(MEM_LAYER_MAX_LINES);
    expect(text).toMatch(/… truncated \d+/);
    const evidenceLines = lines.filter((l) => l.startsWith('- ['));
    expect(evidenceLines.length).toBeLessThanOrEqual(8);
    for (const line of evidenceLines) {
      const summary = line.replace(/^- \[[^\]]+\] /, '');
      expect(summary.length).toBeLessThanOrEqual(80);
    }
    expect(text).not.toContain('证据 9');
  });

  it('collectDutyDigestInput 只取 evidence.note.summary，不取 tool.preview', () => {
    const longPreview = `stdout dump ${'ERROR'.repeat(80)}`;
    const collected = collectDutyDigestInput({
      items: [
        {
          kind: 'tool',
          note: { confidence: 'confirmed', summary: 'should-not-appear' }
        },
        {
          kind: 'evidence',
          note: { confidence: 'confirmed', summary: '磁盘 93%' }
        }
      ],
      timeline: [{ kind: 'approval', briefId: 'b1', decision: 'rejected' }],
      pendingBriefs: [{ id: 'b2' }]
    });
    const text = buildDutyDigest(collected);
    expect(text).toContain('磁盘 93%');
    expect(text).not.toContain('should-not-appear');
    expect(text).not.toContain(longPreview);
    expect(text).toContain('brief b1 rejected');
    expect(text).toContain('brief b2 pending');
  });

  it('digest 过 redactSecrets，不把 sk- 密钥带进 L-mem', () => {
    const text = buildDutyDigest({
      evidence: [{ confidence: 'pending', summary: 'token sk-abcdefghijklmnop leaked' }],
      approvals: []
    });
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('composeSystemPrompt · memLayer（T3）', () => {
  it('memLayer 在 env 之后、playbook 之前；结果含 # L-mem', () => {
    const prompt = composeSystemPrompt({
      envLayer: 'X-ENV-LAYER',
      memLayer: '# L-mem 交接（compaction 后回灌，勿丢）\nplaybook: (no playbook)',
      playbookLayer: 'Y-PB-LAYER'
    });
    expect(prompt).toContain('# L-mem');
    expect(prompt.indexOf('X-ENV-LAYER')).toBeLessThan(prompt.indexOf('# L-mem'));
    expect(prompt.indexOf('# L-mem')).toBeLessThan(prompt.indexOf('Y-PB-LAYER'));
    expect(buildSystemPrompt({ memLayer: '# L-mem 交接' })).toContain('# L-mem');
  });
});

describe('StageLayerInjector · memLayer 内容哈希', () => {
  it('applyLayers 带 mem 后 compose 含 # L-mem；后续未传 mem 仍保留', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-mem-layer-'));
    tempDirs.push(dir);
    const prompts: string[] = [];
    const runtime = {
      setSystemPrompt(prompt: string) {
        prompts.push(prompt);
      }
    };
    const ctx = {
      playbooksDir: path.join(dir, 'playbooks'),
      playbooks: { runOf: () => undefined, getPlaybooks: async () => [] },
      store: { playbookOf: () => undefined },
      hub: {
        getProviders: () => ({ hostApp: 'vscode', providers: [] }),
        listAllTools: () => [],
        listExposedTools: () => []
      },
      core: { buildSystemPrompt },
      chat: { runtimeFor: () => runtime },
      log: () => {}
    } as unknown as HostContext;

    const injector = new StageLayerInjector(ctx, async () => []);
    const digest = buildDutyDigest({
      evidence: [{ confidence: 'confirmed', summary: '18:02 发布后错误率上升' }],
      approvals: []
    });
    await injector.applyLayers('sid-1', { memLayer: digest });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[prompts.length - 1]).toContain('# L-mem');
    expect(prompts[prompts.length - 1]).toContain('18:02 发布后错误率上升');

    const afterFirst = prompts.length;
    await injector.applyLayers('sid-1');
    expect(prompts[prompts.length - 1]).toContain('# L-mem');
    // 内容未变（playbook + env + mem）应跳过重复 setSystemPrompt
    expect(prompts.length).toBe(afterFirst);
  });
});
