/**
 * host 内置最小 HubHost 兜底（阶段 0 验收底线）。
 *
 * 仅当 src/hub-host（并行模块）缺失时启用：
 * - 只读扫描 ~/.at-series/bridges/<hostApp>/ + watch（150ms debounce）
 * - Capabilities / diagnose 数据源：listAllTools / getProviders
 * - invoke 走 bridgeInvoke（120s、单次 failover），够 runtime 调通
 * - 渐进发现：threshold 内全暴露，否则只暴露已 select 的集合
 *
 * 不做：健康探测缓存、审计日志、Database 深度兼容 —— 那些属于真 hub-host。
 */
import {
  bridgeInvoke,
  listBridgeRecords,
  normalizeToolRisk,
  watchBridgeRegistry,
  type BridgeRegistryRecord,
  type WatchBridgeRegistryHandle
} from '@at-series/mcp-hub';
import {
  Emitter,
  type AgentToolDescriptor,
  type Event,
  type HubHost,
  type ListProvidersResult,
  type SelectToolsInput,
  type SelectionController,
  type SelectionState,
  type ToolChangeEvent,
  type ToolInvocation,
  type ToolInvocationResult
} from '../../protocol';

const STALE_MS = 90_000;
const INVOKE_TIMEOUT_MS = 120_000;

export interface FallbackHubOptions {
  hostApp: string;
  home?: string;
  discovery: { mode: 'auto' | 'always' | 'off'; threshold: number };
  log: (message: string) => void;
}

function isStale(record: BridgeRegistryRecord, now = Date.now()): boolean {
  return now - record.updatedAt > STALE_MS;
}

function toDescriptor(
  record: BridgeRegistryRecord,
  tool: BridgeRegistryRecord['tools'][number]
): AgentToolDescriptor {
  const risk = normalizeToolRisk(tool.risk);
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    risk,
    pluginId: record.pluginId,
    annotations: {
      readOnlyHint: risk === 'read',
      destructiveHint: risk !== 'read',
      openWorldHint: true
    }
  };
}

class LocalSelection implements SelectionController {
  private readonly emitter = new Emitter<SelectionState>();
  readonly onDidChange: Event<SelectionState> = this.emitter.event;
  private selected: string[] = [];

  constructor(private readonly hub: FallbackHubHost) {}

  state(): SelectionState {
    return {
      mode: this.hub.discovery.mode,
      threshold: this.hub.discovery.threshold,
      selected: [...this.selected],
      exposedBusinessToolCount: this.hub.listExposedTools().length,
      idleMs: 0,
      maxCalls: 0
    };
  }

  async select(input: SelectToolsInput): Promise<{ selected: string[]; exposed: string[] }> {
    const all = this.hub.listAllTools();
    const wanted = new Set<string>(input.mode === 'add' ? this.selected : []);
    for (const name of input.names ?? []) {
      if (all.some((t) => t.name === name)) wanted.add(name);
    }
    for (const pluginId of input.pluginIds ?? []) {
      for (const tool of all) {
        if (tool.pluginId === pluginId) wanted.add(tool.name);
      }
    }
    this.selected = [...wanted];
    this.hub.notifyExposureChanged();
    this.emitter.fire(this.state());
    return {
      selected: [...this.selected],
      exposed: this.hub.listExposedTools().map((t) => t.name)
    };
  }

  async clear(): Promise<void> {
    this.selected = [];
    this.hub.notifyExposureChanged();
    this.emitter.fire(this.state());
  }

