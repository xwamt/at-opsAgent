/**
 * Agent runtime 对外契约类型。实现散落在 tool-gate / fallback /
 * session-events / session-factory；本文件只放类型，避免实现模块循环 import。
 *
 * 约束：禁止 import vscode。
 */
import type { EvidenceNote, TaskSpec } from '../orchestrator';
import type {
  AgentToolDescriptor,
  Event,
  ListProvidersResult,
  NoticeAction,
  SelectionController,
  ToolInvocation,
  ToolInvocationResult,
  UsageView
} from '../protocol';
import type { PlaybookToolHost } from './playbook-tools';
import type { SubagentDispatchInput, SubagentRunStatus } from './subagents';

/**
 * 工具调用的发起方身份（P0-D：policy 需要 role/riskCeiling 才能执行角色规则）。
 * 主会话恒为 { kind: 'main' }；子代理会话由 runSubagentSession 按 TaskSpec 注入。
 */
export type ToolCallOrigin =
  | { kind: 'main' }
  | {
      kind: 'subagent';
      taskId: string;
      role: string;
      riskCeiling: string;
      /**
       * Executor 的令牌引用 = TaskSpec.approvalToken.briefId（已批 9 要素
       * 简报 id）。commandSetSha256 由 host 按 briefId 查回并校验——模型/
       * 子代理绝不自行计算哈希。
       */
      approvalToken?: string;
    };

/**
 * beforeToolCall 的裁决。needSessionApproval=true 时 runtime 在该工具的
 * execute 内 await handlers.requestApproval —— 批准则继续同一调用，拒绝
 * 则把结构化拒绝 JSON 作为工具结果返回（绝不抛错让模型重试）。
 */
export type BeforeToolCallVerdict = {
  block: boolean;
  reason?: string;
  /** true = 需要会话内审批（write/exec 双闸的第①道），runtime 挂起等待。 */
  needSessionApproval?: boolean;
  /** 审批风险级别（host 生成 9 要素简报用）；缺省按 write 处理。 */
  risk?: 'write' | 'exec';
};

export type OpsRuntimeHandlers = {
  hub: {
    listAllTools(): readonly AgentToolDescriptor[];
    listExposedTools(): readonly AgentToolDescriptor[];
    getProviders(): ListProvidersResult;
    invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
    selection: SelectionController;
    /** 工具目录变化（插件桥接上线/下线）。HubHost 的 Event<ToolChangeEvent> 可直接赋值。 */
    onDidChangeTools?: Event<unknown>;
  };
  /**
   * 权限闸（policy）。block=true 时该次工具调用被拒绝，reason 回给模型；
   * needSessionApproval=true 时 runtime 调用 requestApproval 在 execute 内挂起。
   * ctx.origin 标识调用方（主会话 / 子代理），host 应透传给 evaluatePolicy。
   */
  beforeToolCall?: (ctx: {
    toolName: string;
    args: Record<string, unknown>;
    origin?: ToolCallOrigin;
  }) => Promise<BeforeToolCallVerdict>;
  /**
   * 会话内审批（P0-D）：needSessionApproval 时 runtime 在工具 execute 内
   * await 本回调。host 弹 ApprovalBar / 9 要素简报，用户批准返回 'approved'
   * （runtime 继续同一调用），拒绝返回 'rejected'（runtime 回结构化拒绝结果）。
   * 缺席时 runtime 直接返回「需要审批但 host 未接线」的结构化拒绝。
   */
  requestApproval?: (input: {
    toolName: string;
    args: Record<string, unknown>;
    risk: 'write' | 'exec';
    reason?: string;
    origin?: ToolCallOrigin;
  }) => Promise<'approved' | 'rejected'>;
  onEvent?: (e: OpsRuntimeEvent) => void;
  /** 子代理生命周期（可选；host 后续接 SubagentBoard 时消费）。 */
  onSubagentEvent?: (e: OpsSubagentEvent) => void;
  /**
   * 工具目录出现「原始注册集之外的新业务工具」时回调。pi 的 AgentSession
   * 只在 createAgentSession 期注册 customTools，之后没有公开 API 追加/替换
   * ToolDefinition（见 createPiRuntime 内注释）——host 收到该回调后应重建
   * runtime（配合 resumeSessionFile 续接同一 JSONL，不丢上下文）。
   *
   * P1-15：会话运行中（isStreaming）不会立刻回调——runtime 把重建请求排队，
   * 等本轮 agent_end（idle）后才调用，避免装插件把进行中的上下文打断。
   * 下线/重新上线的已注册工具无需重建：setActiveToolsByName 即时同步。
   */
  onCatalogNeedsRebuild?: () => void;
  /**
   * 运维链路目录（ops_list_playbooks / ops_start_playbook /
   * ops_advance_stage / ops_close_playbook）。
   * 缺席时工具仍注册，执行结果告知模型 host 未接线。
   */
  playbooks?: PlaybookToolHost;
  /**
   * 当前 playbook yaml `defaults.payloadCaps`（如 lokiLimit）。
   * host 从当前 run 写入（getter 亦可）；缺席则 executeBusinessTool 不注入。
   * dispatch schema **不**暴露 payloadCaps。
   */
  payloadCaps?: Record<string, unknown>;
  /**
   * 长期记忆目录（ops_recall 用 node:fs 读）。缺席则 runtime 回落到
   * ~/.at-series/agent/memory。
   */
  memoryDir?: () => string;
  /**
   * 可选：host 代读记忆。缺席时 runtime 对 memoryDir() 做子串检索。
   */
  recallMemory?: (query: string) => Promise<string>;
};

