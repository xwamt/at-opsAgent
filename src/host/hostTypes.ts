/**
 * 窄 adapter 接口：host 只依赖这些形状（并行模块公开 API 的最小面），
 * 通过 src/host/modules.ts 动态装载；模块缺失时用 src/host/fallback/* 兜底。
 *
 * 形状对齐真源：
 * - hub-host      → src/hub-host/index.ts createAtSeriesHubHost(options): HubHost
 * - runtime       → src/runtime/index.ts createOpsRuntime(handlers, options)
 * - orchestrator  → src/orchestrator/index.ts createOrchestrator / loadPlaybooks
 * - mcp-client    → src/mcp-client/atSeriesDedup.ts shouldSkipAtSeriesMcpServer
 * - HubHost 契约  → src/protocol/hub-host.ts（共享 schema，已冻结）
 */
import type {
  AgentToolDescriptor,
  HubHost,
  ListProvidersResult,
  SelectToolsInput,
  SelectionController,
  SubagentCard,
  ToolInvocation,
  ToolInvocationResult
} from '../protocol';

// ── hub-host 模块 ────────────────────────────────────────────────────────

export interface CreateHubHostOptions {
  hostApp: string;
  home?: string;
  discovery?: { mode: 'auto' | 'always' | 'off'; threshold: number };
  [key: string]: unknown;
}

export interface HubHostModule {
  createAtSeriesHubHost(options: CreateHubHostOptions): HubHost | Promise<HubHost>;
}

// ── orchestrator 模块 ────────────────────────────────────────────────────

/** playbook.yaml 中 host 需要的最小面（真 Playbook 类型是其超集）。 */
export interface PlaybookMeta {
  id: string;
  title?: string;
  description?: string;
  stages?: Array<{ id: string; select?: SelectToolsInput }>;
}

export interface PlaybookRunLike {
  id: string;
  playbookId: string;
  stage: string;
}

export interface ApprovalBriefLike {
  briefId: string;
  runId: string;
  risk: 'write' | 'exec';
  commandSet?: unknown;
  commandSetSha256?: string;
  elements?: Record<string, string>;
}

export type OrchestratorEventLike =
  | { type: 'playbook/stage'; runId: string; playbookId: string; from?: string; stage: string }
  | { type: 'subagent/upsert'; runId: string; card: SubagentCard }
  | { type: 'approval/request'; runId: string; brief: ApprovalBriefLike }
  | { type: 'approval/resolved'; runId: string; briefId: string; decision: 'approved' | 'rejected' };

export interface OrchestratorLike {
  startPlaybook(playbookId: string, sessionId: string): PlaybookRunLike;
  desiredSelect?(runOrId: PlaybookRunLike | string): SelectToolsInput | undefined;
  applyApproval(input: {
    brief: { briefId: string; runId: string };
    decision: 'approved' | 'rejected';
  }): unknown;
  advanceTo?(runOrId: PlaybookRunLike | string, stage: string): PlaybookRunLike;
  abortSubagent?(taskId: string): void;
  dispose?(): void;
}

export interface CreateOrchestratorOptions {
  playbooks: PlaybookMeta[];
  maxParallel?: number;
  onEvent?: (event: OrchestratorEventLike) => void;
}

export interface OrchestratorModule {
  createOrchestrator(options: CreateOrchestratorOptions): OrchestratorLike;
  loadPlaybooks(rootDir: string): PlaybookMeta[];
}

// ── runtime 模块 ─────────────────────────────────────────────────────────

export type RuntimeEventLike =
  | { type: 'text_delta'; id: string; text: string }
  | { type: 'thinking_delta'; id: string; text: string }
  | { type: 'tool_start'; id: string; name: string; ok?: boolean; preview?: string; error?: string }
  | { type: 'tool_end'; id: string; name: string; ok?: boolean; preview?: string; error?: string }
  | { type: 'idle' };

export interface RuntimeHandlers {
  hub: {
    listAllTools(): readonly AgentToolDescriptor[];
    listExposedTools(): readonly AgentToolDescriptor[];
    getProviders(): ListProvidersResult;
    invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
    selection: SelectionController;
  };
  /** 权限闸（policy.evaluate 由 host 装配；block=true 则该次调用被拒）。 */
  beforeToolCall?: (ctx: {
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<{ block: boolean; reason?: string }>;
  onEvent?: (e: RuntimeEventLike) => void;
}

export interface RuntimeLike {
  prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void>;
  abort(): void;
  dispose(): void | Promise<void>;
  setSystemPrompt?(prompt: string): void;
}

export interface RuntimeCreateOptions {
  agentDir?: string;
  cwd?: string;
  model?: { provider?: string; id?: string };
}

export interface RuntimeModule {
  createOpsRuntime(
    handlers: RuntimeHandlers,
    options?: RuntimeCreateOptions
  ): RuntimeLike | Promise<RuntimeLike>;
  buildSystemPrompt?(opts?: { playbookLayer?: string }): string;
}

// ── mcp-client 去重 ──────────────────────────────────────────────────────

export interface McpServerEntryLike {
  name?: string;
  command?: string;
  args?: string[];
  url?: string;
  [key: string]: unknown;
}

export interface DedupModule {
  shouldSkipAtSeriesMcpServer(
    entry: McpServerEntryLike
  ): boolean | { skip: boolean; reason?: string };
}
