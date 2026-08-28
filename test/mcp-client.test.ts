import { describe, expect, it } from 'vitest';
import { MCP_SERVER_DISPLAY_NAME as HUB_MCP_SERVER_DISPLAY_NAME } from '@at-series/mcp-hub';
import {
  MCP_SERVER_DISPLAY_NAME,
  LEGACY_AT_MCP_SERVER_NAMES,
  findLegacyAtMcpServers,
  shouldSkipAtSeriesMcpServer
} from '../src/mcp-client/atSeriesDedup';

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