export type OpsSubagentEvent = {
  taskId: string;
  status: SubagentRunStatus;
  role?: string;
  /** 派单目标（TaskSpec.goal；host 侧子代理卡主标题）。派发起即携带，全生命周期不丢。 */
  goal?: string;
  /**
   * 实际注入子会话的业务工具名（filterToolsForSubagent 过滤结果，
   * 即 allowTools ∩ hub 暴露集 / riskCeiling）。派发起即携带；后续
   * 状态/摘要事件同样带上，host 合并时不得丢弃。
   */
  visibleTools?: string[];
  /** 终态摘要（≤800 token 近似截断；原始大输出不进事件）。 */
  summary?: string;
  error?: string;
  /** output.contract=evidence-note@1 且解析成功时的结构化便签（host 侧证据板消费）。 */
  evidenceNote?: EvidenceNote;
};

export type OpsRuntimeEvent =
  | { type: 'text_delta'; id: string; text: string }
  | { type: 'thinking_delta'; id: string; text: string }
  | {
      type: 'tool_start' | 'tool_end';
      id: string;
      name: string;
      ok?: boolean;
      preview?: string;
      error?: string;
    }
  | ({ type: 'usage' } & UsageView)
  | { type: 'compaction'; summary: string }
  | {
      type: 'notice';
      variant: 'error' | 'info' | 'success';
      text: string;
      actions?: NoticeAction[];
    }
  | { type: 'idle' };

/**
 * OpsRuntime.dispatchSubagent（host API）的即时返回。
 * 注意：模型侧的 ops_dispatch_subagent 工具是阻塞式的（P1-6），
 * 工具结果 = 终态摘要 JSON，不再经 prompt 回灌主会话。
 */
export type DispatchSubagentResult = {
  taskId: string;
  status: string;
  /** 拒绝/不可用时的中文说明（不抛错）。 */
  notice?: string;
};

