/**
 * Third-party MCP proxy tools (src/mcp-client/external.ts).
 *
 * All connections are injected fakes — nothing here spawns npx or opens
 * sockets. The AT Series dedup gate (filterMcpServers) must hold: skipped
 * entries never reach the connector.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_MCP_PROXY_TOOL_NAMES,
  MAX_TOOL_RESULT_BYTES,
  createExternalMcpProxyTools,
  type ExternalMcpToolInfo,
  type McpConnection,
  type McpConnector,
  type McpServerEntry,
  type ProxyToolSource
} from '../src/mcp-client/external';

async function writeConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'at-ops-mcp-proxy-'));
  await writeFile(join(dir, 'mcp.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

function toolByName(tools: ProxyToolSource[], name: string): ProxyToolSource {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing proxy tool ${name}`);
  return tool;
}

interface FakeServer {
  tools?: ExternalMcpToolInfo[];
  callResult?: unknown;
  failConnect?: boolean;
}

/** Records connector/close/call activity; never spawns anything. */
function fakeConnector(servers: Record<string, FakeServer>) {
  const connects: string[] = [];
  const closes: string[] = [];
  const calls: Array<{ server: string; name: string; args: Record<string, unknown> }> = [];
  const connector: McpConnector = async (entry: McpServerEntry): Promise<McpConnection> => {
    connects.push(entry.name);
    const spec = servers[entry.name];
    if (!spec || spec.failConnect) throw new Error(`connect refused: ${entry.name}`);
    return {
      listTools: async () => spec.tools ?? [],
      callTool: async (name, args) => {
        calls.push({ server: entry.name, name, args });
        if (spec.callResult === undefined) throw new Error(`no such tool: ${name}`);
        return spec.callResult;
      },
      close: async () => {
        closes.push(entry.name);
      }
    };
  };
  return { connector, connects, closes, calls };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createExternalMcpProxyTools — tool surface', () => {
  it('always returns exactly the three proxy tools, even without any config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'at-ops-mcp-none-'));
    const tools = await createExternalMcpProxyTools({ agentDir: dir });
    expect(tools.map((t) => t.name)).toEqual([...EXTERNAL_MCP_PROXY_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('with zero servers every tool answers helpfully instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'at-ops-mcp-none-'));
    const tools = await createExternalMcpProxyTools({ agentDir: dir });

    const list = JSON.parse(await toolByName(tools, 'mcp_list_servers').execute({}));
    expect(list.keep).toEqual([]);
    expect(list.skipped).toEqual([]);
    expect(list.hint).toContain('mcp.json');

    const search = JSON.parse(await toolByName(tools, 'mcp_search_tools').execute({ query: 'x' }));
    expect(search).toMatchObject({ total: 0, returned: 0, tools: [] });
    expect(typeof search.hint).toBe('string');

    const call = JSON.parse(
      await toolByName(tools, 'mcp_call_tool').execute({ server: 'nope', name: 'tool' })
    );
    expect(call.error).toBe('UNKNOWN_SERVER');
    expect(call.message.length).toBeGreaterThan(0);
  });

  it('expands ~ in agentDir using options.home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-ops-mcp-home-'));
    const agentDir = join(home, '.at-series', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ servers: { fs: { command: 'npx' } } })
    );
    const tools = await createExternalMcpProxyTools({ agentDir: '~/.at-series/agent', home });
    const list = JSON.parse(await toolByName(tools, 'mcp_list_servers').execute({}));
    expect(list.keep.map((s: { name: string }) => s.name)).toEqual(['fs']);
  });

  it('surfaces a broken config as a JSON error from every tool (no throw)', async () => {
    const dir = await writeConfig('{ definitely not json');
    const tools = await createExternalMcpProxyTools({ agentDir: dir });
    for (const tool of tools) {
      const out = JSON.parse(await tool.execute({ query: 'x', server: 's', name: 'n' }));
      expect(out.error).toBe('CONFIG_INVALID');
      expect(out.configPath).toContain('mcp.json');
    }
  });
});

