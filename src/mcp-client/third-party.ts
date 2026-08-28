/**
 * Third-party MCP server classification (phase 4, non-blocking).
 *
 * Connecting user-configured third-party MCP servers (filesystem, internal
 * tooling, ...) is a phase-4 capability and must never block the AT Series
 * path. This module therefore only *classifies* configured servers:
 * it never spawns processes, opens sockets, or touches user secrets, which
 * also keeps it safe to call from unit tests and from extension activation.
 *
 * The single source of skip truth is `shouldSkipAtSeriesMcpServer`
 * (./atSeriesDedup): with the embedded HubHost on, a user entry that
 * duplicates the AT Series hub must not be spawned (`OPS_PROVIDER_SKIPPED`).
 * Everything else lands in `keep` for the (later, phase-4) connect step.
 */
import { shouldSkipAtSeriesMcpServer, type McpServerLike } from './atSeriesDedup';

export interface FilterMcpServersResult<T extends McpServerLike = McpServerLike> {
  /** Servers a phase-4 connector may spawn later; passed through untouched. */
  keep: T[];
  /** Servers skipped because the embedded AT Series HubHost covers them. */
  skipped: T[];
}

/**
 * Split configured MCP servers into `{ keep, skipped }` using
 * `shouldSkipAtSeriesMcpServer` as the only skip criterion. Pure and
 * synchronous — no process is spawned for either bucket.
 */
export function filterMcpServers<T extends McpServerLike>(
  servers: readonly T[]
): FilterMcpServersResult<T> {
  const keep: T[] = [];
  const skipped: T[] = [];
  for (const server of servers) {
    (shouldSkipAtSeriesMcpServer(server) ? skipped : keep).push(server);
  }
  return { keep, skipped };
}

export type McpServerConfigEntry = {
  command?: string;
  args?: string[];
};

/**
 * Convenience for the `mcpServers` map shape used by MCP client configs
 * (`{ "<name>": { command, args } }`). The map key is the server name.
 */
export function filterMcpServerMap(
  servers: Record<string, McpServerConfigEntry>
): FilterMcpServersResult<McpServerLike & { name: string }> {
  return filterMcpServers(
    Object.entries(servers).map(([name, entry]) => ({
      name,
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.args !== undefined ? { args: entry.args } : {})
    }))
  );
}
