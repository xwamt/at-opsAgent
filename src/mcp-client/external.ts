/**
 * Third-party (non-AT) MCP client: config loading + `search`/`call` proxy
 * tools (docs/03-agent-runtime.md §8, docs/02-capability-hub.md §5,
 * docs/09-extensibility.md §4).
 *
 * Config lives in `<agentDir>/mcp.json` (default `~/.at-series/agent/mcp.json`)
 * as `{ "servers": { "<name>": {...} } }`; the Cursor-style
 * `{ "mcpServers": { ... } }` map is accepted too. Every entry is run through
 * `filterMcpServers` / `shouldSkipAtSeriesMcpServer` so the embedded AT Series
 * hub (`hub.js`) is never spawned from here — skipped entries are only
 * reported, never connected.
 *
 * To avoid tool explosion the servers are exposed to the model through three
 * proxy tools (`mcp_list_servers` / `mcp_search_tools` / `mcp_call_tool`),
 * mirroring the pi-mcp search+call pattern. This is deliberately a separate
 * mechanism from the Hub's `ops_*` progressive discovery. `directTools` from
 * the config is parsed and surfaced but direct (first-class) registration is a
 * later phase — the proxy always returns exactly these three tools.
 *
 * Connections are lazy (first search/call), keyed by server name, and closed
 * after {@link DEFAULT_IDLE_TIMEOUT_MS} of inactivity. The
 * `@modelcontextprotocol/sdk` is loaded via dynamic import at connect time; if
 * the SDK (or the connection) is unavailable the tools still exist and their
 * `execute` resolves to a JSON error string — they never reject.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import type { McpServerLike } from './atSeriesDedup';
import { filterMcpServers } from './third-party';

// ── config ───────────────────────────────────────────────────────────────

/** One configured third-party MCP server (stdio or Streamable HTTP). */
export interface McpServerEntry extends McpServerLike {
  name: string;
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  /**
   * Optional allowlist of tools to expose directly (first-class) instead of
   * via the search/call proxy. Parsed and surfaced only; direct registration
   * is a later phase (docs/02 §5: proxy and directTools stay two mechanisms).
   */
  directTools?: string[];
}

export const MCP_CONFIG_FILE_NAME = 'mcp.json';

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(home, path.slice(2));
  }
  return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function normalizeEntry(name: string, raw: unknown): McpServerEntry | undefined {
  if (!isPlainObject(raw) || name.length === 0) return undefined;
  if (raw.disabled === true) return undefined; // `disabled: true` skips
  const entry: McpServerEntry = { name };
  if (typeof raw.command === 'string' && raw.command.length > 0) entry.command = raw.command;
  const args = stringArray(raw.args);
  if (args) entry.args = args;
  const env = stringRecord(raw.env);
  if (env) entry.env = env;
  if (typeof raw.cwd === 'string' && raw.cwd.length > 0) entry.cwd = raw.cwd;
  if (typeof raw.url === 'string' && raw.url.length > 0) entry.url = raw.url;
  const headers = stringRecord(raw.headers);
  if (headers) entry.headers = headers;
  if (typeof raw.bearerToken === 'string' && raw.bearerToken.length > 0) {
    entry.bearerToken = raw.bearerToken;
  }
  const directTools = stringArray(raw.directTools);
  if (directTools) entry.directTools = directTools;
  return entry;
}

/**
 * Load `<agentDir>/mcp.json`. Accepts `{ servers: {...} }` and the
 * Cursor-style `{ mcpServers: {...} }` map (when both exist they are merged,
 * `servers` winning on name conflicts). Entries with `disabled: true` and
 * non-object entries are dropped. Missing file → `[]`; malformed JSON or a
 * non-object root rejects with a descriptive error.
 *
 * No AT Series dedup happens here — callers MUST classify the result with
 * `filterMcpServers` before connecting anything.
 */
