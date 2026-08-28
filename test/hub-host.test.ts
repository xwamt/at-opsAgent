import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeRegistryRecord, ListProvidersResult as HubListProvidersResult, ToolCatalogEntry } from '@at-series/mcp-hub';
import {
  createAtSeriesHubHost,
  mapHubProviders,
  toolAnnotationsForRisk
} from '../src/hub-host';
import { shouldSkipAtSeriesMcpServer } from '../src/mcp-client/atSeriesDedup';
import type { HubHost, ToolChangeEvent } from '../src/protocol';

const HOST_APP = 'vscode';
const TOKEN = 'test-bridge-token-0123456789abcdef0123456789abcdef';

const BRIDGE_TOOLS: ToolCatalogEntry[] = [
  {
    name: 'grafana_list_instances',
    title: 'List Grafana instances',
    description: 'List registered Grafana instances.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'grafana_cancelled_call',
    title: 'Always cancelled',
    description: 'Bridge replies USER_CANCELLED for this tool.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'db_execute_query',
    title: 'Execute query',
    description: 'Bridge replies 200 with an ok:false body (At-Database compat).',
    risk: 'write',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } }
  }
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(25);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const invokedNames: string[] = [];

function fakeBridgeHandler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, connectedTargets: 1 });
      return;
    }
    if (req.method === 'GET' && req.url === '/tools') {
      sendJson(res, 200, { protocolVersion: 1, tools: BRIDGE_TOOLS });
      return;
    }
    if (req.method === 'POST' && req.url === '/invoke') {
      if (req.headers['x-at-series-token'] !== TOKEN) {
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'invalid token' } });
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name: string };
      invokedNames.push(body.name);
      if (body.name === 'grafana_list_instances') {
        sendJson(res, 200, { ok: true, name: body.name, result: { instances: [] } });
        return;
      }
      if (body.name === 'grafana_cancelled_call') {
        sendJson(res, 499, {
          error: { code: 'USER_CANCELLED', message: 'User dismissed the confirmation dialog' }
        });
        return;
      }
      if (body.name === 'db_execute_query') {
        // At-Database quirk: app-level failure inside a 2xx `result`.
        sendJson(res, 200, {
          ok: true,
          name: body.name,
          result: { ok: false, error: { code: 'DB_ERROR', message: 'permission denied for table orders' } }
        });
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Unknown tool: ${body.name}` } });
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  });
}

describe('AtSeriesHubHost (against a fake Bridge)', () => {
  let home: string;
  let server: Server;
  let port: number;
  let host: HubHost;

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'at-ops-hub-host-'));

    server = createServer(fakeBridgeHandler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake bridge did not bind a TCP port');
    }
    port = address.port;

    const record: BridgeRegistryRecord = {
      protocolVersion: 1,
      bridgeId: randomUUID(),
      pluginId: 'at.grafana',
      pluginDisplayName: 'AT Grafana',
      pluginVersion: '1.2.3',
      hostApp: HOST_APP,
      port,
      token: TOKEN,
      pid: process.pid,
      updatedAt: Date.now(), // fresh heartbeat — records older than 90s are stale
      tools: BRIDGE_TOOLS,
      capabilities: { connectedTargets: 1 }
    };
    const bridgesDir = path.join(home, '.at-series', 'bridges', HOST_APP);
    await mkdir(bridgesDir, { recursive: true });
    await writeFile(
      path.join(bridgesDir, `${record.bridgeId}.json`),
      JSON.stringify(record, null, 2),
      'utf8'
    );

    host = createAtSeriesHubHost({ hostApp: HOST_APP, home });
    await host.start();
    await waitFor(
      () => host.getProviders().providers.some((p) => p.pluginId === 'at.grafana'),
      3000
    );
  });

  afterAll(async () => {
    host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sleep(50); // let the runtime's audit logger finish flushing into tmp home
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('discovers the at.grafana provider from the registry record', () => {
    const providers = host.getProviders();
    expect(providers.hostApp).toBe(HOST_APP);
    const grafana = providers.providers.find((p) => p.pluginId === 'at.grafana');
    expect(grafana).toBeDefined();
    expect(grafana).toMatchObject({
      displayName: 'AT Grafana',
      healthy: true,
      bridgeCount: 1,
      connectedTargets: 1,
      pluginVersion: '1.2.3'
    });
    expect(grafana?.toolNames).toContain('grafana_list_instances');
  });

  it('lists winner business tools with pluginId, risk and annotations (no at_* meta)', () => {
    const all = host.listAllTools();
    expect(all.map((t) => t.name).sort()).toEqual([
      'db_execute_query',
      'grafana_cancelled_call',
      'grafana_list_instances'
    ]);
    expect(all.every((t) => !t.name.startsWith('at_'))).toBe(true);
    const listInstances = all.find((t) => t.name === 'grafana_list_instances');
    expect(listInstances).toMatchObject({
      pluginId: 'at.grafana',
      risk: 'read',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    });
    const executeQuery = all.find((t) => t.name === 'db_execute_query');
    expect(executeQuery).toMatchObject({
      risk: 'write',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    });
  });

  it('exposes the winner set (auto mode, under threshold) without at_* meta tools', () => {
    const exposed = host.listExposedTools();
    expect(exposed.map((t) => t.name).sort()).toEqual([
      'db_execute_query',
      'grafana_cancelled_call',
      'grafana_list_instances'
    ]);
    expect(exposed.every((t) => !t.name.startsWith('at_'))).toBe(true);
  });

  it('invokes grafana_list_instances through the Hub and returns the bridge result', async () => {
    const res = await host.invoke({ name: 'grafana_list_instances', arguments: {} });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ instances: [] });
    expect(res.error).toBeUndefined();
    expect(res.attemptCount).toBeGreaterThanOrEqual(1);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(invokedNames).toContain('grafana_list_instances');
  });

  it('passes USER_CANCELLED through as a cancelled invocation, not a generic error', async () => {
    const res = await host.invoke({ name: 'grafana_cancelled_call', arguments: {} });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('USER_CANCELLED');
    expect(res.error?.message).toContain('dismissed');
  });

  it('normalizes At-Database 2xx ok:false bodies onto OPS_DATABASE_OK_FALSE', async () => {
    const res = await host.invoke({ name: 'db_execute_query', arguments: { sql: 'SELECT 1' } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('OPS_DATABASE_OK_FALSE');
    expect(res.error?.message).toBe('permission denied for table orders');
  });

  it('returns NOT_FOUND for unknown tools', async () => {
    const res = await host.invoke({ name: 'no_such_tool', arguments: {} });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('maps an already-aborted invocation to USER_CANCELLED without hitting the bridge', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = invokedNames.length;
    const res = await host.invoke({
      name: 'grafana_list_instances',
      arguments: {},
      abort: controller.signal
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('USER_CANCELLED');
    expect(invokedNames.length).toBe(before);
  });

  it('routes at_* meta tools through runtime.callTool', async () => {
    const res = await host.invoke({ name: 'at_list_providers', arguments: {} });
    expect(res.ok).toBe(true);
    const parsed = res.result as HubListProvidersResult;
    expect(parsed.providers.some((p) => p.pluginId === 'at.grafana')).toBe(true);
  });

  it('drives selection via at_select_tools / at_clear_tool_selection and diffs exposure', async () => {
    // Progressive exposure is only observable in `always` mode with 3 tools.
    const progressive = createAtSeriesHubHost({ hostApp: HOST_APP, home, discoveryMode: 'always' });
    try {
      await progressive.start();
      await waitFor(() => progressive.listAllTools().length === BRIDGE_TOOLS.length, 3000);
      expect(progressive.listExposedTools()).toHaveLength(0);

      const events: ToolChangeEvent[] = [];
      progressive.onDidChangeTools((e) => events.push(e));

      const selected = await progressive.selection.select({ names: ['grafana_list_instances'] });
      expect(selected.selected).toEqual(['grafana_list_instances']);
      expect(selected.exposed).toEqual(['grafana_list_instances']);
      expect(progressive.listExposedTools().map((t) => t.name)).toEqual(['grafana_list_instances']);
      expect(events.some((e) => e.added.includes('grafana_list_instances'))).toBe(true);
      expect(progressive.selection.state().selected).toEqual(['grafana_list_instances']);

      await progressive.selection.clear();
      expect(progressive.listExposedTools()).toHaveLength(0);
      expect(events.some((e) => e.removed.includes('grafana_list_instances'))).toBe(true);
      expect(progressive.selection.state().selected).toEqual([]);
    } finally {
      progressive.dispose();
    }
  });

  it('refresh() re-reads the catalog on demand', async () => {
    await host.refresh();
    expect(host.getProviders().providers.some((p) => p.pluginId === 'at.grafana')).toBe(true);
  });
});

describe('toolAnnotationsForRisk', () => {
  it('maps read to readOnlyHint', () => {
    expect(toolAnnotationsForRisk('read')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true
    });
  });

  it('maps write to neither hint', () => {
    expect(toolAnnotationsForRisk('write')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    });
  });

  it('maps exec to destructiveHint', () => {
    expect(toolAnnotationsForRisk('exec')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
  });

  it('fails closed: unknown risk is treated as exec', () => {
    expect(toolAnnotationsForRisk(undefined)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    });
  });
});

describe('mapHubProviders', () => {
  it('maps the Hub ListProvidersResult onto the simplified Agent shape', () => {
    const hubResult: HubListProvidersResult = {
      hostApp: 'vscode',
      hubVersion: '0.1.0-ops-agent',
      protocolVersion: 2,
      providers: [
        {
          pluginId: 'at.grafana',
          pluginDisplayName: 'AT Grafana',
          pluginVersion: '1.2.3',
          bridges: [
            { bridgeId: 'b-1', status: 'healthy', connectedTargets: 2, toolCount: 17 },
            { bridgeId: 'b-2', status: 'unhealthy' }
          ],
          tools: ['grafana_list_instances'],
          conflicts: []
        },
        {
          pluginId: 'at.jenkins',
          pluginDisplayName: 'AT Jenkins',
          bridges: [{ bridgeId: 'b-3', status: 'unhealthy' }],
          tools: [],
          conflicts: []
        }
      ],
      ignoredUnscopedBridgeCount: 0
    };

    expect(mapHubProviders(hubResult)).toEqual({
      hostApp: 'vscode',
      providers: [
        {
          pluginId: 'at.grafana',
          displayName: 'AT Grafana',
          healthy: true,
          bridgeCount: 2,
          connectedTargets: 2,
          toolNames: ['grafana_list_instances'],
          pluginVersion: '1.2.3'
        },
        {
          pluginId: 'at.jenkins',
          displayName: 'AT Jenkins',
          healthy: false,
          bridgeCount: 1,
          toolNames: []
        }
      ]
    });
  });

  it('returns an empty provider list untouched', () => {
    const empty: HubListProvidersResult = {
      hostApp: 'cursor',
      hubVersion: '0.1.0-ops-agent',
      protocolVersion: 2,
      providers: [],
      ignoredUnscopedBridgeCount: 0
    };
    expect(mapHubProviders(empty)).toEqual({ hostApp: 'cursor', providers: [] });
  });
});

describe('shouldSkipAtSeriesMcpServer (embedded takeover)', () => {
  it('skips a server named AT Series', () => {
    expect(shouldSkipAtSeriesMcpServer({ name: 'AT Series' })).toBe(true);
  });

  it('skips servers whose args point at ~/.at-series/mcp/hub.js', () => {
    expect(
      shouldSkipAtSeriesMcpServer({
        name: 'my-hub',
        command: 'node',
        args: ['/home/me/.at-series/mcp/hub.js']
      })
    ).toBe(true);
    expect(
      shouldSkipAtSeriesMcpServer({
        command: 'node',
        args: ['C:\\Users\\me\\.at-series\\mcp\\hub.js']
      })
    ).toBe(true);
  });

  it('does not skip unrelated servers', () => {
    expect(
      shouldSkipAtSeriesMcpServer({
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
      })
    ).toBe(false);
  });
});
