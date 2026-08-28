import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_DISPLAY_NAME as HUB_MCP_SERVER_DISPLAY_NAME } from '@at-series/mcp-hub';
import {
  MCP_SERVER_DISPLAY_NAME,
  LEGACY_AT_MCP_SERVER_NAMES,
  findLegacyAtMcpServers,
  shouldSkipAtSeriesMcpServer
} from '../src/mcp-client/atSeriesDedup';
import { filterMcpServerMap, filterMcpServers } from '../src/mcp-client/third-party';
import { loadMcpConfig } from '../src/mcp-client/external';

describe('AT Series MCP server constants', () => {
  it('re-exports the Hub display name and it equals "AT Series"', () => {
    expect(HUB_MCP_SERVER_DISPLAY_NAME).toBe('AT Series');
    expect(MCP_SERVER_DISPLAY_NAME).toBe(HUB_MCP_SERVER_DISPLAY_NAME);
  });

  it('knows the legacy per-plugin server names', () => {
    expect([...LEGACY_AT_MCP_SERVER_NAMES]).toEqual(['AT Terminal', 'AT JumpServer Terminal']);
  });
});

describe('shouldSkipAtSeriesMcpServer', () => {
  it('skips by exact server name', () => {
    expect(shouldSkipAtSeriesMcpServer({ name: MCP_SERVER_DISPLAY_NAME })).toBe(true);
    expect(shouldSkipAtSeriesMcpServer({ name: 'at series' })).toBe(false);
  });

  it('skips when args point at .at-series/mcp/hub.js (posix and windows)', () => {
    expect(
      shouldSkipAtSeriesMcpServer({
        name: 'renamed-entry',
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

  it('skips when the command itself is the hub bundle', () => {
    expect(shouldSkipAtSeriesMcpServer({ command: '/home/me/.at-series/mcp/hub.js' })).toBe(true);
  });

  it('does not skip legacy per-plugin entries (they are reported, not taken over)', () => {
    expect(
      shouldSkipAtSeriesMcpServer({
        name: 'AT Terminal',
        command: 'node',
        args: ['/home/me/.vscode/extensions/local.at-terminal-1.0.0/dist/mcp-server.js']
      })
    ).toBe(false);
  });

  it('does not skip unrelated servers, including other hub.js paths', () => {
    expect(
      shouldSkipAtSeriesMcpServer({
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
      })
    ).toBe(false);
    expect(
      shouldSkipAtSeriesMcpServer({
        name: 'other-hub',
        command: 'node',
        args: ['/opt/some-vendor/mcp/hub.js']
      })
    ).toBe(false);
    expect(shouldSkipAtSeriesMcpServer({})).toBe(false);
  });
});

describe('findLegacyAtMcpServers', () => {
  it('flags legacy names and AT-style mcp-server.js entries, keeps everything else', () => {
    const servers: Record<string, unknown> = {
      'AT Series': {
        command: 'node',
        args: ['/home/me/.at-series/mcp/hub.js']
      },
      'AT Terminal': {
        command: 'node',
        args: ['/home/me/.vscode/extensions/local.at-terminal-1.0.0/dist/mcp-server.js']
      },
      'AT JumpServer Terminal': {
        command: 'node',
        args: ['/home/me/.vscode/extensions/local.at-jumpserver-1.0.0/dist/mcp-server.js']
      },
      'my terminal (renamed)': {
        command: 'node',
        args: ['/home/me/.vscode/extensions/local.at-terminal-2.0.0/dist/mcp-server.js']
      },
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
      }
    };

    expect(findLegacyAtMcpServers(servers).sort()).toEqual([
      'AT JumpServer Terminal',
      'AT Terminal',
      'my terminal (renamed)'
    ]);
  });

  it('returns an empty list for an empty or clean map', () => {
    expect(findLegacyAtMcpServers({})).toEqual([]);
    expect(
      findLegacyAtMcpServers({
        'AT Series': { command: 'node', args: ['/home/me/.at-series/mcp/hub.js'] }
      })
    ).toEqual([]);
  });
});

describe('filterMcpServers (phase-4 helper, classification only)', () => {
  const atSeriesByName = { name: MCP_SERVER_DISPLAY_NAME };
  const atSeriesByPath = {
    name: 'renamed-hub',
    command: 'node',
    args: ['/home/me/.at-series/mcp/hub.js']
  };
  const filesystem = {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
  };
  const legacyTerminal = {
    name: 'AT Terminal',
    command: 'node',
    args: ['/home/me/.vscode/extensions/local.at-terminal-1.0.0/dist/mcp-server.js']
  };

  it('splits servers into keep/skipped using shouldSkipAtSeriesMcpServer as the only truth', () => {
    const input = [atSeriesByName, atSeriesByPath, filesystem, legacyTerminal];
    const { keep, skipped } = filterMcpServers(input);
    for (const server of input) {
      expect(skipped.includes(server)).toBe(shouldSkipAtSeriesMcpServer(server));
    }
    expect(skipped).toEqual([atSeriesByName, atSeriesByPath]);
    // Legacy per-plugin entries are kept (reported elsewhere, never taken over).
    expect(keep).toEqual([filesystem, legacyTerminal]);
  });

  it('passes kept servers through by reference — it never copies, connects, or spawns', () => {
    const { keep, skipped } = filterMcpServers([filesystem]);
    expect(keep[0]).toBe(filesystem);
    expect(skipped).toEqual([]);
  });

  it('handles an empty list', () => {
    expect(filterMcpServers([])).toEqual({ keep: [], skipped: [] });
  });

  it('filterMcpServerMap uses the mcpServers map key as the server name', () => {
    const { keep, skipped } = filterMcpServerMap({
      'AT Series': { command: 'node', args: ['/home/me/.at-series/mcp/hub.js'] },
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      'no-command-entry': {}
    });
    expect(skipped.map((s) => s.name)).toEqual(['AT Series']);
    expect(keep.map((s) => s.name).sort()).toEqual(['filesystem', 'no-command-entry']);
  });
});

describe('loadMcpConfig', () => {
  async function writeConfig(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'at-ops-mcp-'));
    await writeFile(join(dir, 'mcp.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return dir;
  }

  it('loads the documented { servers } shape with stdio and http entries', async () => {
    const dir = await writeConfig({
      servers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: { API_KEY: 'k' },
          cwd: '/tmp',
          directTools: []
        },
        remote: {
          url: 'https://mcp.example.com/mcp',
          headers: { 'X-Tenant': 'sre' },
          bearerToken: 'secret'
        }
      }
    });
    const entries = await loadMcpConfig(dir);
    expect(entries.map((e) => e.name).sort()).toEqual(['context7', 'remote']);
    const context7 = entries.find((e) => e.name === 'context7')!;
    expect(context7.command).toBe('npx');
    expect(context7.args).toEqual(['-y', '@upstash/context7-mcp']);
    expect(context7.env).toEqual({ API_KEY: 'k' });
    expect(context7.cwd).toBe('/tmp');
    expect(context7.directTools).toEqual([]);
    const remote = entries.find((e) => e.name === 'remote')!;
    expect(remote.url).toBe('https://mcp.example.com/mcp');
    expect(remote.headers).toEqual({ 'X-Tenant': 'sre' });
    expect(remote.bearerToken).toBe('secret');
  });

  it('accepts the Cursor-shaped { mcpServers } map', async () => {
    const dir = await writeConfig({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }
      }
    });
    const entries = await loadMcpConfig(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('filesystem');
    expect(entries[0].command).toBe('npx');
  });

  it('merges both shapes with { servers } winning on name conflicts', async () => {
    const dir = await writeConfig({
      mcpServers: {
        dupe: { command: 'old-command' },
        onlyCursor: { command: 'cursor-only' }
      },
      servers: {
        dupe: { command: 'new-command' },
        onlyServers: { command: 'servers-only' }
      }
    });
    const entries = await loadMcpConfig(dir);
    expect(entries.map((e) => e.name).sort()).toEqual(['dupe', 'onlyCursor', 'onlyServers']);
    expect(entries.find((e) => e.name === 'dupe')!.command).toBe('new-command');
  });

  it('skips entries with disabled: true and non-object entries', async () => {
    const dir = await writeConfig({
      servers: {
        active: { command: 'npx', args: ['-y', 'some-mcp'] },
        off: { command: 'npx', args: ['-y', 'other-mcp'], disabled: true },
        junk: 'not-an-entry'
      }
    });
    const entries = await loadMcpConfig(dir);
    expect(entries.map((e) => e.name)).toEqual(['active']);
  });

  it('returns [] when mcp.json does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'at-ops-mcp-empty-'));
    await expect(loadMcpConfig(dir)).resolves.toEqual([]);
  });

  it('rejects on malformed JSON and a non-object root', async () => {
    await expect(loadMcpConfig(await writeConfig('{ not json'))).rejects.toThrow(/JSON/);
    await expect(loadMcpConfig(await writeConfig('[1, 2]'))).rejects.toThrow(/对象/);
  });

  it('loaded entries feed straight into filterMcpServers (AT Series still skipped)', async () => {
    const dir = await writeConfig({
      servers: {
        'AT Series': { command: 'node', args: ['/home/me/.at-series/mcp/hub.js'] },
        'renamed-hub': { command: 'node', args: ['C:\\Users\\me\\.at-series\\mcp\\hub.js'] },
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }
      }
    });
    const { keep, skipped } = filterMcpServers(await loadMcpConfig(dir));
    expect(skipped.map((s) => s.name).sort()).toEqual(['AT Series', 'renamed-hub']);
    expect(keep.map((s) => s.name)).toEqual(['filesystem']);
  });
});
