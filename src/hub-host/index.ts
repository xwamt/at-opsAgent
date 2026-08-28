/**
 * AT Series HubHost adapter — embeds the Hub engine in-process (ADR-001).
 *
 * Boundaries (docs/02-capability-hub.md §3.1):
 * - never `syncHubBundle` / `ensureAtSeriesMcpConfig`, never writes the
 *   registry, never speaks Bridge HTTP itself — `createHubRuntime` owns
 *   routing, failover, and the business-call audit trail.
 * - zero `vscode` imports: this module runs in plain Node (tests included).
 */
import {
  createHubRuntime,
  normalizeToolRisk,
  HUB_BUILTIN_TOOL_NAMES,
  DEFAULT_TOOL_DISCOVERY_THRESHOLD,
  DEFAULT_TOOL_SELECTION_IDLE_MS,
  type AggregatedCatalog,
  type HubRuntime,
  type ListProvidersResult as HubListProvidersResult,
  type ToolCatalogEntry,
  type ToolDiscoveryMode
} from '@at-series/mcp-hub';
import {
  Emitter,
  OPS_ERROR,
  type AgentToolDescriptor,
  type HubHost,
  type ListProvidersResult,
  type SelectionController,
  type SelectionState,
  type SelectToolsInput,
  type ToolChangeEvent,
  type ToolInvocation,
  type ToolInvocationResult
} from '../protocol';

/** Telemetry stamp only — the embedded host never writes hub.js (ADR-001). */
const AGENT_HUB_VERSION = '0.1.0-ops-agent';

const META_TOOL_NAMES: ReadonlySet<string> = new Set(HUB_BUILTIN_TOOL_NAMES);

export interface AtSeriesHubHostOptions {
  hostApp: string;
  /** Override `os.homedir()` — tests point this at a temp directory. */
  home?: string;
  discoveryMode?: ToolDiscoveryMode;
  discoveryThreshold?: number;
  selectionIdleMs?: number;
  /** Nested form used by the host module loader (src/host/hostTypes.ts). */
  discovery?: { mode: ToolDiscoveryMode; threshold: number };
}

/**
 * Local copy of the Hub's risk → MCP annotations mapping — the package does
 * not export its `annotations` module. Uses `normalizeToolRisk`, so a missing
 * or invalid risk fails closed to `exec` (destructive).
 */
export function toolAnnotationsForRisk(risk: unknown): AgentToolDescriptor['annotations'] {
  const normalized = normalizeToolRisk(risk);
  return {
    readOnlyHint: normalized === 'read',
    destructiveHint: normalized === 'exec',
    openWorldHint: true
  };
}

/** Map the Hub's `ListProvidersResult` onto the Agent's simplified shape. */
export function mapHubProviders(hubResult: HubListProvidersResult): ListProvidersResult {
  return {
    hostApp: hubResult.hostApp,
    providers: hubResult.providers.map((provider) => {
      const healthyBridges = provider.bridges.filter((bridge) => bridge.status === 'healthy');
      const targetCounts = healthyBridges
        .map((bridge) => bridge.connectedTargets)
        .filter((value): value is number => typeof value === 'number');
      return {
        pluginId: provider.pluginId,
        displayName: provider.pluginDisplayName,
        healthy: healthyBridges.length > 0,
        bridgeCount: provider.bridges.length,
        ...(targetCounts.length > 0
          ? { connectedTargets: targetCounts.reduce((sum, value) => sum + value, 0) }
          : {}),
        toolNames: [...provider.tools],
        ...(provider.pluginVersion !== undefined ? { pluginVersion: provider.pluginVersion } : {})
      };
    })
  };
}

function tryParseJson(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractErrorBody(value: unknown): { code: string; message: string; details?: unknown } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const err = value.error;
  if (isRecord(err) && typeof err.code === 'string' && typeof err.message === 'string') {
    return { code: err.code, message: err.message, details: err.details };
  }
  return undefined;
}

