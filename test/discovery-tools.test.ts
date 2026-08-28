/**
 * 发现层 P0 回归（docs/13）：live catalog 为空但插件已声明工具时，
 * list_providers / search_tools / get_tool 必须把模型引向 ops_select_tools，
 * 而不是 total:0 / NOT_FOUND 空转。
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentToolDescriptor,
  ListProvidersResult,
  SelectToolsInput,
  SelectionState,
  ToolInvocation,
  ToolInvocationResult
} from '../src/protocol';
import {
  STUB_HIT_DESCRIPTION,
  discoveryToolSpecs,
  executeDiscoveryTool,
  getTool,
  listProviders,
  searchTools,
  type DiscoveryHub,
  type NotInLiveCatalogError
} from '../src/runtime/discovery-tools';

// ── 假 hub ───────────────────────────────────────────────────────────────

function descriptor(overrides: Partial<AgentToolDescriptor> & { name: string }): AgentToolDescriptor {
  return {
    title: overrides.name,
    description: `${overrides.name} description`,
    inputSchema: { type: 'object', properties: {} },
    risk: 'read',
    pluginId: 'at.terminal',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    ...overrides
  };
}

const TERMINAL_TOOL_NAMES = ['list_ssh_servers', 'get_terminal_context', 'run_remote_command'];

/** 实录场景：4 座桥全部 unhealthy，但 manifest 已声明工具名。 */
const unhealthyTerminal: ListProvidersResult['providers'][number] = {
  pluginId: 'at.terminal',
  displayName: 'AT Terminal',
  healthy: false,
  bridgeCount: 4,
  toolNames: [...TERMINAL_TOOL_NAMES]
};

interface FakeHub extends DiscoveryHub {
  selectCalls: SelectToolsInput[];
}

function makeHub(options: {
  tools?: AgentToolDescriptor[];
  providers?: ListProvidersResult['providers'];
} = {}): FakeHub {
  const tools = options.tools ?? [];
  const providers = options.providers ?? [unhealthyTerminal];
  const state: SelectionState = {
    mode: 'auto',
    threshold: 20,
    selected: [],
    exposedBusinessToolCount: 0,
    idleMs: 0,
    maxCalls: 0
  };
  const hub: FakeHub = {
    selectCalls: [],
    listAllTools: () => tools,
    listExposedTools: () => [],
    getProviders: (): ListProvidersResult => ({ hostApp: 'vscode', providers }),
    invoke: async (inv: ToolInvocation): Promise<ToolInvocationResult> => ({
      ok: true,
      result: { echoed: inv.name },
      attemptCount: 1,
      durationMs: 1
    }),
    selection: {
      state: () => state,
      select: async (input: SelectToolsInput) => {
        hub.selectCalls.push(input);
        return { selected: input.pluginIds ?? input.names ?? [], exposed: [] };
      },
      clear: async () => {},
      onDidChange: () => ({ dispose() {} })
    }
  };
  return hub;
}

// ── listProviders：包装 + hint ───────────────────────────────────────────

describe('listProviders 包装 hub.getProviders()', () => {
  it('catalog 空 + 有声明工具：catalogLiveToolCount=0、liveToolCount=0、顶层 hint 指向 ops_select_tools', () => {
    const hub = makeHub();
    const result = listProviders(hub);
    expect(result.hostApp).toBe('vscode');
    expect(result.catalogLiveToolCount).toBe(0);
    expect(result.providers).toHaveLength(1);
    // 保留原有 provider 字段，只追加 liveToolCount
    expect(result.providers[0]).toMatchObject(unhealthyTerminal);
    expect(result.providers[0].liveToolCount).toBe(0);
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('ops_select_tools');
    expect(result.hint).toContain('at.terminal');
    expect(result.hint).toContain('不要');
    expect(result.hint).toContain('桥未就绪');
  });

  it('live catalog 非空：liveToolCount 按声明名 ∩ live catalog 计数，无 hint', () => {
    const hub = makeHub({
      tools: [descriptor({ name: 'list_ssh_servers' }), descriptor({ name: 'get_terminal_context' })],
      providers: [{ ...unhealthyTerminal, healthy: true }]
    });
    const result = listProviders(hub);
    expect(result.catalogLiveToolCount).toBe(2);
    expect(result.providers[0].liveToolCount).toBe(2);
    expect(result.hint).toBeUndefined();
  });

  it('catalog 空且无任何声明工具：不加 hint', () => {
    const hub = makeHub({ providers: [{ ...unhealthyTerminal, toolNames: [] }] });
    const result = listProviders(hub);
    expect(result.catalogLiveToolCount).toBe(0);
    expect(result.hint).toBeUndefined();
  });
});

// ── searchTools：live 优先，未命中回退声明 stub ──────────────────────────