export async function loadMcpConfig(agentDir: string): Promise<McpServerEntry[]> {
  const configPath = join(expandHome(agentDir, homedir()), MCP_CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`无法读取 MCP 配置 ${configPath}: ${errorMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`MCP 配置 ${configPath} 不是合法 JSON: ${errorMessage(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`MCP 配置 ${configPath} 根节点必须是对象`);
  }
  const maps: Record<string, unknown>[] = [];
  // Cursor-style map first so `servers` overrides it on name conflicts.
  if (isPlainObject(parsed.mcpServers)) maps.push(parsed.mcpServers);
  if (isPlainObject(parsed.servers)) maps.push(parsed.servers);
  const byName = new Map<string, McpServerEntry>();
  for (const map of maps) {
    for (const [name, raw] of Object.entries(map)) {
      const entry = normalizeEntry(name, raw);
      if (entry) byName.set(name, entry);
      else byName.delete(name); // `servers` may disable an `mcpServers` entry
    }
  }
  return [...byName.values()];
}

// ── connections ──────────────────────────────────────────────────────────

/** Tool metadata as reported by a connected server's `tools/list`. */
export interface ExternalMcpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A live connection to one third-party MCP server. */
export interface McpConnection {
  listTools(): Promise<ExternalMcpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Creates a connection for one kept server entry. The default implementation
 * uses `@modelcontextprotocol/sdk` (stdio / Streamable HTTP); tests inject a
 * fake so nothing is ever spawned.
 */
export type McpConnector = (entry: McpServerEntry) => Promise<McpConnection>;

/** Close connections a server has not been used for this long (5 min). */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

interface ManagedConnection {
  connection: McpConnection;
  tools?: ExternalMcpToolInfo[];
  timer?: ReturnType<typeof setTimeout>;
}

class ConnectionManager {
  private readonly active = new Map<string, Promise<ManagedConnection>>();

  constructor(
    private readonly connector: McpConnector,
    private readonly idleTimeoutMs: number
  ) {}

  isConnected(name: string): boolean {
    return this.active.has(name);
  }

  private async ensure(entry: McpServerEntry): Promise<ManagedConnection> {
    let pending = this.active.get(entry.name);
    if (!pending) {
      pending = this.connector(entry).then((connection) => ({ connection }));
      this.active.set(entry.name, pending);
      pending.catch(() => this.active.delete(entry.name));
    }
    const managed = await pending;
    this.touch(entry.name, managed);
    return managed;
  }

  async listTools(entry: McpServerEntry): Promise<ExternalMcpToolInfo[]> {
    const managed = await this.ensure(entry);
    if (!managed.tools) {
      managed.tools = await managed.connection.listTools();
    }
    this.touch(entry.name, managed);
    return managed.tools;
  }

  async callTool(
    entry: McpServerEntry,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const managed = await this.ensure(entry);
    const result = await managed.connection.callTool(name, args);
    this.touch(entry.name, managed);
    return result;
  }

  /** Reset the idle-disconnect timer (simple timeout map, docs/03 §8). */
  private touch(name: string, managed: ManagedConnection): void {
    if (managed.timer) clearTimeout(managed.timer);
    const timer = setTimeout(() => {
      void this.close(name);
    }, this.idleTimeoutMs);
    timer.unref?.();
    managed.timer = timer;
  }

  async close(name: string): Promise<void> {
    const pending = this.active.get(name);
    if (!pending) return;
    this.active.delete(name);
    try {
      const managed = await pending;
      if (managed.timer) clearTimeout(managed.timer);
      await managed.connection.close();
    } catch {
      // Already broken/closed; the map entry is gone either way.
    }
  }
}

// ── default connector (@modelcontextprotocol/sdk, dynamic import) ─────────

// Typed as plain `string` so tsc does not try to resolve the subpath exports
// (moduleResolution=node ignores exports maps); vitest/esbuild/node resolve
// them at runtime. Import failure degrades to a JSON error, never a crash.
const SDK_CLIENT_MODULE: string = '@modelcontextprotocol/sdk/client/index.js';
const SDK_STDIO_MODULE: string = '@modelcontextprotocol/sdk/client/stdio.js';
const SDK_HTTP_MODULE: string = '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface SdkClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

async function importSdkModule(specifier: string): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `@modelcontextprotocol/sdk 不可用（${errorMessage(err)}）；无法连接第三方 MCP 服务器。`
    );
  }
}