describe('createExternalMcpProxyTools — AT Series dedup gate', () => {
  const configWithAtSeries = {
    servers: {
      'AT Series': { command: 'node', args: ['/home/me/.at-series/mcp/hub.js'] },
      'renamed-hub': { command: 'node', args: ['/home/me/.at-series/mcp/hub.js'] },
      docs: { command: 'npx', args: ['-y', 'docs-mcp'] }
    }
  };

  it('lists hub duplicates under skipped with a reason, never as keep', async () => {
    const dir = await writeConfig(configWithAtSeries);
    const { connector } = fakeConnector({ docs: { tools: [] } });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: connector });
    const list = JSON.parse(await toolByName(tools, 'mcp_list_servers').execute({}));
    expect(list.keep.map((s: { name: string }) => s.name)).toEqual(['docs']);
    expect(list.skipped.map((s: { name: string }) => s.name).sort()).toEqual([
      'AT Series',
      'renamed-hub'
    ]);
    expect(list.skipped[0].reason).toContain('AT Series');
  });

  it('never connects a skipped server: search and call refuse before the connector', async () => {
    const dir = await writeConfig(configWithAtSeries);
    const fake = fakeConnector({ docs: { tools: [{ name: 'lookup' }] } });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });

    const search = JSON.parse(
      await toolByName(tools, 'mcp_search_tools').execute({ query: '', server: 'AT Series' })
    );
    expect(search.error).toBe('SERVER_SKIPPED');

    const call = JSON.parse(
      await toolByName(tools, 'mcp_call_tool').execute({ server: 'renamed-hub', name: 'anything' })
    );
    expect(call.error).toBe('SERVER_SKIPPED');

    // A broad search only ever reaches kept servers.
    await toolByName(tools, 'mcp_search_tools').execute({ query: 'lookup' });
    expect(fake.connects).toEqual(['docs']);
  });
});

describe('mcp_search_tools', () => {
  const config = {
    servers: {
      alpha: { command: 'npx', args: ['-y', 'alpha-mcp'] },
      beta: { url: 'https://beta.example.com/mcp' }
    }
  };
  const alphaTools: ExternalMcpToolInfo[] = [
    { name: 'resolve_library', description: 'Resolve a library id' },
    { name: 'get_docs', description: 'Fetch documentation for a library' }
  ];
  const betaTools: ExternalMcpToolInfo[] = [{ name: 'beta_docs', description: 'Beta docs search' }];

  it('lazily connects and matches query against name/description across servers', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({ alpha: { tools: alphaTools }, beta: { tools: betaTools } });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const search = toolByName(tools, 'mcp_search_tools');

    expect(fake.connects).toEqual([]); // creation itself connects nothing

    const out = JSON.parse(await search.execute({ query: 'docs' }));
    expect(fake.connects.sort()).toEqual(['alpha', 'beta']);
    expect(out.total).toBe(2);
    expect(out.tools).toEqual([
      { server: 'alpha', name: 'get_docs', description: 'Fetch documentation for a library' },
      { server: 'beta', name: 'beta_docs', description: 'Beta docs search' }
    ]);

    // Second search reuses the connections.
    await search.execute({ query: 'resolve' });
    expect(fake.connects.length).toBe(2);
  });

  it('respects the server filter and the limit', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({ alpha: { tools: alphaTools }, beta: { tools: betaTools } });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const search = toolByName(tools, 'mcp_search_tools');

    const scoped = JSON.parse(await search.execute({ query: '', server: 'alpha' }));
    expect(scoped.total).toBe(2);
    expect(fake.connects).toEqual(['alpha']);

    const limited = JSON.parse(await search.execute({ query: '', limit: 1 }));
    expect(limited.total).toBe(3);
    expect(limited.returned).toBe(1);
    expect(limited.tools).toHaveLength(1);
  });

  it('reports unknown servers with the configured names', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({});
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const out = JSON.parse(
      await toolByName(tools, 'mcp_search_tools').execute({ query: '', server: 'gamma' })
    );
    expect(out.error).toBe('UNKNOWN_SERVER');
    expect(out.message).toContain('alpha');
    expect(fake.connects).toEqual([]);
  });

  it('returns empty tools plus a hint when a server cannot be connected', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({ alpha: { failConnect: true }, beta: { failConnect: true } });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const out = JSON.parse(await toolByName(tools, 'mcp_search_tools').execute({ query: 'docs' }));
    expect(out.tools).toEqual([]);
    expect(out.notConnected.map((n: { server: string }) => n.server).sort()).toEqual([
      'alpha',
      'beta'
    ]);
    expect(typeof out.hint).toBe('string');
  });
});

