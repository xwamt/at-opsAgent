import { describe, expect, it } from 'vitest';

import {
  ADVANCE_STAGE_TOOL_NAME,
  CLOSE_PLAYBOOK_TOOL_NAME,
  LIST_PLAYBOOKS_TOOL_NAME,
  START_PLAYBOOK_TOOL_NAME,
  createPlaybookTools,
  type PlaybookCatalogEntry,
  type PlaybookStageResult,
  type PlaybookStartResult,
  type PlaybookToolHost
} from '../src/runtime/playbook-tools';
import { discoveryToolNames } from '../src/runtime/discovery-tools';

const CATALOG: PlaybookCatalogEntry[] = [
  {
    id: 'pb.incident',
    title: '故障响应',
    description: '结构化故障排查链路',
    whenToUse: ['服务超时', '错误率飙升']
  },
  { id: 'pb.inspection', title: '例行巡检' }
];

function makeHost(overrides: Partial<PlaybookToolHost> = {}): {
  host: PlaybookToolHost;
  startCalls: string[];
} {
  const startCalls: string[] = [];
  const host: PlaybookToolHost = {
    list: () => CATALOG,
    start: (playbookId: string): PlaybookStartResult => {
      startCalls.push(playbookId);
      return { ok: true, stage: 'investigating' };
    },
    ...overrides
  };
  return { host, startCalls };
}

function toolByName(specs: ReturnType<typeof createPlaybookTools>, name: string) {
  const spec = specs.find((s) => s.name === name);
  if (!spec) throw new Error(`工具 ${name} 未注册`);
  return spec;
}