async function connectWithSdk(entry: McpServerEntry): Promise<McpConnection> {
  const clientModule = await importSdkModule(SDK_CLIENT_MODULE);
  const Client = clientModule.Client as new (
    info: { name: string; version: string }
  ) => SdkClientLike;

  let transport: unknown;
  if (entry.url) {
    const httpModule = await importSdkModule(SDK_HTTP_MODULE);
    const StreamableHTTPClientTransport = httpModule.StreamableHTTPClientTransport as new (
      url: URL,
      opts?: { requestInit?: { headers?: Record<string, string> } }
    ) => unknown;
    const headers: Record<string, string> = { ...(entry.headers ?? {}) };
    if (entry.bearerToken) headers.Authorization = `Bearer ${entry.bearerToken}`;
    transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined
    });
  } else if (entry.command) {
    const stdioModule = await importSdkModule(SDK_STDIO_MODULE);
    const StdioClientTransport = stdioModule.StdioClientTransport as new (params: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      stderr?: string;
    }) => unknown;
    const getDefaultEnvironment = stdioModule.getDefaultEnvironment as
      | (() => Record<string, string>)
      | undefined;
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      // Entry env extends (not replaces) the SDK's safe default environment.
      env: entry.env ? { ...(getDefaultEnvironment?.() ?? {}), ...entry.env } : undefined,
      cwd: entry.cwd,
      stderr: 'ignore'
    });
  } else {
    throw new Error(`服务器 "${entry.name}" 缺少 command（stdio）或 url（Streamable HTTP）配置。`);
  }

  const client = new Client({ name: 'at-ops-agent', version: '0.1.0' });
  await client.connect(transport);
  return {
    async listTools() {
      const result = await client.listTools();
      return (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }));
    },
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close()
  };
}

// ── proxy tools ──────────────────────────────────────────────────────────

/** Risk level of a proxy tool (same vocabulary as AgentToolDescriptor.risk). */
export type ProxyToolRisk = 'read' | 'write' | 'exec';

/**
 * Tool shape handed to the runtime (same contract as DiscoveryToolSpec:
 * `parameters` is a JSON Schema object, `execute` resolves to a JSON string
 * for the model and never rejects).
 */
export interface ProxyToolSource {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Declared risk for the policy gate: list/search are read-only;
   * `mcp_call_tool` defaults to write (the target tool's real risk is
   * unknown, so the host must NOT treat it as read).
   */
  risk: ProxyToolRisk;
  execute(args: Record<string, unknown>): Promise<string>;
}

export const EXTERNAL_MCP_PROXY_TOOL_NAMES = [
  'mcp_list_servers',
  'mcp_search_tools',
  'mcp_call_tool'
] as const;

/**
 * Risk of each proxy tool, for hosts that only know the tool name (the hub
 * catalog does not contain these tools, so a name-keyed map is the lookup
 * the policy gate needs — fail-closed alternatives would mark the read-only
 * search tools as exec).
 */
export const RISK_BY_PROXY_TOOL: Readonly<
  Record<(typeof EXTERNAL_MCP_PROXY_TOOL_NAMES)[number], ProxyToolRisk>
> = {
  mcp_list_servers: 'read',
  mcp_search_tools: 'read',
  mcp_call_tool: 'write'
};

/** Hard cap on a single `mcp_call_tool` result handed to the model (8 KB). */
export const MAX_TOOL_RESULT_BYTES = 8 * 1024;

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DESCRIPTION_PREVIEW_LIMIT = 160;

export interface CreateExternalMcpProxyToolsOptions {
  /** Directory holding `mcp.json` (`~/.at-series/agent` in production). */
  agentDir: string;
  /** Home dir used to expand a leading `~` in agentDir (tests). */
  home?: string;
  /** Connection factory injected by tests; defaults to the real SDK. */
  connectors?: McpConnector;
  /** Idle disconnect window; defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(n, 1), MAX_SEARCH_LIMIT);
}

/** Config summary safe to show the model: env/header values never leak. */
function describeEntry(entry: McpServerEntry): Record<string, unknown> {
  return {
    name: entry.name,
    transport: entry.url ? 'http' : entry.command ? 'stdio' : 'invalid',
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.args && entry.args.length > 0 ? { args: entry.args } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.env ? { envKeys: Object.keys(entry.env) } : {}),
    ...(entry.headers ? { headerKeys: Object.keys(entry.headers) } : {}),
    ...(entry.bearerToken ? { bearerToken: '<redacted>' } : {}),
    ...(entry.directTools ? { directTools: entry.directTools } : {})
  };
}