describe('mcp_call_tool', () => {
  const config = { servers: { alpha: { command: 'npx', args: ['-y', 'alpha-mcp'] } } };

  it('invokes the tool with the given arguments and returns the result', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({
      alpha: { callResult: { content: [{ type: 'text', text: 'hello' }] } }
    });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const out = JSON.parse(
      await toolByName(tools, 'mcp_call_tool').execute({
        server: 'alpha',
        name: 'get_docs',
        arguments: { library: 'vue' }
      })
    );
    expect(out).toEqual({
      server: 'alpha',
      tool: 'get_docs',
      result: { content: [{ type: 'text', text: 'hello' }] }
    });
    expect(fake.calls).toEqual([{ server: 'alpha', name: 'get_docs', args: { library: 'vue' } }]);
  });

  it('caps oversized results at 8 KB with an explicit truncation marker', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({ alpha: { callResult: 'x'.repeat(64 * 1024) } });
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const raw = await toolByName(tools, 'mcp_call_tool').execute({
      server: 'alpha',
      name: 'dump',
      arguments: {}
    });
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    const out = JSON.parse(raw);
    expect(out.truncated).toBe(true);
    expect(out.resultBytes).toBeGreaterThan(MAX_TOOL_RESULT_BYTES);
    expect(out.resultPreview.length).toBeGreaterThan(0);
  });

  it('turns connector and tool failures into JSON errors instead of rejecting', async () => {
    const dir = await writeConfig(config);
    const fake = fakeConnector({ alpha: {} }); // connects, but has no tools to call
    const tools = await createExternalMcpProxyTools({ agentDir: dir, connectors: fake.connector });
    const call = toolByName(tools, 'mcp_call_tool');

    const noTool = JSON.parse(await call.execute({ server: 'alpha', name: 'missing' }));
    expect(noTool).toMatchObject({ error: 'CALL_FAILED', server: 'alpha', tool: 'missing' });

    const badArgs = JSON.parse(await call.execute({}));
    expect(badArgs.error).toBe('INVALID_ARGS');

    const failing = fakeConnector({ alpha: { failConnect: true } });
    const tools2 = await createExternalMcpProxyTools({
      agentDir: dir,
      connectors: failing.connector
    });
    const refused = JSON.parse(
      await toolByName(tools2, 'mcp_call_tool').execute({ server: 'alpha', name: 'x' })
    );
    expect(refused).toMatchObject({ error: 'CALL_FAILED', server: 'alpha' });
    expect(refused.message).toContain('connect refused');
  });
});

describe('idle disconnect', () => {
  it('closes an unused connection after idleTimeoutMs and reconnects on demand', async () => {
    const dir = await writeConfig({ servers: { alpha: { command: 'npx' } } });
    const fake = fakeConnector({ alpha: { tools: [{ name: 't' }], callResult: 'ok' } });
    const tools = await createExternalMcpProxyTools({
      agentDir: dir,
      connectors: fake.connector,
      idleTimeoutMs: 40
    });
    const call = toolByName(tools, 'mcp_call_tool');
    const list = toolByName(tools, 'mcp_list_servers');

    await call.execute({ server: 'alpha', name: 't' });
    expect(fake.connects).toEqual(['alpha']);
    expect(JSON.parse(await list.execute({})).keep[0].connected).toBe(true);

    await sleep(120);
    expect(fake.closes).toEqual(['alpha']);
    expect(JSON.parse(await list.execute({})).keep[0].connected).toBe(false);

    // Next use reconnects transparently.
    const out = JSON.parse(await call.execute({ server: 'alpha', name: 't' }));
    expect(out.result).toBe('ok');
    expect(fake.connects).toEqual(['alpha', 'alpha']);
  });

  it('keeps the connection alive while it is being used', async () => {
    const dir = await writeConfig({ servers: { alpha: { command: 'npx' } } });
    const fake = fakeConnector({ alpha: { tools: [{ name: 't' }], callResult: 'ok' } });
    const tools = await createExternalMcpProxyTools({
      agentDir: dir,
      connectors: fake.connector,
      idleTimeoutMs: 80
    });
    const call = toolByName(tools, 'mcp_call_tool');
    for (let i = 0; i < 4; i += 1) {
      await call.execute({ server: 'alpha', name: 't' });
      await sleep(30);
    }
    expect(fake.closes).toEqual([]);
    expect(fake.connects).toEqual(['alpha']);
  });
});
