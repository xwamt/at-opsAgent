/**
 * Dedup between the embedded AT Series HubHost and user-configured MCP
 * servers (docs/02-capability-hub.md §5, ADR-001).
 *
 * When a user's MCP config already spawns the AT Series hub (`AT Series`
 * entry, or args pointing at `~/.at-series/mcp/hub.js`), the Agent must skip
 * spawning it — the embedded HubHost reads the same registry. Legacy
 * per-plugin entries (`AT Terminal`, ...) are only reported for cleanup,
 * never auto-removed.
 */
import {
  MCP_SERVER_DISPLAY_NAME,
  isLegacyAtMcpServerEntry,
  LEGACY_AT_MCP_SERVER_NAMES,
  normalizeMcpPath
} from '@at-series/mcp-hub';

export { MCP_SERVER_DISPLAY_NAME, LEGACY_AT_MCP_SERVER_NAMES };

export interface McpServerLike {
  name?: string;
  command?: string;
  args?: string[];
}

function pointsAtAtSeriesHub(rawPath: string): boolean {
  const normalized = normalizeMcpPath(rawPath);
  if (normalized.includes('.at-series/mcp/hub.js')) {
    return true;
  }
  // Tolerate layout drift as long as it is unmistakably the AT Series hub.
  return normalized.includes('.at-series/') && normalized.endsWith('/hub.js');
}

/**
 * True when a user-configured MCP server duplicates the embedded AT Series
 * hub and must not be spawned (`OPS_PROVIDER_SKIPPED` path).
 */
export function shouldSkipAtSeriesMcpServer(server: McpServerLike): boolean {
  if (server.name === MCP_SERVER_DISPLAY_NAME) {
    return true;
  }
  const candidates = [server.command, ...(server.args ?? [])];
  return candidates.some((value) => typeof value === 'string' && pointsAtAtSeriesHub(value));
}

/**
 * Server keys in an `mcpServers` map written by legacy per-plugin installers
 * (`AT Terminal` / `AT JumpServer Terminal`, or AT-style `mcp-server.js`
 * args). Callers surface these to the user; they are never deleted here.
 */
export function findLegacyAtMcpServers(servers: Record<string, unknown>): string[] {
  const legacyNames = new Set<string>(LEGACY_AT_MCP_SERVER_NAMES);
  return Object.entries(servers)
    .filter(([key, value]) => legacyNames.has(key) || isLegacyAtMcpServerEntry(key, value))
    .map(([key]) => key);
}