  selectedNames(): readonly string[] {
    return this.selected;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export class FallbackHubHost implements HubHost {
  readonly hostApp: string;
  readonly discovery: { mode: 'auto' | 'always' | 'off'; threshold: number };

  private readonly home: string | undefined;
  private readonly log: (message: string) => void;
  private records: BridgeRegistryRecord[] = [];
  private watchHandle: WatchBridgeRegistryHandle | undefined;
  private started = false;
  private disposed = false;

  private readonly toolsEmitter = new Emitter<ToolChangeEvent>();
  readonly onDidChangeTools: Event<ToolChangeEvent> = this.toolsEmitter.event;

  private readonly localSelection = new LocalSelection(this);
  readonly selection: SelectionController = this.localSelection;

  constructor(options: FallbackHubOptions) {
    this.hostApp = options.hostApp;
    this.home = options.home;
    this.discovery = options.discovery;
    this.log = options.log;
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    await this.refresh();
    this.watchHandle = watchBridgeRegistry({
      hostApp: this.hostApp,
      home: this.home,
      onChange: () => {
        void this.refresh().catch((err) =>
          this.log(`[fallback-hub] refresh 失败: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    });
    this.log(
      `[fallback-hub] started hostApp=${this.hostApp} watch=${this.watchHandle.mode} bridges=${this.records.length}`
    );
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const before = new Set(this.listExposedTools().map((t) => t.name));
    this.records = await listBridgeRecords({ hostApp: this.hostApp, home: this.home });
    this.fireDiff(before);
  }

  listAllTools(): readonly AgentToolDescriptor[] {
    // 同名工具可能来自同 plugin 的多条 Bridge：取 updatedAt 最新的一条。
    const byName = new Map<string, { record: BridgeRegistryRecord; descriptor: AgentToolDescriptor }>();
    for (const record of this.records) {
      for (const tool of record.tools) {
        const existing = byName.get(tool.name);
        if (!existing || record.updatedAt > existing.record.updatedAt) {
          byName.set(tool.name, { record, descriptor: toDescriptor(record, tool) });
        }
      }
    }
    return [...byName.values()].map((v) => v.descriptor);
  }

  listExposedTools(): readonly AgentToolDescriptor[] {
    const all = this.listAllTools();
    if (this.discovery.mode === 'off') return all;
    const selected = new Set(this.localSelection.selectedNames());
    if (selected.size > 0) return all.filter((t) => selected.has(t.name));
    if (this.discovery.mode === 'auto' && all.length <= this.discovery.threshold) return all;
    return [];
  }

  getProviders(): ListProvidersResult {
    const now = Date.now();
    const byPlugin = new Map<string, BridgeRegistryRecord[]>();
    for (const record of this.records) {
      const list = byPlugin.get(record.pluginId) ?? [];
      list.push(record);
      byPlugin.set(record.pluginId, list);
    }
    return {
      hostApp: this.hostApp,
      providers: [...byPlugin.entries()].map(([pluginId, records]) => {
        const fresh = records.filter((r) => !isStale(r, now));
        const newest = [...records].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const toolNames = [...new Set(records.flatMap((r) => r.tools.map((t) => t.name)))];
        const connectedTargets = records.reduce(
          (sum, r) => sum + (r.capabilities?.connectedTargets ?? 0),
          0
        );
        return {
          pluginId,
          displayName: newest.pluginDisplayName || pluginId,
          healthy: fresh.length > 0,
          bridgeCount: records.length,
          connectedTargets: connectedTargets > 0 ? connectedTargets : undefined,
          toolNames,
          pluginVersion: newest.pluginVersion
        };
      })
    };
  }

  async invoke(inv: ToolInvocation): Promise<ToolInvocationResult> {
    const startedAt = Date.now();
    const now = Date.now();
    const candidates = this.records
      .filter((r) => !isStale(r, now) && r.tools.some((t) => t.name === inv.name))
      .sort(
        (a, b) =>
          (b.capabilities?.connectedTargets ?? 0) - (a.capabilities?.connectedTargets ?? 0) ||
          b.updatedAt - a.updatedAt
      );
    if (candidates.length === 0) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `没有健康的 Bridge 提供工具 ${inv.name}` },
        attemptCount: 0,
        durationMs: Date.now() - startedAt
      };
    }
    // 传输失败 failover 一次；工具级错误（有结构化 body）不换桥。
    const attempts = candidates.slice(0, 2);
    let attemptCount = 0;
    let lastTransportError: unknown;
    for (const record of attempts) {
      if (inv.abort?.aborted) break;
      attemptCount += 1;
      try {
        const response = await this.invokeWithAbort(record, inv);
        if (response === 'aborted') {
          return {
            ok: false,
            error: { code: 'USER_CANCELLED', message: '调用已被用户取消' },
            attemptCount,
            durationMs: Date.now() - startedAt
          };
        }
        if (
          typeof response === 'object' &&
          response !== null &&
          'ok' in response &&
          (response as { ok: unknown }).ok === true
        ) {
          return {
            ok: true,
            result: (response as { result?: unknown }).result,
            attemptCount,
            durationMs: Date.now() - startedAt
          };
        }
        const errorBody = (response as { error?: { code?: string; message?: string; details?: unknown } })
          .error;
        return {
          ok: false,
          // 2xx 但 ok!==true 且无 error 体（at.database 已知缺口）→ 规范化 INTERNAL_ERROR
          error: {
            code: errorBody?.code ?? 'INTERNAL_ERROR',
            message: errorBody?.message ?? 'Bridge 返回了非规范响应（ok!==true 且无 error 体）',
            details: errorBody?.details
          },
          attemptCount,
          durationMs: Date.now() - startedAt
        };
      } catch (err) {
        lastTransportError = err;
      }
    }
    return {
      ok: false,
      error: {
        code: 'UNAVAILABLE',
        message: `Bridge 传输失败: ${
          lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError)
        }`
      },
      attemptCount,
      durationMs: Date.now() - startedAt
    };
  }

  notifyExposureChanged(): void {
    this.toolsEmitter.fire({
      exposed: this.listExposedTools(),
      added: [],
      removed: []
    });
  }

  dispose(): void {
    this.disposed = true;
    this.watchHandle?.close();
    this.watchHandle = undefined;
    this.toolsEmitter.dispose();
    this.localSelection.dispose();
  }

  private fireDiff(before: Set<string>): void {
    const exposed = this.listExposedTools();
    const after = new Set(exposed.map((t) => t.name));
    const added = [...after].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    this.toolsEmitter.fire({ exposed, added, removed });
  }

  private async invokeWithAbort(
    record: BridgeRegistryRecord,
    inv: ToolInvocation
  ): Promise<unknown | 'aborted'> {
    const invokePromise = bridgeInvoke(
      { port: record.port, token: record.token, endpoints: record.endpoints },
      { name: inv.name, arguments: inv.arguments },
      { timeoutMs: inv.timeoutMs ?? INVOKE_TIMEOUT_MS }
    );
    if (!inv.abort) return invokePromise;
    // bridgeInvoke 不接收 AbortSignal：race 到取消即返回，底层请求由超时收尾。
    return await Promise.race([
      invokePromise,
      new Promise<'aborted'>((resolve) => {
        const onAbort = () => resolve('aborted');
        if (inv.abort!.aborted) onAbort();
        else inv.abort!.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  }
}
