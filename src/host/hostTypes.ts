/**
 * host 侧的窄 adapter 类型：host 通过 src/core（OpsCore facade）静态装配
 * runtime / orchestrator / hub-host / mcp-client，但仍以这些「最小面」形状
 * 编程——runtime 的部分新能力（sessionFile 续接、usage/compaction/notice
 * 事件、execute 内挂起审批、per-provider key）由 D-runtime 并行落地，
 * host 全部按可选字段处理（`if (runtime.sessionFile)`），缺席时安全降级。
 *
 * 形状对齐真源：
 * - hub-host      → src/hub-host/index.ts createAtSeriesHubHost(options): HubHost
 * - runtime       → src/runtime/index.ts createOpsRuntime(handlers, options)
 * - orchestrator  → src/orchestrator/index.ts createOrchestrator / loadPlaybooks
 * - HubHost 契约  → src/protocol/hub-host.ts（共享 schema，已冻结）
 */
import type {
  AgentToolDescriptor,
  ListProvidersResult,
  NoticeAction,
  SelectToolsInput,
  SelectionController,
  SubagentCard,
  ToolInvocation,
  ToolInvocationResult,
  UsageView
} from '../protocol';

// ── orchestrator ─────────────────────────────────────────────────────────

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
   * run 缺席（普通问答审批）时 host 走本地简报，不经 orchestrator。
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
  /**
   * 推进一步：stage 给定等价 advanceTo；缺省取 legalNextStages[0]。
   * 非法迁移 throw（host 转成 ok=false + allowedNext，不让模型写 closed）。
   */
  advanceStage?(runOrId: PlaybookRunLike | string, stage?: string): PlaybookRunLike;
  /** 当前阶段在该 playbook 内合法的下一步（全局迁移表 ∩ yaml 声明）。 */
  legalNextStages?(runOrId: PlaybookRunLike | string): string[];
  /**
   * 沿迁移表 BFS 最短路推进到 closed，每步经 advanceTo 发阶段事件。
   * 已 closed 幂等；不可达时 throw。
   */
  closeRun?(runOrId: PlaybookRunLike | string): PlaybookRunLike;
  /** runtime 实际执行了一轮 select 后登记（policy 的 selectCountThisTask）。 */
  recordSelect?(runOrId: PlaybookRunLike | string): number;
  abortSubagent?(taskId: string): void;
  dispose?(): void;
}

// ── runtime ──────────────────────────────────────────────────────────────

/** 思考等级（与 host-protocol ModelSetReq.thinkingLevel 同一取值集合）。 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 工具调用来源（policy origin 接线：子代理角色/riskCeiling 进闸）。 */
export type RuntimeCallOrigin =
  | { kind: 'main' }
  | {
      kind: 'subagent';
      taskId: string;
      role: string;
      riskCeiling: string;
      /** Executor 的令牌引用 = 已批简报 briefId（哈希由 host 查回校验）。 */
      approvalToken?: string;
    };

export type RuntimeEventLike =
  | { type: 'text_delta'; id: string; text: string }
  | { type: 'thinking_delta'; id: string; text: string }
  | { type: 'tool_start'; id: string; name: string; ok?: boolean; preview?: string; error?: string }
  | { type: 'tool_end'; id: string; name: string; ok?: boolean; preview?: string; error?: string }
  /** 上下文/成本水位（D-runtime 落地后开始发送；host 前向兼容）。 */
  | ({ type: 'usage' } & UsageView)
  /** compaction 发生：summary 描述被摘要的内容。 */
  | { type: 'compaction'; summary: string }
  /** 结构化提示（未配置模型 / 初始化失败等），带可行动按钮。 */
  | { type: 'notice'; variant: 'error' | 'info' | 'success'; text: string; actions?: NoticeAction[] }
  | { type: 'idle' };

/** runtime 请求会话审批的输入（execute 内挂起，await host 决策）。 */
export interface RuntimeApprovalInput {
  toolName: string;
  args: Record<string, unknown>;
  risk?: 'read' | 'write' | 'exec';
  pluginId?: string;
  reason?: string;
  origin?: RuntimeCallOrigin;
}

