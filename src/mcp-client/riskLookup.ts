/**
 * Name-keyed risk for the policy gate and tool-call badges.
 *
 * Hub catalog (`listAllTools`) does not contain the three external MCP proxy
 * tools, so a lookup that only reads `descriptor?.risk` fail-closes `mcp_*`
 * list/search as exec. This module lives in mcp-client (not policy) so policy
 * never imports MCP proxy names, and mcp-client never imports policy.
 */
import {
  EXTERNAL_MCP_PROXY_TOOL_NAMES,
  RISK_BY_PROXY_TOOL,
  type ProxyToolRisk
} from './external';

const KNOWN_RISKS: ReadonlySet<string> = new Set(['read', 'write', 'exec']);

export type ResolvedToolRisk = ProxyToolRisk;

/**
 * Resolve a tool's policy risk.
 *
 * 1. Catalog descriptor risk wins when it is a known level.
 * 2. `ops_write_ops_doc` is write (host-built docs tool, not in the hub catalog).
 * 3. Other `ops_*` discovery/meta tools are read (even when absent from the hub).
 * 4. External MCP proxy tools use {@link RISK_BY_PROXY_TOOL}
 *    (`mcp_list_servers` / `mcp_search_tools` = read, `mcp_call_tool` = write).
 * 5. Everything else fail-closes to exec.
 */
export function resolveToolRisk(
  toolName: string,
  descriptor?: { risk?: string }
): ResolvedToolRisk {
  if (descriptor?.risk && KNOWN_RISKS.has(descriptor.risk)) {
    return descriptor.risk as ResolvedToolRisk;
  }
  if (toolName === 'ops_write_ops_doc') return 'write';
  if (toolName.startsWith('ops_')) return 'read';
  if ((EXTERNAL_MCP_PROXY_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return RISK_BY_PROXY_TOOL[toolName as keyof typeof RISK_BY_PROXY_TOOL];
  }
  return 'exec';
}
