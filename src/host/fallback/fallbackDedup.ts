/**
 * AT Series MCP 去重启发式兜底（真源：src/mcp-client/atSeriesDedup.ts）。
 * 规则见 docs/02-capability-hub.md §5：
 *   1. server name === 'AT Series' → 跳过
 *   2. command+args 规范化后指向 <任意前缀>/.at-series/mcp/hub.js → 跳过
 */
import { MCP_SERVER_DISPLAY_NAME } from '@at-series/mcp-hub';
import type { McpServerEntryLike } from '../hostTypes';

const HUB_JS_SUFFIX_RE = /[\\/]\.at-series[\\/]mcp[\\/]hub\.js$/i;

export function shouldSkipAtSeriesMcpServerFallback(entry: McpServerEntryLike): boolean {
  if (typeof entry.name === 'string' && entry.name.trim() === MCP_SERVER_DISPLAY_NAME) {
    return true;
  }
  const parts = [entry.command, ...(entry.args ?? [])].filter(
    (v): v is string => typeof v === 'string'
  );
  return parts.some((part) => HUB_JS_SUFFIX_RE.test(part.trim().replace(/["']/g, '')));
}
