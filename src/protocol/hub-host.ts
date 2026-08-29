import type { Event, Disposable } from './host-protocol';

export type ToolRisk = 'read' | 'write' | 'exec';

export interface AgentToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly risk: ToolRisk;
  readonly pluginId: string;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: true;
  };
}

export interface ToolInvocation {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly abort?: AbortSignal;
}

export interface ToolInvocationResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string; details?: unknown };
  readonly attemptCount: number;
  readonly durationMs: number;
}

export interface SelectionState {
  readonly mode: 'auto' | 'always' | 'off';
  readonly threshold: number;
  readonly selected: readonly string[];
  readonly exposedBusinessToolCount: number;
  readonly idleMs: number;
  readonly maxCalls: number;
}

export interface SelectToolsInput {
  pluginIds?: string[];
  names?: string[];
  mode?: 'replace' | 'add';
}

export interface SelectionController {
  state(): SelectionState;
  select(input: SelectToolsInput): Promise<{ selected: string[]; exposed: string[] }>;
  clear(): Promise<void>;
  readonly onDidChange: Event<SelectionState>;
}

export interface ToolChangeEvent {
  readonly exposed: readonly AgentToolDescriptor[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface ListProvidersResult {
  readonly hostApp: string;
  readonly providers: ReadonlyArray<{
    pluginId: string;
    displayName: string;
    healthy: boolean;
    bridgeCount: number;
    connectedTargets?: number;
    toolNames: string[];
    pluginVersion?: string;
    /** 该插件声明的 toolNames 中已进入 live catalog 的数量（发现层包装时填充）。 */
    liveToolCount?: number;
    /** settings Capabilities：每条声明工具的 risk / 是否 live（缺席时旧 UI 仍渲染）。 */
    tools?: ReadonlyArray<{ name: string; risk: ToolRisk; live?: boolean }>;
  }>;
  /** hub.listAllTools() 当前条数（发现层包装时填充）。 */
  readonly catalogLiveToolCount?: number;
  /** live catalog 为空但插件已声明工具时的行动指引（发现层包装时填充）。 */
  readonly hint?: string;
}

export interface HubHost extends Disposable {
  readonly hostApp: string;
  start(): Promise<void>;
  listExposedTools(): readonly AgentToolDescriptor[];
  listAllTools(): readonly AgentToolDescriptor[];
  getProviders(): ListProvidersResult;
  invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
  refresh(): Promise<void>;
  readonly selection: SelectionController;
  readonly onDidChangeTools: Event<ToolChangeEvent>;
}

export interface ToolProvider extends Disposable {
  readonly id: string;
  readonly displayName: string;
  listTools(): readonly AgentToolDescriptor[];
  invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
  readonly onDidChangeTools: Event<void>;
}