describe('createPlaybookTools', () => {
  it('注册 list/start/advance/close 四个工具（有无 host 都注册）', () => {
    for (const host of [makeHost().host, undefined]) {
      const names = createPlaybookTools(host).map((s) => s.name);
      expect(names).toEqual([
        LIST_PLAYBOOKS_TOOL_NAME,
        START_PLAYBOOK_TOOL_NAME,
        ADVANCE_STAGE_TOOL_NAME,
        CLOSE_PLAYBOOK_TOOL_NAME
      ]);
    }
  });

  it('playbook 工具是附加工具，不进 5 个 ops_* 发现工具清单', () => {
    expect(discoveryToolNames).toHaveLength(5);
    expect(discoveryToolNames).not.toContain(LIST_PLAYBOOKS_TOOL_NAME);
    expect(discoveryToolNames).not.toContain(START_PLAYBOOK_TOOL_NAME);
    expect(discoveryToolNames).not.toContain(ADVANCE_STAGE_TOOL_NAME);
    expect(discoveryToolNames).not.toContain(CLOSE_PLAYBOOK_TOOL_NAME);
  });

  it('list 返回 host 目录与「由你决定」提示', async () => {
    const { host } = makeHost();
    const spec = toolByName(createPlaybookTools(host), LIST_PLAYBOOKS_TOOL_NAME);
    const parsed = JSON.parse(await spec.execute({})) as {
      playbooks: PlaybookCatalogEntry[];
      hint: string;
    };
    expect(parsed.playbooks).toEqual(CATALOG);
    expect(parsed.hint).toContain('不会因关键词自动启动');
  });

  it('host 缺席时 list 返回 UNAVAILABLE 而不是抛错', async () => {
    const spec = toolByName(createPlaybookTools(undefined), LIST_PLAYBOOKS_TOOL_NAME);
    const parsed = JSON.parse(await spec.execute({})) as { error: string; message: string };
    expect(parsed.error).toBe('UNAVAILABLE');
    expect(parsed.message.length).toBeGreaterThan(0);
  });

  it('start 空 playbookId（缺省 / 空串 / 全空白 / 非字符串）返回 ok=false，不触达 host', async () => {
    const { host, startCalls } = makeHost();
    const spec = toolByName(createPlaybookTools(host), START_PLAYBOOK_TOOL_NAME);
    for (const args of [{}, { playbookId: '' }, { playbookId: '   ' }, { playbookId: 42 }]) {
      const parsed = JSON.parse(await spec.execute(args as Record<string, unknown>)) as {
        ok: boolean;
        error: string;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('playbookId');
    }
    expect(startCalls).toEqual([]);
  });

  it('host 缺席时 start 返回 ok=false 并提示手动 /playbook 兜底', async () => {
    const spec = toolByName(createPlaybookTools(undefined), START_PLAYBOOK_TOOL_NAME);
    const parsed = JSON.parse(await spec.execute({ playbookId: 'pb.incident' })) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('/playbook');
  });

  it('start 委托 host.start（trim 后透传 id），原样返回 host 结果', async () => {
    const { host, startCalls } = makeHost();
    const spec = toolByName(createPlaybookTools(host), START_PLAYBOOK_TOOL_NAME);
    const parsed = JSON.parse(
      await spec.execute({ playbookId: '  pb.incident  ' })
    ) as PlaybookStartResult;
    expect(startCalls).toEqual(['pb.incident']);
    expect(parsed).toEqual({ ok: true, stage: 'investigating' });
  });

  it('host.start 拒绝（如已有进行中链路）时结果原样透传给模型', async () => {
    const { host } = makeHost({
      start: () => ({ ok: false, error: '已有进行中的 playbook pb.incident，不要叠加启动' })
    });
    const spec = toolByName(createPlaybookTools(host), START_PLAYBOOK_TOOL_NAME);
    const parsed = JSON.parse(await spec.execute({ playbookId: 'pb.release' })) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('不要叠加启动');
  });

  it('异步 host（Promise 返回）同样可用', async () => {
    const host: PlaybookToolHost = {
      list: async () => CATALOG,
      start: async () => ({ ok: true, stage: 'triage' })
    };
    const specs = createPlaybookTools(host);
    const listed = JSON.parse(
      await toolByName(specs, LIST_PLAYBOOKS_TOOL_NAME).execute({})
    ) as { playbooks: PlaybookCatalogEntry[] };
    expect(listed.playbooks).toHaveLength(2);
    const started = JSON.parse(
      await toolByName(specs, START_PLAYBOOK_TOOL_NAME).execute({ playbookId: 'pb.inspection' })
    ) as PlaybookStartResult;
    expect(started).toEqual({ ok: true, stage: 'triage' });
  });

  it('工具描述教模型克制：不因关键词启动、不叠加启动', () => {
    const specs = createPlaybookTools(makeHost().host);
    const list = toolByName(specs, LIST_PLAYBOOKS_TOOL_NAME);
    expect(list.description).toContain('不要启动链路');
    const start = toolByName(specs, START_PLAYBOOK_TOOL_NAME);
    expect(start.description).toContain('不要因为');
    expect(start.description).toContain('不要叠加启动');
    expect(start.parameters).toMatchObject({ type: 'object', required: ['playbookId'] });
  });

  it('P1-7 advance：委托 host.advance（trim 后 stage / 缺省 undefined），结果透传', async () => {
    const advanceCalls: Array<string | undefined> = [];
    const { host } = makeHost({
      advance: (stage?: string): PlaybookStageResult => {
        advanceCalls.push(stage);
        return { ok: true, stage: stage ?? 'mitigating' };
      }
    });
    const spec = toolByName(createPlaybookTools(host), ADVANCE_STAGE_TOOL_NAME);

    const auto = JSON.parse(await spec.execute({})) as PlaybookStageResult;
    expect(auto).toEqual({ ok: true, stage: 'mitigating' });
    const explicit = JSON.parse(await spec.execute({ stage: '  verifying  ' })) as PlaybookStageResult;
    expect(explicit).toEqual({ ok: true, stage: 'verifying' });
    expect(advanceCalls).toEqual([undefined, 'verifying']);

    // 非法迁移：host 返回 ok=false + allowedNext，原样透传（不 throw）
    const { host: strict } = makeHost({
      advance: () => ({
        ok: false,
        stage: 'investigating',
        error: '非法阶段迁移 investigating → closed；允许的下一步：synthesizing, escalated',
        allowedNext: ['synthesizing', 'escalated']
      })
    });
    const rejected = JSON.parse(
      await toolByName(createPlaybookTools(strict), ADVANCE_STAGE_TOOL_NAME).execute({ stage: 'closed' })
    ) as PlaybookStageResult;
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('非法阶段迁移');
    expect(rejected.allowedNext).toEqual(['synthesizing', 'escalated']);
  });

  it('P1-7 close：委托 host.close，结果透传', async () => {
    let closes = 0;
    const { host } = makeHost({
      close: (): PlaybookStageResult => {
        closes += 1;
        return { ok: true, stage: 'closed' };
      }
    });
    const spec = toolByName(createPlaybookTools(host), CLOSE_PLAYBOOK_TOOL_NAME);
    const parsed = JSON.parse(await spec.execute({})) as PlaybookStageResult;
    expect(parsed).toEqual({ ok: true, stage: 'closed' });
    expect(closes).toBe(1);
  });

  it('advance/close：host 缺席或未实现可选方法时返回 ok=false 说明，不抛错', async () => {
    // host 完全缺席
    for (const name of [ADVANCE_STAGE_TOOL_NAME, CLOSE_PLAYBOOK_TOOL_NAME]) {
      const spec = toolByName(createPlaybookTools(undefined), name);
      const parsed = JSON.parse(await spec.execute({})) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('未接线');
    }
    // 旧 host：只有 list/start，没有 advance/close（可选方法）
    const legacy = makeHost().host;
    for (const name of [ADVANCE_STAGE_TOOL_NAME, CLOSE_PLAYBOOK_TOOL_NAME]) {
      const spec = toolByName(createPlaybookTools(legacy), name);
      const parsed = JSON.parse(await spec.execute({})) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
  });
});