export interface RuntimeHandlers {
  hub: {
    listAllTools(): readonly AgentToolDescriptor[];
    listExposedTools(): readonly AgentToolDescriptor[];
    getProviders(): ListProvidersResult;
    invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
    selection: SelectionController;
  };
  /**
   * 权限闸（policy.evaluate 由 host 装配；block=true 则该次调用被拒）。
   * needSessionApproval=true 时 runtime 在同一 execute 内 await
   * requestApproval（阻塞派发，P0-D），批准后继续同一调用。
   */
  beforeToolCall?: (ctx: {
    toolName: string;
    args: Record<string, unknown>;
    origin?: RuntimeCallOrigin;
  }) => Promise<{
    block: boolean;
    reason?: string;
    needSessionApproval?: boolean;
    risk?: 'write' | 'exec';
  }>;
  onEvent?: (e: RuntimeEventLike) => void;
  /** 子代理生命周期；runtime 可选发出，host 用来刷新 SubagentBoard。 */
  onSubagentEvent?: (e: {
    taskId: string;
    status: string;
    role?: string;
    summary?: string;
    error?: string;
    /** 派单目标（一句话）；host 用作卡片主标题（runtime 后续开始发送，缺席安全降级）。 */
    goal?: string;
    /** 子会话实际注入的业务工具名（同上，前向兼容）。 */
    visibleTools?: string[];
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
   * host 收到后**不立即** dispose：等会话 idle 再续接重建（P1-15），
   * 重建时带 resumeSessionFile 保上下文。
   */
  onCatalogNeedsRebuild?: () => void;
  /**
   * 会话审批（P0-D）：policy 判定 needSessionApproval 时由 runtime 在
   * tool execute 内 await 本回调；approved 继续同一调用，rejected 返回
   * 结构化拒绝。D-runtime 落地前 host 的 beforeToolCall 内部走同一实现。
   */
  requestApproval?: (input: RuntimeApprovalInput) => Promise<'approved' | 'rejected'>;
  /**
   * 运维链路（ops_list_playbooks / ops_start_playbook / ops_advance_stage /
   * ops_close_playbook）。缺席时 runtime 仍注册工具，执行结果告知模型
   * host 未接线。advance/close 为 D-runtime 增量工具，host 已就绪。
   */
  playbooks?: {
    list():
      | Array<{ id: string; title: string; description?: string; whenToUse?: string[] }>
      | Promise<Array<{ id: string; title: string; description?: string; whenToUse?: string[] }>>;
    start(
      playbookId: string
    ):
      | { ok: boolean; stage?: string; error?: string }
      | Promise<{ ok: boolean; stage?: string; error?: string }>;
    advance?(
      stage?: string
    ):
      | { ok: boolean; stage?: string; error?: string; allowedNext?: string[] }
      | Promise<{ ok: boolean; stage?: string; error?: string; allowedNext?: string[] }>;
    close?():
      | { ok: boolean; stage?: string; error?: string }
      | Promise<{ ok: boolean; stage?: string; error?: string }>;
  };
}

export interface RuntimeLike {
  prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void>;
  /**
   * 中止。mode 由 D-runtime 落地：cancel=软停（等当前工具结束）、
   * stop=立即 abort。旧 runtime 忽略参数按硬停处理；host 侧对 cancel
   * 另有兜底（tool_end 后再 abort）。
   */
  abort(mode?: 'cancel' | 'stop'): void;
  dispose(): void | Promise<void>;
  setSystemPrompt?(prompt: string): void;
  setThinkingLevel?(level: ThinkingLevel): void;
  /** 当前 pi 会话 JSONL 路径（D-runtime 落地后可用；续接重建的钥匙）。 */
  sessionFile?: string;
  /** 最小连通性探测（1-token / GET models）；缺席时 host 直接 HTTP 探测。 */
  probeModel?(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
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
  /**
   * 从 SecretStorage 解析 LLM key（按 provider 取；无参兼容旧签名）。
   * runtime 注入 pi，永不写入日志。
   */
  getApiKey?: (providerId?: string) => Promise<string | undefined>;
  /** 打包技能目录（extensionPath/skills）；runtime 资源加载（skills 渐进披露）。 */
  bundledSkillsDir?: string;
  /** 主会话思考等级：modelSelection.thinkingLevel → agentDir settings.json → 配置默认。 */
  thinkingLevel?: ThinkingLevel;
  /** 受限工作区 shell 开关（atOpsAgent.workspaceShell.enabled，默认关）。 */
  workspaceShellEnabled?: boolean;
  /**
   * 续接既有 pi 会话 JSONL（P0-C：换模型 / 新工具重建不失忆）。
   * D-runtime 落地前旧 runtime 忽略该字段（新开会话，行为不劣于现状）。
   */
  resumeSessionFile?: string;
  /**
   * per-role 模型映射（settings.json roleModels；C 提供 UI）。
   * runtime 派发子代理时按 role 选模型；缺省全部走当前模型。
   */
  roleModels?: Record<string, { provider: string; model: string }>;
}

// ── mcp-client ───────────────────────────────────────────────────────────

export interface McpServerEntryLike {
  name?: string;
  command?: string;
  args?: string[];
  url?: string;
  [key: string]: unknown;
}
