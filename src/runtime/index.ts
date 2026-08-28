/**
 * Agent runtime：封装 @earendil-works/pi-coding-agent（0.84.3 精确锁定）。
 *
 * 约束（见 AGENTS.md / docs/03）：
 * - 禁止 import vscode。
 * - 默认不启用 pi 内置 coding 四件套（read/bash/edit/write）——运维动作走 AT 插件。
 * - pi 是 ESM-only 包，esbuild 会把扩展打成 CJS，因此这里只用
 *   `import type`（编译期擦除）+ 运行时动态 `import()`。
 * - 无 API key / 模型不可用时不得抛出导致扩展无法激活：createOpsRuntime
 *   捕获一切创建期错误并返回 FallbackRuntime。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ModelRuntime,
  SessionManager,
  ToolDefinition
} from '@earendil-works/pi-coding-agent';

import type { EvidenceNote, TaskSpec } from '../orchestrator';
import type {
  AgentToolDescriptor,
  Event,
  ListProvidersResult,
  SelectionController,
  ToolInvocation,
  ToolInvocationResult
} from '../protocol';
import { composeSystemPrompt } from '../prompts/layers';
import { composeSubagentPrompt } from '../prompts/roles';
import { recoverFromPromptError } from './compaction';
import {
  discoveryToolSpecs,
  executeDiscoveryTool,
  isBusinessToolName,
  listBusinessToolDescriptors,
  type DiscoveryHub
} from './discovery-tools';
import {
  createOpsResourceLoader,
  createReadSkillTool,
  defaultBundledSkillsDir,
  skillRootsFor,
  type OpsCustomToolSpec
} from './resource-loader';
import { createWorkspaceReadTool } from './workspace-read';
import {
  buildTaskSpec,
  createSubagentManager,
  dispatchToolSpec,
  filterToolsForSubagent,
  normalizeDispatchInput,
  type SubagentDispatchInput,
  type SubagentManager,
  type SubagentRunOutcome,
  type SubagentRunStatus,
  type SubagentStatusEvent
} from './subagents';

export {
  discoveryToolNames,
  discoveryToolSpecs,
  executeDiscoveryTool,
  isBusinessToolName,
  listBusinessToolDescriptors,
  searchTools,
  getTool,
  listProviders,
  selectTools,
  clearToolSelection,
  DESCRIPTION_PREVIEW_LIMIT,
  type DiscoveryHub,
  type DiscoveryToolSpec,
  type SearchToolsArgs,
  type SearchToolsResult
} from './discovery-tools';

export {
  buildTaskSpec,
  createSubagentManager,
  dispatchToolSpec,
  filterToolsForSubagent,
  normalizeDispatchInput,
  parseContractJson,
  parseEvidenceNote,
  truncateSummary,
  DEFAULT_SUBAGENT_BUDGET,
  DISPATCH_TOOL_NAME,
  ROLE_PARALLEL_LIMITS,
  SUBAGENT_SUMMARY_CHAR_LIMIT,
  type BuildTaskSpecOutcome,
  type ContractJson,
  type SubagentDispatchInput,
  type SubagentManager,
  type SubagentRunner,
  type SubagentRunOutcome,
  type SubagentRunStatus,
  type SubagentStatusEvent
} from './subagents';

export {
  createOpsResourceLoader,
  createReadSkillTool,
  defaultBundledSkillsDir,
  readSkillFile,
  resolveUnderRoot,
  skillRootsFor,
  READ_SKILL_TOOL_NAME,
  SKILL_FILE_CHAR_LIMIT,
  type CreateOpsResourceLoaderOptions,
  type OpsCustomToolSpec,
  type ReadSkillResult
} from './resource-loader';

export {
  isPromptTooLongError,
  recoverFromPromptError,
  COMPACTION_NEW_SESSION_MESSAGE,
  type CompactableSessionLike
} from './compaction';

export {
  createWorkspaceReadTool,
  readWorkspaceFile,
  READ_WORKSPACE_FILE_TOOL_NAME,
  WORKSPACE_FILE_CHAR_LIMIT,
  type ReadWorkspaceFileResult
} from './workspace-read';

// ── 对外契约 ─────────────────────────────────────────────────────────────

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
  /** 权限闸（policy）。返回 block=true 时该次工具调用被拒绝，reason 回给模型。 */
  beforeToolCall?: (ctx: {
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<{ block: boolean; reason?: string }>;
  onEvent?: (e: OpsRuntimeEvent) => void;
  /** 子代理生命周期（可选；host 后续接 SubagentBoard 时消费）。 */
  onSubagentEvent?: (e: OpsSubagentEvent) => void;
  /**
   * 工具目录出现「原始注册集之外的新业务工具」时回调。pi 的 AgentSession
   * 只在 createAgentSession 期注册 customTools，之后没有公开 API 追加/替换
   * ToolDefinition（见 createPiRuntime 内注释）——host 收到该回调后应
   * disposeRuntime 并重建，让新工具进模型工具面。下线/重新上线的已注册
   * 工具无需重建：setActiveToolsByName 即时同步。
   */
  onCatalogNeedsRebuild?: () => void;
};

export type OpsSubagentEvent = {
  taskId: string;
  status: SubagentRunStatus;
  role?: string;
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
  | { type: 'idle' };

/** dispatchSubagent 的即时返回：结果本体经事件异步回传。 */
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
  /** 中止主会话，并级联中止所有在跑子代理。 */
  abort(): void;
  dispose(): Promise<void>;
  setSystemPrompt(prompt: string): void;
  /** 调整思考等级（会话支持 setThinkingLevel 时生效；Fallback 为安全 no-op）。 */
  setThinkingLevel(level: OpsThinkingLevel): void;
  /** 派发子代理（TaskSpec 子集或 orchestrator 的完整 TaskSpec）。立即返回。 */
  dispatchSubagent(spec: SubagentDispatchInput | TaskSpec): Promise<DispatchSubagentResult>;
  /** 中止单个子代理（AbortSignal 级联到其 LLM 子会话与 in-flight invoke）。 */
  abortSubagent(taskId: string): void;
}

export interface CreateOpsRuntimeOptions {
  /** 默认 ~/.at-series/agent（auth.json / models.json / models-store.json 都落在这里）。 */
  agentDir?: string;
  cwd?: string;
  model?: { provider?: string; id?: string };
  /**
   * 从 host 的 SecretStorage 读 LLM API key。返回非空串时经
   * ModelRuntime.setRuntimeApiKey 注入 pi 凭证层，覆盖 models.json 里的
   * "${secret:…}" 占位符（否则占位符会被当成真实 bearer token 发出去）。
   * key 只在内存中传递，绝不写日志、绝不落盘。
   */
  getApiKey?: () => Promise<string | undefined>;
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
}

/** 组装主代理系统提示词：L0+L1+L2+L3（+可选 L4 playbook 注入层）。 */
export function buildSystemPrompt(opts: { playbookLayer?: string } = {}): string {
  return composeSystemPrompt(opts);
}

// ── 常量与小工具 ─────────────────────────────────────────────────────────

/** tool_end 事件 preview 截断上限（4KB）。完整 result JSON 仍然给模型。 */
export const TOOL_END_PREVIEW_LIMIT = 4096;

export function truncatePreview(text: string, limit = TOOL_END_PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function defaultAgentDir(): string {
  return join(homedir(), '.at-series', 'agent');
}

/** 从 pi 的 AgentToolResult（或任意 result）提取文本用于 UI 预览。 */
function extractResultText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (c): c is { type: 'text'; text: string } =>
            !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' &&
            typeof (c as { text?: unknown }).text === 'string'
        )
        .map((c) => c.text);
      if (texts.length > 0) return texts.join('\n');
    }
  }
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result);
  }
}