/**
 * At-Database compat (docs/02 §2): the plugin reports app-level failures as a
 * 2xx body carrying `ok:false` instead of a Bridge error. Anything that made
 * it through as a "success" but says `ok !== true` must not be surfaced to
 * the model as a good result.
 */
function isOkFalseResult(value: unknown): boolean {
  return isRecord(value) && 'ok' in value && value.ok !== true;
}

type CallOutcome =
  | { kind: 'settled'; value: Awaited<ReturnType<HubRuntime['callTool']>> }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'aborted' }
  | { kind: 'timeout' };

function raceCall(
  call: ReturnType<HubRuntime['callTool']>,
  inv: ToolInvocation
): Promise<CallOutcome> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const onAbort = () => settle({ kind: 'aborted' });
    function settle(outcome: CallOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      inv.abort?.removeEventListener('abort', onAbort);
      resolve(outcome);
    }
    if (inv.timeoutMs !== undefined && inv.timeoutMs > 0) {
      timer = setTimeout(() => settle({ kind: 'timeout' }), inv.timeoutMs);
      timer.unref?.();
    }
    inv.abort?.addEventListener('abort', onAbort, { once: true });
    call.then(
      (value) => settle({ kind: 'settled', value }),
      (error: unknown) => settle({ kind: 'rejected', error })
    );
  });
}

class AtSeriesHubHost implements HubHost {
  readonly hostApp: string;

  private readonly options: AtSeriesHubHostOptions;
  private runtime: HubRuntime | undefined;
  private starting: Promise<void> | undefined;
  private disposed = false;

  private catalog: (AggregatedCatalog & { providers: HubListProvidersResult }) | undefined;
  private exposedTools: readonly AgentToolDescriptor[] = [];
  private selectedNames: readonly string[] = [];

  private syncChain: Promise<void> = Promise.resolve();
  private syncQueued = false;

  private readonly toolsEmitter = new Emitter<ToolChangeEvent>();
  private readonly selectionEmitter = new Emitter<SelectionState>();

  readonly onDidChangeTools = this.toolsEmitter.event;

  readonly selection: SelectionController = {
    state: () => this.selectionState(),
    select: (input) => this.selectTools(input),
    clear: () => this.clearSelection(),
    onDidChange: this.selectionEmitter.event
  };

  constructor(options: AtSeriesHubHostOptions) {
    this.options = options;
    this.hostApp = options.hostApp;
  }

