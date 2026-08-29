/**
 * ops_write_ops_doc 纯函数：路径牢笼 + 补「未检查」段。
 * 真正写盘在 host；本文件用临时目录模拟 host mock（gate 拒绝不写）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyToolGate, type OpsRuntimeHandlers } from '../src/runtime';
import { resolveToolRisk } from '../src/mcp-client/riskLookup';
import { readSkillFile } from '../src/runtime/resource-loader';
import {
  WRITE_OPS_DOC_TOOL_NAME,
  createWriteOpsDocTool,
  defaultOpsDocRelPath,
  ensureTemplateHeadings,
  formatOpsDocApprovalCommands,
  prepareWriteOpsDoc,
  resolveOpsDocOverwrite,
  slugTitle,
  type WriteOpsDocRequest
} from '../src/runtime/workspace-write';

const tempDirs: string[] = [];

function tempDocsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'at-ops-docs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function req(partial: Partial<WriteOpsDocRequest> = {}): WriteOpsDocRequest {
  return {
    docType: 'inspection-report',
    title: '支付网关巡检',
    markdown: '# 巡检\n\n正文',
    ...partial
  };
}

describe('slug / 默认路径', () => {
  it('ops_write_ops_doc 对策略闸是 write（不落进 ops_* 默认 read）', () => {
    expect(resolveToolRisk(WRITE_OPS_DOC_TOOL_NAME)).toBe('write');
    expect(resolveToolRisk('ops_read_skill')).toBe('read');
  });
  it('slug 保留中文，空白收成连字符', () => {
    expect(slugTitle('  支付网关 巡检  ')).toBe('支付网关-巡检');
    expect(slugTitle('')).toBe('untitled');
  });

  it('默认相对路径 ops-docs 风格 YYYY/MM/slug.md', () => {
    const now = new Date(2026, 7, 29);
    expect(defaultOpsDocRelPath('支付网关巡检', now)).toBe('2026/08/支付网关巡检.md');
  });
});

describe('ensureTemplateHeadings', () => {
  it('缺标题则追加「未检查」段', () => {
    const filled = ensureTemplateHeadings('# 只有标题\n', 'inspection-report');
    expect(filled).toContain('## 文档信息');
    expect(filled).toContain('## 背景目标');
    expect(filled).toContain('## 现状证据');
    expect(filled).toContain('## 步骤');
    expect(filled).toContain('## 验证');
    expect(filled).toContain('## 回滚');
    expect(filled).toContain('## 交接');
    expect(filled.match(/（未检查）/g)?.length).toBe(7);
  });

  it('已有标题不重复追加', () => {
    const src = '## 文档信息\n\nx\n\n## 背景目标\n\ny\n';
    const filled = ensureTemplateHeadings(src, 'handoff');
    expect(filled.match(/^## 文档信息$/m)?.length).toBe(1);
    expect(filled).toContain('## 现状证据');
    expect(filled).toContain('（未检查）');
  });
});

describe('路径牢笼', () => {
  it('../etc/passwd、绝对路径、白名单外 overwrite 全部 {ok:false}', () => {
    const root = tempDocsRoot();
    expect(prepareWriteOpsDoc(root, req({ overwritePath: '../etc/passwd' })).ok).toBe(false);
    expect(prepareWriteOpsDoc(root, req({ overwritePath: '/etc/passwd' })).ok).toBe(false);
    expect(prepareWriteOpsDoc(root, req({ overwritePath: '/tmp/outside.md' })).ok).toBe(false);
    expect(resolveOpsDocOverwrite(root, '../etc/passwd')).toBeUndefined();
    expect(resolveOpsDocOverwrite(root, '/etc/passwd')).toBeUndefined();
  });

  it('相对 overwrite 与绝对但 prefix-ok 的 overwrite 放行', () => {
    const root = tempDocsRoot();
    const okRel = prepareWriteOpsDoc(root, req({ overwritePath: '2026/08/keep.md' }));
    expect(okRel.ok).toBe(true);
    if (okRel.ok) expect(okRel.absPath).toBe(resolve(root, '2026/08/keep.md'));

    const absInside = join(root, '2026/08/abs.md');
    const okAbs = prepareWriteOpsDoc(root, req({ overwritePath: absInside }));
    expect(okAbs.ok).toBe(true);
    if (okAbs.ok) expect(okAbs.absPath).toBe(resolve(absInside));
  });

  it('默认路径落在 docsRoot/YYYY/MM/slug.md 且含补段', () => {
    const root = tempDocsRoot();
    const now = new Date(2026, 7, 29);
    const prepared = prepareWriteOpsDoc(root, req(), now);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.absPath).toBe(resolve(root, '2026/08/支付网关巡检.md'));
    expect(prepared.markdown).toContain('## 验证');
    expect(prepared.markdown).toContain('（未检查）');
  });

  it('超过 256KB 拒绝', () => {
    const root = tempDocsRoot();
    const markdown = 'x'.repeat(256 * 1024 + 10);
    const prepared = prepareWriteOpsDoc(root, req({ markdown }));
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toContain('256KB');
  });
});

describe('审批 commands 预览', () => {
  it('含将写入路径与前 40 行', () => {
    const text = formatOpsDocApprovalCommands({
      title: '巡检',
      markdown: 'line1\nline2\nline3',
      docType: 'inspection-report'
    });
    expect(text).toContain('将写入 `');
    expect(text).toContain('+3/-0 行');
    expect(text).toContain('line1');
  });
});

describe('gate reject → 无文件；approve → 文件存在（host mock）', () => {
  async function mockHostWrite(
    docsRoot: string,
    request: WriteOpsDocRequest
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const prepared = prepareWriteOpsDoc(docsRoot, request);
    if (!prepared.ok) return prepared;
    mkdirSync(dirname(prepared.absPath), { recursive: true });
    writeFileSync(prepared.absPath, prepared.markdown, 'utf8');
    return { ok: true, path: prepared.absPath };
  }

  function gateHandlers(
    decision: 'approved' | 'rejected'
  ): OpsRuntimeHandlers {
    return {
      hub: {} as OpsRuntimeHandlers['hub'],
      beforeToolCall: async () => ({
        block: false,
        needSessionApproval: true,
        risk: 'write' as const
      }),
      requestApproval: async () => decision
    };
  }

  it('审批拒绝：handler 不写盘', async () => {
    const root = tempDocsRoot();
    let called = false;
    const handlers = gateHandlers('rejected');
    const writeOpsDoc = async (request: WriteOpsDocRequest) => {
      called = true;
      return mockHostWrite(root, request);
    };
    const gate = await applyToolGate(handlers, WRITE_OPS_DOC_TOOL_NAME, req() as unknown as Record<string, unknown>);
    expect(gate.kind).toBe('reject');
    if (gate.kind === 'allow') {
      await writeOpsDoc(req());
    }
    expect(called).toBe(false);
    expect(existsSync(join(root, defaultOpsDocRelPath('支付网关巡检', new Date(2026, 7, 29))))).toBe(
      false
    );
  });

  it('批准后文件存在且含模板段', async () => {
    const root = tempDocsRoot();
    const handlers = gateHandlers('approved');
    const gate = await applyToolGate(handlers, WRITE_OPS_DOC_TOOL_NAME, {});
    expect(gate.kind).toBe('allow');
    const now = new Date(2026, 7, 29);
    const written = await mockHostWrite(root, req());
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const abs = prepareWriteOpsDoc(root, req(), now);
    expect(abs.ok).toBe(true);
    if (!abs.ok) return;
    expect(existsSync(abs.absPath)).toBe(true);
    const body = readFileSync(abs.absPath, 'utf8');
    expect(body).toContain('## 交接');
    expect(body).toContain('（未检查）');
  });

  it('createWriteOpsDocTool execute 把请求交给 handler 并返回 JSON', async () => {
    const root = tempDocsRoot();
    const spec = createWriteOpsDocTool(async (request) => mockHostWrite(root, request));
    expect(spec.name).toBe(WRITE_OPS_DOC_TOOL_NAME);
    expect(spec.risk).toBe('write');
    const json = await spec.execute({
      docType: 'inspection-report',
      title: '支付网关巡检',
      markdown: '# 巡检'
    });
    const parsed = JSON.parse(json) as { ok: boolean; path?: string };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.path).toBe('string');
    if (parsed.path) expect(existsSync(parsed.path)).toBe(true);
  });
});

describe('ops_read_skill 可读 ops-documents 模板', () => {
  it('bundled skills 下 inspection-report.md 存在', async () => {
    const bundled = join(process.cwd(), 'skills');
    const hit = await readSkillFile([bundled], 'ops-documents/inspection-report.md');
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.content).toContain('## 文档信息');
      expect(hit.content).toContain('inspection-report');
    }
    const skill = await readSkillFile([bundled], 'ops-documents/SKILL.md');
    expect(skill.ok).toBe(true);
    if (skill.ok) {
      expect(skill.content).toContain('用 ops_write_ops_doc，不要 bash');
    }
  });
});
