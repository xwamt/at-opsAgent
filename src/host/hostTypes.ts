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

/** 阶段级 guidedManual 指令（MCP 无写工具时引导用户走插件命令/面板）。 */
export interface GuidedManualMeta {
  command?: string;
  hint?: string;
}

/** playbook.yaml 阶段中 host 需要的最小面。 */
export interface PlaybookStageMeta {
  id: string;
  /** 阶段提示词文件（相对 playbook 目录，如 references/triage.md），L4 注入用。 */
  prompt?: string;
  select?: SelectToolsInput;
  /**
   * 升级扩面指令（yaml escalateSelect，mode 恒为 add）。
   * 不自动应用：由 playbook/escalate-select 请求（用户/模型驱动）触发。
   */
  escalateSelect?: SelectToolsInput;
  guidedManual?: GuidedManualMeta;
  /**
   * yaml parallelGroup：给主代理的候选建议，host 不再自动 spawn。
   * L4 注入会把这些条目写成「可选 ops_dispatch_subagent」。
   */
  parallelGroup?: Array<{ id: string; role: string; goal?: string; allowTools?: string[] }>;
}

/** playbook 触发器（真 PlaybookTrigger 的最小面；host 只消费 kind=nl 的 patterns）。 */
export interface PlaybookTriggerMeta {
  kind: string;
  patterns?: string[];
}

/** playbook.yaml 中 host 需要的最小面（真 Playbook 类型是其超集）。 */
export interface PlaybookMeta {
  id: string;
  title?: string;
  description?: string;
  triggers?: PlaybookTriggerMeta[];
  stages?: PlaybookStageMeta[];
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
  /**
   * 当前阶段 yaml 的 escalateSelect（mode=add 扩面）。host 绝不自动调用——
   * 只在收到 playbook/escalate-select 请求时应用到 hub.selection。
   */
  desiredEscalateSelect?(runOrId: PlaybookRunLike | string): SelectToolsInput | undefined;
  /**
   * 产出 9 要素审批简报并进入 awaitingApproval（同步 emit approval/request）。
   * 可选：fallback 编排缺席时 host 退回纯文本拒绝。
   */
  requestApproval?(
    runOrId: PlaybookRunLike | string,
    input: { risk: 'write' | 'exec'; commandSet: unknown; elements?: Record<string, string> }
  ): ApprovalBriefLike;
  applyApproval(input: {
    brief: { briefId: string; runId: string };
    decision: 'approved' | 'rejected';
  }): unknown;
  getRun?(id: string): PlaybookRunLike | undefined;
  advanceTo?(runOrId: PlaybookRunLike | string, stage: string): PlaybookRunLike;
  /** runtime 实际执行了一轮 select 后登记（policy 的 selectCountThisTask）。 */
  recordSelect?(runOrId: PlaybookRunLike | string): number;
  /** 当前阶段 parallelGroup → TaskSpec[]。host 不再自动调用；仅主代理 ops_dispatch_subagent 或测试使用。 */
  spawnSubagentSpecs?(runOrId: PlaybookRunLike | string): unknown[];
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

/** 思考等级（与 host-protocol ModelSetReq.thinkingLevel 同一取值集合）。 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  /** 子代理生命周期；runtime 可选发出，host 用来刷新 SubagentBoard。 */
  onSubagentEvent?: (e: {
    taskId: string;
    status: string;
    role?: string;
    summary?: string;
    error?: string;
    /** evidence-note@1 解析成功时附上（runtime 侧后续开始发送，host 前向兼容）。 */
    evidenceNote?: {
      taskId: string;
      confidence: 'confirmed' | 'hypothesis' | 'pending';
      summary: string;
      refs?: Array<{ kind: string; preview: string; artifactUri?: string }>;
    };
  }) => void;
  /**
   * 工具目录需要整体重建时回调（pi 会话无法追加新 ToolDefinition）。
   * host 收到后 disposeRuntime，下一次 prompt 以最新目录重建工具面。
   */
  onCatalogNeedsRebuild?: () => void;
  /**
   * 运维链路（ops_list_playbooks / ops_start_playbook）。
   * 缺席时 runtime 仍注册工具，执行结果告知模型 host 未接线。
   */
  playbooks?: {
    list():
      | Array<{ id: string; title: string; description?: string; whenToUse?: string[] }>
      | Promise<Array<{ id: string; title: string; description?: string; whenToUse?: string[] }>>;
    start(
      playbookId: string
    ): { ok: boolean; stage?: string; error?: string } | Promise<{ ok: boolean; stage?: string; error?: string }>;
  };
}

export interface RuntimeLike {
  prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void>;
  abort(): void;
  dispose(): void | Promise<void>;
  setSystemPrompt?(prompt: string): void;
  /** 派发一个子代理任务（TaskSpec）；并行 runtime 工作落地前可能缺席。 */
  dispatchSubagent?(spec: unknown): Promise<{ taskId: string; status: string }>;
  /** 中止单个子代理，不牵连主会话。 */
  abortSubagent?(taskId: string): void;
  /**
   * OAuth 登录（Models 面板 OAuth 页驱动）：由 pi ModelRuntime.login 完成，
   * 凭证写 ~/.at-series/agent/auth.json（0600），不进 models.json、不写日志。
   */
  loginOAuth?(providerId: string): Promise<void>;
}

export interface RuntimeCreateOptions {
  agentDir?: string;
  cwd?: string;
  model?: { provider?: string; id?: string };
  /** 从 SecretStorage 解析 LLM key；runtime 注入 pi，永不写入日志。 */
  getApiKey?: () => Promise<string | undefined>;
  /** 打包技能目录（extensionPath/skills）；runtime 资源加载（skills 渐进披露）。 */
  bundledSkillsDir?: string;
  /** 主会话思考等级：modelSelection.thinkingLevel → agentDir settings.json → 配置默认。 */
  thinkingLevel?: ThinkingLevel;
  /** 受限工作区 shell 开关（atOpsAgent.workspaceShell.enabled，默认关）。 */
  workspaceShellEnabled?: boolean;
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