async function applyToolGate(
  handlers: OpsRuntimeHandlers,
  toolName: string,
  args: Record<string, unknown>
): Promise<void> {
  if (!handlers.beforeToolCall) return;
  const verdict = await handlers.beforeToolCall({ toolName, args });
  if (verdict.block) {
    throw new Error(verdict.reason ?? `工具 ${toolName} 被策略闸门拒绝`);
  }
}

// ── 业务工具结果：截断与落盘 ─────────────────────────────────────────────

/** 回给模型的业务工具结果上限（8KB 字符）。完整 JSON 落盘 tool-results/。 */
export const MODEL_RESULT_CHAR_LIMIT = 8192;

/** 超限业务工具结果的完整 JSON 落盘目录（agentDir 下）。 */
export const TOOL_RESULTS_DIRNAME = 'tool-results';

const TRUNCATED_SUFFIX = '…[truncated]';

export interface TruncateForModelContext {
  pluginId?: string;
  name?: string;
  /** 完整 JSON 落盘路径（写盘成功时在提示里告知模型）。 */
  savedPath?: string;
}

/**
 * 把回给模型的文本截断到 limit（含中文截断提示在内的总长 ≤ limit）。
 * 未超限时原样返回。
 */
export function truncateForModel(
  text: string,
  context: TruncateForModelContext = {},
  limit = MODEL_RESULT_CHAR_LIMIT
): string {
  if (text.length <= limit) return text;
  const source = `${context.pluginId ?? '未知插件'}/${context.name ?? '未知工具'}`;
  const notice =
    `【截断提示】工具 ${source} 的完整输出共 ${text.length} 字符，超过 ${limit} 字符上限，以下内容已被截断` +
    (context.savedPath !== undefined ? `；完整 JSON 已写入 ${context.savedPath}` : '') +
    '。\n';
  const room = Math.max(limit - notice.length - TRUNCATED_SUFFIX.length, 0);
  return `${notice}${text.slice(0, room)}${TRUNCATED_SUFFIX}`;
}