  /**
   * Non-blocking start (docs/02 §3.1): the runtime resolves immediately and
   * probes bridges in the background; the catalog fills in via sync passes
   * and `onDidChangeTools`.
   */
  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('AtSeriesHubHost already disposed');
    }
    if (!this.starting) {
      this.starting = (async () => {
        this.runtime = await createHubRuntime({
          hostApp: this.options.hostApp,
          hubVersion: AGENT_HUB_VERSION,
          home: this.options.home,
          discoveryMode: this.options.discoveryMode,
          discoveryThreshold: this.options.discoveryThreshold,
          selectionIdleMs: this.options.selectionIdleMs ?? DEFAULT_TOOL_SELECTION_IDLE_MS,
          selectionMaxCalls: 0,
          onToolsListChanged: () => {
            void this.scheduleSync();
          }
        });
        // Prime the catalog without holding up the caller.
        void this.scheduleSync();
      })();
    }
    return this.starting;
  }

  listExposedTools(): readonly AgentToolDescriptor[] {
    return this.exposedTools;
  }

  listAllTools(): readonly AgentToolDescriptor[] {
    if (!this.catalog) {
      return [];
    }
    const winners = this.catalog.winners;
    return this.catalog.tools.map((entry) =>
      this.toDescriptor(entry, winners.get(entry.name)?.pluginId ?? 'unknown')
    );
  }

  getProviders(): ListProvidersResult {
    if (!this.catalog) {
      return { hostApp: this.hostApp, providers: [] };
    }
    return mapHubProviders(this.catalog.providers);
  }

  async invoke(inv: ToolInvocation): Promise<ToolInvocationResult> {
    const started = Date.now();
    const runtime = this.runtime;
    if (!runtime) {
      return {
        ok: false,
        error: { code: 'UNAVAILABLE', message: 'AT Series HubHost is not started' },
        attemptCount: 0,
        durationMs: 0
      };
    }
    if (inv.abort?.aborted) {
      return {
        ok: false,
        error: { code: 'USER_CANCELLED', message: `Tool call cancelled: ${inv.name}` },
        attemptCount: 0,
        durationMs: Date.now() - started
      };
    }
    // Meta (`at_*`) and business tools both go through `runtime.callTool` —
    // the Hub already does routing, failover, and auditing.
    const outcome = await raceCall(runtime.callTool(inv.name, inv.arguments), inv);
    const durationMs = Date.now() - started;
    switch (outcome.kind) {
      case 'aborted':
        return {
          ok: false,
          error: { code: 'USER_CANCELLED', message: `Tool call cancelled: ${inv.name}` },
          attemptCount: 1,
          durationMs
        };
      case 'timeout':
        return {
          ok: false,
          error: {
            code: 'UNAVAILABLE',
            message: `Tool call timed out after ${inv.timeoutMs}ms: ${inv.name}`
          },
          attemptCount: 1,
          durationMs
        };
      case 'rejected': {
        const message =
          outcome.error instanceof Error ? outcome.error.message : 'Tool call failed';
        return {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message },
          attemptCount: 1,
          durationMs
        };
      }
      case 'settled':
        return this.normalizeCallResult(inv.name, outcome.value, durationMs);
    }
  }

  async refresh(): Promise<void> {
    await this.scheduleSync();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) {
      void runtime.close().catch(() => {
        // Best-effort shutdown; the process is going away anyway.
      });
    }
    this.toolsEmitter.dispose();
    this.selectionEmitter.dispose();
  }

  private toDescriptor(entry: ToolCatalogEntry, pluginId: string): AgentToolDescriptor {
    const risk = normalizeToolRisk(entry.risk);
    return {
      name: entry.name,
      title: entry.title,
      description: entry.description,
      inputSchema: entry.inputSchema,
      risk,
      pluginId,
      annotations: toolAnnotationsForRisk(risk)
    };
  }

  /**
   * `callTool` speaks MCP content: `{ content: [{ type:'text', text }] }`,
   * where `text` is the JSON result on success, or `{ error:{code,message} }`
   * with `isError` on failure. Normalize both onto ToolInvocationResult.
   */
  private normalizeCallResult(
    name: string,
    raw: Awaited<ReturnType<HubRuntime['callTool']>>,
    durationMs: number
  ): ToolInvocationResult {
    const text = raw.content[0]?.text ?? '';
    const payload = tryParseJson(text);
    if (raw.isError === true) {
      const err = extractErrorBody(payload);
      return {
        ok: false,
        error: err ?? { code: 'INTERNAL_ERROR', message: text || 'Tool call failed' },
        attemptCount: 1,
        durationMs
      };
    }
    const result = payload !== undefined ? payload : text === '' ? undefined : text;
    if (!META_TOOL_NAMES.has(name) && isOkFalseResult(result)) {
      const nested = extractErrorBody(result);
      const fallbackMessage =
        isRecord(result) && typeof result.message === 'string'
          ? result.message
          : `Bridge returned ok:false for tool: ${name}`;
      return {
        ok: false,
        error: {
          code: OPS_ERROR.DATABASE_OK_FALSE,
          message: nested?.message ?? fallbackMessage,
          details: result
        },
        attemptCount: 1,
        durationMs
      };
    }
    return { ok: true, result, attemptCount: 1, durationMs };
  }

  private selectionState(): SelectionState {
    return {
      mode: this.options.discoveryMode ?? 'auto',
      threshold: this.options.discoveryThreshold ?? DEFAULT_TOOL_DISCOVERY_THRESHOLD,
      selected: [...this.selectedNames],
      exposedBusinessToolCount: this.exposedTools.length,
      idleMs: this.options.selectionIdleMs ?? DEFAULT_TOOL_SELECTION_IDLE_MS,
      maxCalls: 0
    };
  }

  private async selectTools(
    input: SelectToolsInput
  ): Promise<{ selected: string[]; exposed: string[] }> {
    const res = await this.invoke({
      name: 'at_select_tools',
      arguments: {
        ...(input.pluginIds !== undefined ? { pluginIds: input.pluginIds } : {}),
        ...(input.names !== undefined ? { names: input.names } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {})
      }
    });
    if (!res.ok) {
      throw new Error(`at_select_tools failed: ${res.error?.code ?? 'UNKNOWN'} ${res.error?.message ?? ''}`);
    }
    const selected =
      isRecord(res.result) && Array.isArray(res.result.selected)
        ? res.result.selected.filter((value): value is string => typeof value === 'string')
        : [];
    this.selectedNames = selected;
    await this.scheduleSync();
    this.selectionEmitter.fire(this.selectionState());
    return { selected: [...selected], exposed: this.exposedTools.map((tool) => tool.name) };
  }

  private async clearSelection(): Promise<void> {
    const res = await this.invoke({ name: 'at_clear_tool_selection', arguments: {} });
    if (!res.ok) {
      throw new Error(
        `at_clear_tool_selection failed: ${res.error?.code ?? 'UNKNOWN'} ${res.error?.message ?? ''}`
      );
    }
    this.selectedNames = [];
    await this.scheduleSync();
    this.selectionEmitter.fire(this.selectionState());
  }

  /** Coalesced catalog/exposure sync; never rejects. */
  private scheduleSync(): Promise<void> {
    if (this.syncQueued) {
      return this.syncChain;
    }
    this.syncQueued = true;
    this.syncChain = this.syncChain.then(async () => {
      this.syncQueued = false;
      try {
        await this.syncOnce();
      } catch {
        // Keep the previous catalog on a failed pass — same policy as the Hub.
      }
    });
    return this.syncChain;
  }

  private async syncOnce(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || this.disposed) {
      return;
    }
    const catalog = await runtime.refreshCatalog({ reason: 'demand' });
    // Fresh refresh above → this reuses it (2s TTL), no extra bridge probes.
    const mcpTools = await runtime.listToolsForMcp();
    if (this.disposed) {
      return;
    }
    this.catalog = catalog;
    const exposed = mcpTools
      // Hub meta `at_*` tools are not business tools for the LLM: discovery
      // is re-exposed by the runtime as `ops_*` tools (docs/02 §3.2).
      .filter((entry) => !META_TOOL_NAMES.has(entry.name))
      .map((entry) => this.toDescriptor(entry, catalog.winners.get(entry.name)?.pluginId ?? 'unknown'));
    const previousNames = new Set(this.exposedTools.map((tool) => tool.name));
    const nextNames = new Set(exposed.map((tool) => tool.name));
    const added = [...nextNames].filter((name) => !previousNames.has(name));
    const removed = [...previousNames].filter((name) => !nextNames.has(name));
    this.exposedTools = exposed;
    if (added.length > 0 || removed.length > 0) {
      this.toolsEmitter.fire({ exposed, added, removed });
    }
  }
}

export function createAtSeriesHubHost(options: AtSeriesHubHostOptions): HubHost {
  return new AtSeriesHubHost({
    ...options,
    discoveryMode: options.discoveryMode ?? options.discovery?.mode,
    discoveryThreshold: options.discoveryThreshold ?? options.discovery?.threshold
  });
}