describe('searchTools 声明清单 stub 回退', () => {
  it('catalog 空 + at.terminal 声明 list_ssh_servers：搜索必须返回 stub 命中', () => {
    const hub = makeHub();
    const result = searchTools(hub, { query: 'list_ssh_servers' });
    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.tools[0]).toEqual({
      name: 'list_ssh_servers',
      title: 'list_ssh_servers',
      pluginId: 'at.terminal',
      risk: 'read',
      descriptionPreview: STUB_HIT_DESCRIPTION,
      live: false
    });
    expect(STUB_HIT_DESCRIPTION).toContain('ops_select_tools');
  });

  it('pluginId 过滤同样作用于 stub', () => {
    const hub = makeHub();
    const scoped = searchTools(hub, { query: 'list_ssh_servers', pluginId: 'at.other' });
    expect(scoped.total).toBe(0);
    expect(scoped.tools).toEqual([]);
  });

  it('query 命中插件 displayName / pluginId 时，该插件全部未 live 声明名都作 stub', () => {
    const hub = makeHub();
    const result = searchTools(hub, { query: 'terminal' });
    expect(result.tools.map((t) => t.name).sort()).toEqual([...TERMINAL_TOOL_NAMES].sort());
    expect(result.tools.every((t) => t.live === false)).toBe(true);
  });

  it('空 query + catalog 空：返回全部声明 stub', () => {
    const hub = makeHub();
    const result = searchTools(hub, { query: '' });
    expect(result.total).toBe(TERMINAL_TOOL_NAMES.length);
  });

  it('live catalog 命中时保持现有行为（live:true，不混 stub）', () => {
    const hub = makeHub({
      tools: [descriptor({ name: 'list_ssh_servers', description: '列出已连接的 SSH 服务器。' })]
    });
    const result = searchTools(hub, { query: 'list_ssh_servers' });
    expect(result.total).toBe(1);
    expect(result.tools[0]).toMatchObject({
      name: 'list_ssh_servers',
      pluginId: 'at.terminal',
      live: true,
      descriptionPreview: '列出已连接的 SSH 服务器。'
    });
  });

  it('stub 回退跳过已 live 的名字，只补声明未 live 的', () => {
    const hub = makeHub({
      tools: [descriptor({ name: 'list_ssh_servers' })]
    });
    const result = searchTools(hub, { query: 'get_terminal_context' });
    expect(result.tools).toEqual([
      {
        name: 'get_terminal_context',
        title: 'get_terminal_context',
        pluginId: 'at.terminal',
        risk: 'read',
        descriptionPreview: STUB_HIT_DESCRIPTION,
        live: false
      }
    ]);
  });
});

// ── getTool：NOT_IN_LIVE_CATALOG vs NOT_FOUND ────────────────────────────

describe('getTool 声明未 live 的结构化引导', () => {
  it('live catalog 命中：原样返回 descriptor（现有行为不变）', () => {
    const live = descriptor({ name: 'list_ssh_servers' });
    const hub = makeHub({ tools: [live] });
    expect(getTool(hub, 'list_ssh_servers')).toBe(live);
  });

  it('声明未 live：NOT_IN_LIVE_CATALOG + pluginId + healthy + next=ops_select_tools', () => {
    const hub = makeHub();
    const result = getTool(hub, 'list_ssh_servers') as NotInLiveCatalogError;
    expect(result.error).toBe('NOT_IN_LIVE_CATALOG');
    expect(result.pluginId).toBe('at.terminal');
    expect(result.healthy).toBe(false);
    expect(result.next).toEqual({
      tool: 'ops_select_tools',
      args: { pluginIds: ['at.terminal'], mode: 'add' }
    });
    expect(result.message).toContain('at.terminal');
    expect(result.message).toContain('healthy=false');
    expect(result.message).toContain('ops_select_tools');
  });

  it('无插件声明的名字才 NOT_FOUND', () => {
    const hub = makeHub();
    expect(getTool(hub, 'totally_unknown_tool')).toMatchObject({ error: 'NOT_FOUND' });
  });
});

// ── spec 描述 + executeDiscoveryTool 端到端 JSON ─────────────────────────

describe('DiscoveryToolSpec 描述与 execute 输出', () => {
  it('ops_get_tool / ops_search_tools 描述：声明名直接 select，禁止循环 get/search', () => {
    const getSpec = discoveryToolSpecs.find((s) => s.name === 'ops_get_tool');
    const searchSpec = discoveryToolSpecs.find((s) => s.name === 'ops_search_tools');
    expect(getSpec?.description).toContain('ops_select_tools');
    expect(getSpec?.description).toContain('禁止');
    expect(searchSpec?.description).toContain('ops_select_tools');
    expect(searchSpec?.description).toContain('禁止');
  });

  it('executeDiscoveryTool 输出的 JSON 含 hint / NOT_IN_LIVE_CATALOG / stub', async () => {
    const hub = makeHub();
    const providersOut = JSON.parse(await executeDiscoveryTool(hub, 'ops_list_providers'));
    expect(providersOut.catalogLiveToolCount).toBe(0);
    expect(providersOut.hint).toContain('ops_select_tools');

    const getOut = JSON.parse(await executeDiscoveryTool(hub, 'ops_get_tool', { name: 'list_ssh_servers' }));
    expect(getOut).toMatchObject({ error: 'NOT_IN_LIVE_CATALOG', pluginId: 'at.terminal', healthy: false });

    const searchOut = JSON.parse(await executeDiscoveryTool(hub, 'ops_search_tools', { query: 'list_ssh_servers' }));
    expect(searchOut.total).toBe(1);
    expect(searchOut.tools[0].live).toBe(false);
  });
});