/** Serialize `{server, tool, result}` for the model, capped at 8 KB. */
function capCallResult(server: string, tool: string, raw: unknown): string {
  let full: string;
  try {
    full = JSON.stringify({ server, tool, result: raw === undefined ? null : raw });
  } catch {
    full = JSON.stringify({ server, tool, result: String(raw) });
  }
  if (Buffer.byteLength(full, 'utf8') <= MAX_TOOL_RESULT_BYTES) return full;

  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? 'null';
  } catch {
    serialized = String(raw);
  }
  const resultBytes = Buffer.byteLength(serialized, 'utf8');
  let previewLength = MAX_TOOL_RESULT_BYTES - 512;
  let out: string;
  do {
    out = JSON.stringify({
      server,
      tool,
      truncated: true,
      resultBytes,
      resultPreview: serialized.slice(0, previewLength)
    });
    previewLength = Math.floor(previewLength / 2);
  } while (Buffer.byteLength(out, 'utf8') > MAX_TOOL_RESULT_BYTES && previewLength > 0);
  return out;
}

/**
 * Build the three third-party MCP proxy tools. Always returns exactly three
 * tools — with zero configured servers (or a broken config / missing SDK)
 * they still exist and answer with a helpful JSON message instead of failing.
 *
 * Skipped entries (`shouldSkipAtSeriesMcpServer`) are never connected: the
 * embedded HubHost covers them and their business tools go through `ops_*`.
 */