/** pi 思考等级（与 pi-agent-core 的 ThinkingLevel 字面量一致，避免类型再导出依赖）。 */
export type OpsThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpsRuntime {
  prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void>;
  /**
   * 中止会话。mode='stop'（缺省）= 立即 abort 主会话并级联全部子代理；
   * mode='cancel' = 软停：等当前 in-flight 工具调用结束后再 abort（保留在途证据）。
   */
  abort(mode?: 'cancel' | 'stop'): void;
  dispose(): Promise<void>;
  setSystemPrompt(prompt: string): void;
  /** 调整思考等级（会话支持 setThinkingLevel 时生效；Fallback 为安全 no-op）。 */
  setThinkingLevel(level: OpsThinkingLevel): void;
  /** 派发子代理（TaskSpec 子集或 orchestrator 的完整 TaskSpec）。立即返回。 */
  dispatchSubagent(spec: SubagentDispatchInput | TaskSpec): Promise<DispatchSubagentResult>;
  /** 中止单个子代理（AbortSignal 级联到其 LLM 子会话与 in-flight invoke）。 */
  abortSubagent(taskId: string): void;
  /**
   * 当前主会话 JSONL 路径（P0-C：会话单真源）。host 重建 runtime 时把它
   * 作为 CreateOpsRuntimeOptions.resumeSessionFile 传回来即可续接同一会话。
   * in-memory 会话 / Fallback 为 undefined。
   */
  sessionFile?: string;
  /** 连通性探测（models/test）：1 次极小补全，返回延迟或人话错误。 */
  probeModel?(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

export interface CreateOpsRuntimeOptions {
  /** 默认 ~/.at-series/agent（auth.json / models.json / models-store.json 都落在这里）。 */
  agentDir?: string;
  cwd?: string;
  model?: { provider?: string; id?: string };
  /**
   * 从 host 的 SecretStorage 按 provider 读 LLM API key（providerId 缺省时
   * 返回全局/默认 key，兼容旧的无参实现）。返回非空串时经
   * ModelRuntime.setRuntimeApiKey 注入 pi 凭证层，覆盖 models.json 里的
   * "${secret:…}" 占位符（否则占位符会被当成真实 bearer token 发出去）。
   * 只对「首选 provider」与「实际选中模型的 provider」注入——绝不按
   * 注册表第一个 provider 启发式注入。key 只在内存中传递，绝不写日志、
   * 绝不落盘。
   */
  getApiKey?: (providerId?: string) => Promise<string | undefined>;
  /**
   * P0-C 会话续接：host 重建 runtime（换模型 / 新插件工具上线）时传入上一个
   * runtime 的 sessionFile，pi 经 SessionManager.open 续接同一 JSONL——
   * LLM 上下文不丢。缺省 / 打开失败时新建会话（agentDir/sessions 下新 JSONL）。
   */
  resumeSessionFile?: string;
  /** 思考等级；透传 createAgentSession({ thinkingLevel })，pi 按模型能力收敛。 */
  thinkingLevel?: OpsThinkingLevel;
  /**
   * 打包 skills 根目录（host 后续传 extensionPath/skills）。
   * 默认 join(cwd ?? process.cwd(), 'skills')。与 agentDir/skills 一起构成
   * ops_read_skill 的路径白名单与 OpsResourceLoader 的 skills 发现根。
   */
  bundledSkillsDir?: string;
  /**
   * 允许工作区文件访问（默认 false=关）。开启后也只注册只读的
   * ops_read_workspace_file（限 cwd、64KB、禁 ..），绝不注入不受限 bash。
   */
  workspaceShellEnabled?: boolean;
  /**
   * prompt 期 429/5xx 退避毫秒。仅测试注入；生产默认
   * {@link TRANSIENT_PROMPT_RETRY_MS}（500）。0 = 不睡立刻重试一次。
   */
  retryDelayMs?: number;
  /**
   * per-role 子会话模型（settings.json roleModels）。
   * 字段名 `model` 即 resolveModel 的 id（与设置页 `{ provider, model }` 对齐）；
   * 也接受 `{ provider, id }`。解析失败时 log 并回落主会话模型，不抛错。
   */
  roleModels?: Partial<
    Record<
      'investigator' | 'executor' | 'writer' | 'verifier',
      { provider: string; model?: string; id?: string }
    >
  >;
}
