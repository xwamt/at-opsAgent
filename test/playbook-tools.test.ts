import { describe, expect, it } from 'vitest';

import {
  LIST_PLAYBOOKS_TOOL_NAME,
  START_PLAYBOOK_TOOL_NAME,
  createPlaybookTools,
  type PlaybookCatalogEntry,
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
  it('注册 ops_list_playbooks 与 ops_start_playbook 两个工具（有无 host 都注册）', () => {
    for (const host of [makeHost().host, undefined]) {
      const names = createPlaybookTools(host).map((s) => s.name);
      expect(names).toEqual([LIST_PLAYBOOKS_TOOL_NAME, START_PLAYBOOK_TOOL_NAME]);
    }
  });

  it('playbook 工具是附加工具，不进 5 个 ops_* 发现工具清单', () => {
    expect(discoveryToolNames).toHaveLength(5);
    expect(discoveryToolNames).not.toContain(LIST_PLAYBOOKS_TOOL_NAME);
    expect(discoveryToolNames).not.toContain(START_PLAYBOOK_TOOL_NAME);
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
});