export async function createExternalMcpProxyTools(
  options: CreateExternalMcpProxyToolsOptions
): Promise<ProxyToolSource[]> {
  const home = options.home ?? homedir();
  const agentDir = expandHome(options.agentDir, home);
  const configPath = join(agentDir, MCP_CONFIG_FILE_NAME);

  let configError: string | undefined;
  let entries: McpServerEntry[] = [];
  try {
    entries = await loadMcpConfig(agentDir);
  } catch (err) {
    configError = errorMessage(err);
  }

  // The single mandatory dedup gate: never spawn/connect the AT Series hub.
  const { keep, skipped } = filterMcpServers(entries);
  const keepByName = new Map(keep.map((entry) => [entry.name, entry]));
  const skippedNames = new Set(skipped.map((entry) => entry.name));

  const manager = new ConnectionManager(
    options.connectors ?? connectWithSdk,
    options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  );

  const noServersHint =
    `未配置第三方 MCP 服务器（${configPath}）。` +
    'AT 能力插件不在此配置——它们经由内嵌 AT Series Hub 的 ops_* 工具接入。';
  const knownServersText = (): string =>
    keep.length > 0 ? `已配置：${keep.map((e) => e.name).join(', ')}` : noServersHint;

  const configErrorPayload = (): Record<string, unknown> | undefined =>
    configError ? { error: 'CONFIG_INVALID', message: configError, configPath } : undefined;

  const listServers: ProxyToolSource = {
    name: 'mcp_list_servers',
    label: 'MCP：列出第三方服务器',
    description:
      '列出 mcp.json 里配置的第三方 MCP 服务器：keep 为可连接项，skipped 为与内嵌 AT Series hub 重复、' +
      '永不 spawn 的项。不触发任何连接。',
    risk: RISK_BY_PROXY_TOOL.mcp_list_servers,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const invalid = configErrorPayload();
      if (invalid) return JSON.stringify(invalid);
      const result: Record<string, unknown> = {
        configPath,
        keep: keep.map((entry) => ({
          ...describeEntry(entry),
          connected: manager.isConnected(entry.name)
        })),
        skipped: skipped.map((entry) => ({
          ...describeEntry(entry),
          reason: '与内嵌 AT Series hub 重复，绝不 spawn；其能力走 ops_* 工具。'
        }))
      };
      if (keep.length === 0 && skipped.length === 0) result.hint = noServersHint;
      return JSON.stringify(result);
    }
  };

  const searchTools: ProxyToolSource = {
    name: 'mcp_search_tools',
    label: 'MCP：搜索第三方工具',
    description:
      '按关键词搜索第三方 MCP 服务器的工具（匹配 name/description，不区分大小写）。' +
      '按需惰性连接目标服务器；连不上的服务器返回空结果并附 hint。可用 server 限定范围。',
    risk: RISK_BY_PROXY_TOOL.mcp_search_tools,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词；空串列出全部' },
        server: { type: 'string', description: '限定某个服务器名（mcp_list_servers 的 keep 项）' },
        limit: {
          type: 'number',
          description: `返回条数上限，默认 ${DEFAULT_SEARCH_LIMIT}，最大 ${MAX_SEARCH_LIMIT}`
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async (args) => {
      const invalid = configErrorPayload();
      if (invalid) return JSON.stringify(invalid);
      const query = String(args.query ?? '').trim().toLowerCase();
      const limit = clampLimit(args.limit);

      let targets: McpServerEntry[];
      if (typeof args.server === 'string' && args.server.length > 0) {
        if (skippedNames.has(args.server)) {
          return JSON.stringify({
            error: 'SERVER_SKIPPED',
            message: `"${args.server}" 与内嵌 AT Series hub 重复，不会连接；用 ops_search_tools 搜索 AT 能力。`
          });
        }
        const entry = keepByName.get(args.server);
        if (!entry) {
          return JSON.stringify({
            error: 'UNKNOWN_SERVER',
            message: `未知服务器 "${args.server}"。${knownServersText()}`
          });
        }
        targets = [entry];
      } else {
        targets = keep;
      }

      if (targets.length === 0) {
        return JSON.stringify({ total: 0, returned: 0, tools: [], hint: noServersHint });
      }

      const hits: Array<{ server: string; name: string; description: string }> = [];
      const notConnected: Array<{ server: string; error: string }> = [];
      for (const entry of targets) {
        try {
          const tools = await manager.listTools(entry);
          for (const tool of tools) {
            const description = tool.description ?? '';
            if (
              query === '' ||
              tool.name.toLowerCase().includes(query) ||
              description.toLowerCase().includes(query)
            ) {
              hits.push({
                server: entry.name,
                name: tool.name,
                description: description.slice(0, DESCRIPTION_PREVIEW_LIMIT)
              });
            }
          }
        } catch (err) {
          notConnected.push({ server: entry.name, error: errorMessage(err) });
        }
      }

      const returned = hits.slice(0, limit);
      const result: Record<string, unknown> = {
        total: hits.length,
        returned: returned.length,
        tools: returned
      };
      if (notConnected.length > 0) {
        result.notConnected = notConnected;
        result.hint =
          '部分服务器未能连接，其工具未参与本次搜索；检查 mcp.json 配置或稍后重试。';
      } else if (hits.length === 0) {
        result.hint = query
          ? `没有工具匹配 "${query}"；试试空 query 列出全部。`
          : '目标服务器没有上报任何工具。';
      }
      return JSON.stringify(result);
    }
  };

  const callTool: ProxyToolSource = {
    name: 'mcp_call_tool',
    label: 'MCP：调用第三方工具',
    description:
      '调用某个第三方 MCP 服务器上的工具（先用 mcp_search_tools 找到 server 与 name）。' +
      `结果最多返回 ${MAX_TOOL_RESULT_BYTES} 字节，超出会截断。` +
      '目标工具的真实风险未知：按 write 对待，可能触发会话审批。',
    risk: RISK_BY_PROXY_TOOL.mcp_call_tool,
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名（mcp_list_servers 的 keep 项）' },
        name: { type: 'string', description: '工具名' },
        arguments: { type: 'object', description: '工具参数对象，缺省为 {}' }
      },
      required: ['server', 'name'],
      additionalProperties: false
    },
    execute: async (args) => {
      const invalid = configErrorPayload();
      if (invalid) return JSON.stringify(invalid);
      const server = typeof args.server === 'string' ? args.server : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (!server || !name) {
        return JSON.stringify({
          error: 'INVALID_ARGS',
          message: `mcp_call_tool 需要 server 与 name。${knownServersText()}`
        });
      }
      if (skippedNames.has(server)) {
        return JSON.stringify({
          error: 'SERVER_SKIPPED',
          message: `"${server}" 与内嵌 AT Series hub 重复，不会连接；AT 工具请走 ops_* 发现与调用。`
        });
      }
      const entry = keepByName.get(server);
      if (!entry) {
        return JSON.stringify({
          error: 'UNKNOWN_SERVER',
          message: `未知服务器 "${server}"。${knownServersText()}`
        });
      }
      const toolArgs = isPlainObject(args.arguments) ? args.arguments : {};
      try {
        const raw = await manager.callTool(entry, name, toolArgs);
        return capCallResult(server, name, raw);
      } catch (err) {
        return JSON.stringify({
          error: 'CALL_FAILED',
          server,
          tool: name,
          message: errorMessage(err)
        });
      }
    }
  };

  return [listServers, searchTools, callTool];
}