/** invoke 结果是否为用户取消（USER_CANCELLED）；此时必须走 isError 路径。 */
export function isCancelledInvocation(result: ToolInvocationResult): boolean {
  return !result.ok && result.error?.code === 'USER_CANCELLED';
}

/** 完整结果 JSON 落盘（mkdir recursive）；写失败不影响工具调用，返回 undefined。 */
async function persistFullToolResult(
  agentDir: string,
  id: string,
  json: string
): Promise<string | undefined> {
  try {
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_');
    const dir = join(agentDir, TOOL_RESULTS_DIRNAME);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${safeId.length > 0 ? safeId : randomUUID()}.json`);
    await writeFile(file, json, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * 业务工具统一执行路径（主会话与子会话共用）：
 * - 策略闸门 → hub.invoke；
 * - USER_CANCELLED 抛错（pi 记为 isError，UI 不会呈现“成功”）；
 * - 结果超过 8KB 时截断回给模型（带中文提示），完整 JSON 落盘
 *   agentDir/tool-results/<toolCallId>.json（写盘失败不影响调用）。
 */
export async function executeBusinessTool(
  handlers: OpsRuntimeHandlers,
  descriptor: AgentToolDescriptor,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  agentDir: string,
  toolCallId?: string
): Promise<string> {
  await applyToolGate(handlers, descriptor.name, args);
  const result = await handlers.hub.invoke({
    name: descriptor.name,
    arguments: args,
    abort: signal
  });
  if (isCancelledInvocation(result)) {
    throw new Error(result.error?.message ?? `工具 ${descriptor.name} 调用已被用户取消`);
  }
  const full = JSON.stringify(result);
  if (full.length <= MODEL_RESULT_CHAR_LIMIT) return full;
  const savedPath = await persistFullToolResult(agentDir, toolCallId ?? randomUUID(), full);
  return truncateForModel(full, {
    pluginId: descriptor.pluginId,
    name: descriptor.name,
    ...(savedPath !== undefined ? { savedPath } : {})
  });
}

// ── FallbackRuntime ──────────────────────────────────────────────────────

export const FALLBACK_NOTICE =
  '未配置模型，请在设置中写入 API key；仍可通过能力插件树查看已注册 AT 工具。';

/**
 * 模型运行时创建失败（缺 API key、模型不存在、pi 加载失败等）时的兜底实现。
 * prompt 时用中文说明现状并回到 idle，绝不抛错，保证扩展可激活。
 */
export function createFallbackRuntime(handlers: OpsRuntimeHandlers, reason?: string): OpsRuntime {
  let seq = 0;
  const message = reason ? `${FALLBACK_NOTICE}\n（原因：${reason}）` : FALLBACK_NOTICE;
  return {
    async prompt(): Promise<void> {
      seq += 1;
      handlers.onEvent?.({ type: 'text_delta', id: `fallback-${seq}`, text: message });
      handlers.onEvent?.({ type: 'idle' });
    },
    abort(): void {
      // 无进行中的模型调用，无事可做。
    },
    async dispose(): Promise<void> {
      // 无资源可释放。
    },
    setSystemPrompt(): void {
      // 无会话，忽略；等模型配置好后重建 runtime 时再生效。
    },
    setThinkingLevel(): void {
      // 无会话，忽略；host 重建 runtime 时经 options.thinkingLevel 生效。
    },
    async dispatchSubagent(): Promise<DispatchSubagentResult> {
      // no-op：模型不可用时不派发，也不抛错。
      return { taskId: '', status: 'unavailable', notice: `无法派发子代理：${message}` };
    },
    abortSubagent(): void {
      // 无子代理在跑，无事可做。
    }
  };
}

// ── pi 支撑的运行时 ──────────────────────────────────────────────────────

type PiModule = typeof import('@earendil-works/pi-coding-agent');

/** 我们实际构造的工具形状；通过 pi.defineTool 收窄成 ToolDefinition。 */
interface OpsToolSource {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    toolCallId?: string
  ): Promise<string>;
}

function toPiTool(pi: PiModule, source: OpsToolSource): ToolDefinition {
  const definition = {
    name: source.name,
    label: source.label,
    description: source.description,
    parameters: source.parameters,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const args =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const text = await source.execute(args, signal, toolCallId);
      return { content: [{ type: 'text' as const, text }], details: {} };
    }
  };
  // parameters 是普通 JSON Schema（pi-ai 的 validateToolArguments 兼容非 typebox schema），
  // 这里统一经 defineTool 收窄成 ToolDefinition。
  return pi.defineTool(definition as never) as unknown as ToolDefinition;
}

function buildDiscoveryTools(pi: PiModule, handlers: OpsRuntimeHandlers): ToolDefinition[] {
  const hub: DiscoveryHub = handlers.hub;
  return discoveryToolSpecs.map((spec) =>
    toPiTool(pi, {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (args) => {
        await applyToolGate(handlers, spec.name, args);
        return executeDiscoveryTool(hub, spec.name, args);
      }
    })
  );
}

function buildBusinessTools(
  pi: PiModule,
  handlers: OpsRuntimeHandlers,
  agentDir: string
): ToolDefinition[] {
  // 注册全量业务工具（listAllTools 过滤 at_/ops_ 前缀），但只把当前暴露集设为
  // active——这样 ops_select_tools 之后 setActiveToolsByName 才能即时生效。
  // selection ≠ 授权：真正的权限控制在 beforeToolCall / hub.invoke。
  const descriptors = listBusinessToolDescriptors(handlers.hub.listAllTools());
  return descriptors.map((descriptor) =>
    toPiTool(pi, {
      name: descriptor.name,
      label: descriptor.title,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
      execute: (args, signal, toolCallId) =>
        executeBusinessTool(handlers, descriptor, args, signal, agentDir, toolCallId)
    })
  );
}

function exposedBusinessToolNames(handlers: OpsRuntimeHandlers): string[] {
  return listBusinessToolDescriptors(handlers.hub.listExposedTools()).map((t) => t.name);
}

function activeToolNames(
  handlers: OpsRuntimeHandlers,
  extraToolNames: readonly string[] = []
): string[] {
  // ops_dispatch_subagent 仅主会话常驻；子会话（runSubagentSession）不注册。
  // extraToolNames：ops_read_skill / ops_read_workspace_file / 外部 MCP 代理
  // 等常驻工具，不受 hub 暴露集 selection 影响。
  return [
    ...discoveryToolSpecs.map((s) => s.name),
    dispatchToolSpec.name,
    ...extraToolNames,
    ...exposedBusinessToolNames(handlers)
  ];
}

/**
 * 热目录判定：hub 目录里出现了「原始注册集之外的新业务工具名」时返回 true。
 * 此时 runtime 会触发 handlers.onCatalogNeedsRebuild（pi 无法事后追加
 * customTools，只有 host 重建 runtime 才能把新工具送进模型工具面）。
 */
export function catalogGainedNewBusinessTool(
  registeredNames: ReadonlySet<string>,
  allTools: readonly AgentToolDescriptor[]
): boolean {
  return listBusinessToolDescriptors(allTools).some((t) => !registeredNames.has(t.name));
}

function subscribeSessionEvents(
  session: AgentSession,
  handlers: OpsRuntimeHandlers
): () => void {
  let messageCounter = 0;
  let currentMessageId = 'msg-0';
  const emit = (e: OpsRuntimeEvent): void => handlers.onEvent?.(e);

  return session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_start': {
        const role = (event.message as { role?: string }).role;
        if (role === 'assistant') {
          messageCounter += 1;
          currentMessageId = `msg-${messageCounter}`;
        }
        break;
      }
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') {
          emit({ type: 'text_delta', id: currentMessageId, text: e.delta });
        } else if (e.type === 'thinking_delta') {
          emit({ type: 'thinking_delta', id: currentMessageId, text: e.delta });
        }
        break;
      }
      case 'tool_execution_start':
        emit({ type: 'tool_start', id: event.toolCallId, name: event.toolName });
        break;
      case 'tool_execution_end': {
        const preview = truncatePreview(extractResultText(event.result));
        emit({
          type: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          preview: event.isError ? undefined : preview,
          error: event.isError ? preview : undefined
        });
        break;
      }
      case 'agent_end':
        emit({ type: 'idle' });
        break;
      default:
        break;
    }
  });
}

interface PiModelRuntimeLike {
  getModel(providerId: string, modelId: string): unknown;
  getAvailable(providerId?: string): Promise<readonly unknown[]>;
}

async function resolveModel(
  modelRuntime: PiModelRuntimeLike,
  pref: CreateOpsRuntimeOptions['model']
): Promise<unknown> {
  if (pref?.provider && pref.id) {
    const model = modelRuntime.getModel(pref.provider, pref.id);
    if (!model) {
      throw new Error(`未找到模型 ${pref.provider}/${pref.id}（检查 models.json 与 provider 配置）`);
    }
    return model;
  }
  const available = pref?.provider
    ? await modelRuntime.getAvailable(pref.provider)
    : await modelRuntime.getAvailable();
  if (available.length === 0) {
    throw new Error('没有任何配置了有效凭证的模型（缺少 API key）');
  }
  if (pref?.id) {
    const match = available.find((m) => (m as { id?: string }).id === pref.id);
    if (match) return match;
  }
  return available[0];
}

// ── 子代理子会话 ─────────────────────────────────────────────────────────

interface SubagentSessionEnv {
  pi: PiModule;
  handlers: OpsRuntimeHandlers;
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: CreateAgentSessionOptions['model'];
}

/**
 * 在同进程内另起一个 in-memory pi 子会话跑单个 TaskSpec。
 * - customTools = 业务工具 ∩ allowTools ∩ hub 暴露集 ∩ riskCeiling（无任何 ops_* 发现/派发工具）；
 * - 系统提示词 = L0+L1+L3'+L5（无 L2）；
 * - 子代理事件不进主 transcript，只收集最后一条 assistant 文本供契约解析；
 * - signal 级联：manager 的 AbortController → session.abort()；
 * - maxToolCalls 超限即中止并按 degraded 上报。
 */
async function runSubagentSession(env: SubagentSessionEnv, spec: TaskSpec, signal: AbortSignal): Promise<SubagentRunOutcome> {
  const { pi, handlers } = env;
  const customTools = filterToolsForSubagent(
    listBusinessToolDescriptors(handlers.hub.listExposedTools()),
    spec
  ).map((descriptor) =>
    toPiTool(pi, {
      name: descriptor.name,
      label: descriptor.title,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
      execute: (args, toolSignal, toolCallId) =>
        executeBusinessTool(handlers, descriptor, args, toolSignal ?? signal, env.agentDir, toolCallId)
    })
  );

  const systemPrompt = composeSubagentPrompt({ role: spec.role, spec });
  const settingsManager = pi.SettingsManager.inMemory();
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: env.cwd,
    agentDir: env.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt
  });
  await resourceLoader.reload();

  const { session } = await pi.createAgentSession({
    cwd: env.cwd,
    agentDir: env.agentDir,
    modelRuntime: env.modelRuntime,
    model: env.model,
    // 子会话同样禁用 pi 内置 coding 四件套。
    noTools: 'builtin',
    customTools,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(env.cwd),
    settingsManager
  });

  let lastAssistantText = '';
  let currentText = '';
  let toolCalls = 0;
  let budgetExceeded = false;
  const maxToolCalls = spec.toolPolicy.budget.maxToolCalls;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case 'message_start':
        if ((event.message as { role?: string }).role === 'assistant') currentText = '';
        break;
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          currentText += event.assistantMessageEvent.delta;
          if (currentText.trim().length > 0) lastAssistantText = currentText;
        }
        break;
      case 'tool_execution_start':
        toolCalls += 1;
        if (toolCalls > maxToolCalls && !budgetExceeded) {
          budgetExceeded = true;
          void session.abort().catch(() => {
            // 子会话已结束时的 abort 竞态，无需上报。
          });
        }
        break;
      default:
        break;
    }
  });

  const onAbort = (): void => {
    void session.abort().catch(() => {
      // abort 竞态（子会话已结束），无需上报。
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    await session.prompt(`开始执行任务 ${spec.taskId}：${spec.goal}`);
    return {
      finalText: lastAssistantText,
      ...(budgetExceeded
        ? { degradedReason: `超出 maxToolCalls=${maxToolCalls} 预算，已中止取证` }
        : {})
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
    session.dispose();
  }
}

// ── 外部 MCP 代理工具（可选增强，导出缺席时静默跳过）─────────────────────

/** mcp-client 侧（未来）createExternalMcpProxyTools 返回项的最小面。 */
interface ExternalProxyToolLike {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * 动态探测 src/mcp-client 的 createExternalMcpProxyTools（phase-4 能力，
 * 当前可能尚未导出）。导出缺席、创建失败或返回形状不符时一律返回 []，
 * 绝不影响 AT 主链路。shouldSkip 透传 AT Series 去重判定。
 */
async function loadExternalMcpProxyTools(agentDir: string): Promise<ExternalProxyToolLike[]> {
  let mcp: Record<string, unknown>;
  try {
    mcp = (await import('../mcp-client')) as unknown as Record<string, unknown>;
  } catch {
    return [];
  }
  const create = mcp.createExternalMcpProxyTools;
  if (typeof create !== 'function') return [];
  const shouldSkip = mcp.shouldSkipAtSeriesMcpServer;
  try {
    const created: unknown = await (create as (opts: Record<string, unknown>) => unknown)({
      agentDir,
      ...(typeof shouldSkip === 'function' ? { shouldSkip } : {})
    });
    if (!Array.isArray(created)) return [];
    return created.filter(
      (t): t is ExternalProxyToolLike =>
        !!t &&
        typeof t === 'object' &&
        typeof (t as { name?: unknown }).name === 'string' &&
        typeof (t as { execute?: unknown }).execute === 'function'
    );
  } catch {
    return [];
  }
}

async function createPiRuntime(
  handlers: OpsRuntimeHandlers,
  options: CreateOpsRuntimeOptions
): Promise<OpsRuntime> {
  const pi = await import('@earendil-works/pi-coding-agent');
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? defaultAgentDir();

  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json')
  });

  // P0：SecretStorage 的 API key 经 setRuntimeApiKey 注入 pi 凭证层。
  // models.json 里的 apiKey 往往是 "${secret:…}" 占位符，若不覆盖会被当成
  // 真实 bearer token 发出去。key 只在本地变量中经过，绝不写日志。
  const apiKey = options.getApiKey === undefined ? undefined : await options.getApiKey();
  const hasApiKey = typeof apiKey === 'string' && apiKey.length > 0;
  let keyedProvider: string | undefined;
  if (hasApiKey) {
    keyedProvider = options.model?.provider ?? modelRuntime.getRegisteredProviderIds()[0];
    if (keyedProvider !== undefined && keyedProvider.length > 0) {
      await modelRuntime.setRuntimeApiKey(keyedProvider, apiKey);
    }
  }

  const model = (await resolveModel(modelRuntime, options.model)) as CreateAgentSessionOptions['model'];

  // 实际选中模型的 provider 与首选 provider 不同时（如按可用性兜底选中），
  // 同样注入 key，保证选中模型不用占位符凭证。
  if (hasApiKey) {
    const modelProvider = (model as { provider?: unknown } | undefined)?.provider;
    if (
      typeof modelProvider === 'string' &&
      modelProvider.length > 0 &&
      modelProvider !== keyedProvider
    ) {
      await modelRuntime.setRuntimeApiKey(modelProvider, apiKey);
    }
  }

  // ── 子代理调度：同模型、同 hub 面，in-memory 子会话（结果异步回灌主会话） ──
  const subagentEnv: SubagentSessionEnv = { pi, handlers, cwd, agentDir, modelRuntime, model };
  let mainSession: AgentSession | undefined;

  const deliverToMain = (text: string): void => {
    if (mainSession === undefined) return;
    void mainSession
      .prompt(text, { streamingBehavior: mainSession.isStreaming ? 'steer' : 'followUp' })
      .catch(() => {
        // 回灌失败（会话正被 dispose 等）不致命：事件已经发给 UI。
      });
  };

  const onSubagentStatus = (e: SubagentStatusEvent): void => {
    handlers.onSubagentEvent?.({
      taskId: e.taskId,
      status: e.status,
      role: e.role,
      ...(e.summary !== undefined ? { summary: e.summary } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.evidenceNote !== undefined ? { evidenceNote: e.evidenceNote } : {})
    });
    // 复用 host 已理解的 tool_start/tool_end 事件呈现子代理生命周期。
    const eventId = `subagent:${e.taskId}`;
    const eventName = `subagent_${e.role}`;
    if (e.status === 'running') {
      handlers.onEvent?.({ type: 'tool_start', id: eventId, name: eventName });
    } else if (e.status !== 'queued') {
      handlers.onEvent?.({
        type: 'tool_end',
        id: eventId,
        name: eventName,
        ok: e.status === 'ok' || e.status === 'degraded',
        ...(e.summary !== undefined ? { preview: truncatePreview(e.summary) } : {}),
        ...(e.error !== undefined ? { error: e.error } : {})
      });
      if (e.status !== 'aborted') {
        // 只回灌 ≤800 token 摘要；子代理原始输出/思考不进主 transcript。
        deliverToMain(
          `[子代理 ${e.taskId}（${e.role}）${e.status}]\n${e.summary ?? e.error ?? '（无输出）'}`
        );
      }
    }
  };

  const subagents: SubagentManager = createSubagentManager({
    runner: (spec, signal) => runSubagentSession(subagentEnv, spec, signal),
    onStatus: onSubagentStatus
  });

  const dispatchSubagent = async (
    input: SubagentDispatchInput | TaskSpec
  ): Promise<DispatchSubagentResult> => {
    const built = buildTaskSpec(normalizeDispatchInput(input));
    if (!built.ok) {
      return { taskId: '', status: 'rejected', notice: built.error };
    }
    return subagents.dispatch(built.spec);
  };

  let systemPrompt = buildSystemPrompt({});
  const settingsManager = pi.SettingsManager.inMemory();
  // OpsResourceLoader：skills 只从两个白名单根（打包 skills + agentDir/skills）
  // 发现，noExtensions 恒为 true；其余资源面全关。
  const bundledSkillsDir = options.bundledSkillsDir ?? defaultBundledSkillsDir(cwd);
  const skillRoots = skillRootsFor({ bundledSkillsDir, agentDir });
  const resourceLoader = createOpsResourceLoader(pi, {
    cwd,
    agentDir,
    bundledSkillsDir,
    settingsManager,
    systemPromptOverride: () => systemPrompt
  });
  await resourceLoader.reload();

  // ops_dispatch_subagent 仅注册在主会话（子会话不注册，禁止递归派发）。
  const dispatchTool = toPiTool(pi, {
    name: dispatchToolSpec.name,
    label: dispatchToolSpec.label,
    description: dispatchToolSpec.description,
    parameters: dispatchToolSpec.parameters,
    execute: async (args) => {
      await applyToolGate(handlers, dispatchToolSpec.name, args);
      return JSON.stringify(await dispatchSubagent(args as unknown as SubagentDispatchInput));
    }
  });

  // 常驻附加工具（不受 hub selection 影响；仅主会话，子会话一律没有）。
  const gatedTool = (spec: OpsCustomToolSpec): ToolDefinition =>
    toPiTool(pi, {
      ...spec,
      execute: async (args) => {
        await applyToolGate(handlers, spec.name, args);
        return spec.execute(args);
      }
    });

  const extraToolNames: string[] = [];
  const extraTools: ToolDefinition[] = [];

  // ops_read_skill：命中 playbook/vendor 后按需读 SKILL.md / references。
  const readSkillSpec = createReadSkillTool(skillRoots);
  extraTools.push(gatedTool(readSkillSpec));
  extraToolNames.push(readSkillSpec.name);

  // 可选工作区只读（默认关）；开启也只给 ops_read_workspace_file，绝无 bash。
  if (options.workspaceShellEnabled === true) {
    const workspaceReadSpec = createWorkspaceReadTool(cwd);
    extraTools.push(gatedTool(workspaceReadSpec));
    extraToolNames.push(workspaceReadSpec.name);
  }

  // 目录热更新判定基线：本次注册进会话的业务工具名快照。
  const registeredBusinessNames = new Set(
    listBusinessToolDescriptors(handlers.hub.listAllTools()).map((t) => t.name)
  );

  const customTools = [
    ...buildDiscoveryTools(pi, handlers),
    dispatchTool,
    ...extraTools,
    ...buildBusinessTools(pi, handlers, agentDir)
  ];

  // 外部 MCP 代理工具（phase-4 可选增强）：导出缺席/失败时静默跳过。
  const externalProxyTools = await loadExternalMcpProxyTools(agentDir);
  const takenNames = new Set<string>([
    ...discoveryToolSpecs.map((s) => s.name),
    dispatchToolSpec.name,
    ...extraToolNames,
    ...registeredBusinessNames
  ]);
  for (const proxy of externalProxyTools) {
    // 保留 at_/ops_ 命名空间给内部工具；重名以 hub 业务工具优先。
    if (!isBusinessToolName(proxy.name) || takenNames.has(proxy.name)) continue;
    takenNames.add(proxy.name);
    extraToolNames.push(proxy.name);
    customTools.push(
      toPiTool(pi, {
        name: proxy.name,
        label: proxy.label ?? proxy.name,
        description: proxy.description ?? '',
        parameters: proxy.parameters ?? { type: 'object', properties: {} },
        execute: async (args, signal) => {
          await applyToolGate(handlers, proxy.name, args);
          const result = await proxy.execute(args, signal);
          const text = typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
          return truncateForModel(text, { pluginId: 'external-mcp', name: proxy.name });
        }
      })
    );
  }

  // P1：主会话 JSONL 持久化到 agentDir/sessions（默认 ~/.at-series/agent/sessions）。
  // 创建失败（目录不可写等）时静默回退 in-memory：runtime 层无 vscode logger，
  // 会话可用性优先于持久化。子代理子会话始终 in-memory（不落工作副本 transcript）。
  let sessionManager: SessionManager;
  try {
    sessionManager = pi.SessionManager.create(cwd, join(agentDir, 'sessions'));
  } catch {
    sessionManager = pi.SessionManager.inMemory(cwd);
  }

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    // 思考等级透传（缺省时由 pi 按 settings/模型能力决定）。
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    // 不要内置 coding 四件套（read/bash/edit/write）；只保留 custom 工具。
    noTools: 'builtin',
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager
  });
  mainSession = session;

  // 初始 active = 发现工具 + 常驻附加工具 + 当前暴露的业务工具；
  // select 变化后即时同步。
  session.setActiveToolsByName(activeToolNames(handlers, extraToolNames));
  const selectionSub = handlers.hub.selection.onDidChange(() => {
    session.setActiveToolsByName(activeToolNames(handlers, extraToolNames));
  });
  // P1：工具目录变化（插件桥接上线/下线）时热刷新工具面。
  // 已知限制：pi 的 AgentSession 只在 createAgentSession 期接收 customTools
  // （AgentSessionConfig.customTools，之后是私有 _customTools），0.84.3 没有
  // 任何公开 API 能事后追加/替换 ToolDefinition（reload() 只重载资源）。
  // 因此：
  // - 下线工具立即消失、重新上线的已注册工具立即恢复（setActiveToolsByName）；
  // - 目录里出现全新的业务工具时，通过 handlers.onCatalogNeedsRebuild 通知
  //   host disposeRuntime 并重建，新工具才能进模型工具面。
  const toolsSub = handlers.hub.onDidChangeTools?.(() => {
    session.setActiveToolsByName(activeToolNames(handlers, extraToolNames));
    if (catalogGainedNewBusinessTool(registeredBusinessNames, handlers.hub.listAllTools())) {
      handlers.onCatalogNeedsRebuild?.();
    }
  });
  const unsubscribe = subscribeSessionEvents(session, handlers);

  return {
    async prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void> {
      const run = async (): Promise<void> => {
        if (opts?.mode) {
          await session.prompt(text, { streamingBehavior: opts.mode });
        } else if (session.isStreaming) {
          // 运行中未指定 mode 时按 steer 处理（追加约束），避免 pi 抛错。
          await session.prompt(text, { streamingBehavior: 'steer' });
        } else {
          await session.prompt(text);
        }
      };
      try {
        await run();
      } catch (error) {
        try {
          // Compaction 第 2–3 层：prompt 过长时 session.compact() 一次并
          // 重试同一条 prompt 一次（严格一次，绝不无限重试）；仍失败抛中文
          // 「请开新会话」提示。非溢出错误原样 rethrow，走下面的统一上报。
          await recoverFromPromptError({ session, error, retry: run });
        } catch (finalError) {
          // prompt 期错误（如凭证被吊销）不往上抛：给 UI 一条事件并回 idle。
          handlers.onEvent?.({
            type: 'text_delta',
            id: 'runtime-error',
            text: `模型调用失败：${describeError(finalError)}`
          });
          handlers.onEvent?.({ type: 'idle' });
        }
      }
    },
    abort(): void {
      // 全局停止 = 主会话 + 全部子代理级联中止。
      subagents.abortAll();
      void session.abort().catch(() => {
        // abort 竞态（会话已结束）无需上报。
      });
    },
    async dispose(): Promise<void> {
      mainSession = undefined;
      subagents.abortAll();
      selectionSub.dispose();
      toolsSub?.dispose();
      unsubscribe();
      try {
        await session.abort();
      } catch {
        // 忽略 dispose 期的 abort 失败。
      }
      session.dispose();
    },
    setSystemPrompt(prompt: string): void {
      systemPrompt = prompt;
      // 立即生效于下一次 LLM 调用；后续 setActiveToolsByName 触发的
      // rebuild 会经 resourceLoader.systemPromptOverride 读到同一份。
      session.agent.state.systemPrompt = prompt;
    },
    setThinkingLevel(level: OpsThinkingLevel): void {
      // AgentSession 0.84 提供 setThinkingLevel（按模型能力收敛并落
      // 会话 transcript）；防御性探测，实现缺席时静默忽略。
      const setter = (session as { setThinkingLevel?: (l: OpsThinkingLevel) => void })
        .setThinkingLevel;
      if (typeof setter === 'function') {
        setter.call(session, level);
      }
    },
    dispatchSubagent,
    abortSubagent(taskId: string): void {
      subagents.abort(taskId);
    }
  };
}

// ── 工厂 ─────────────────────────────────────────────────────────────────

/**
 * 创建 Ops 运行时。任何创建期失败（pi 加载、凭证、模型解析、会话创建）
 * 都不抛出，改为返回 FallbackRuntime，保证扩展激活不受影响。
 */
export async function createOpsRuntime(
  handlers: OpsRuntimeHandlers,
  options: CreateOpsRuntimeOptions = {}
): Promise<OpsRuntime> {
  try {
    return await createPiRuntime(handlers, options);
  } catch (error) {
    return createFallbackRuntime(handlers, describeError(error));
  }
}
