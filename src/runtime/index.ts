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
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ToolDefinition
} from '@earendil-works/pi-coding-agent';

import type {
  AgentToolDescriptor,
  ListProvidersResult,
  SelectionController,
  ToolInvocation,
  ToolInvocationResult
} from '../protocol';
import { composeSystemPrompt } from '../prompts/layers';
import {
  discoveryToolSpecs,
  executeDiscoveryTool,
  isBusinessToolName,
  listBusinessToolDescriptors,
  type DiscoveryHub
} from './discovery-tools';

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

// ── 对外契约 ─────────────────────────────────────────────────────────────

export type OpsRuntimeHandlers = {
  hub: {
    listAllTools(): readonly AgentToolDescriptor[];
    listExposedTools(): readonly AgentToolDescriptor[];
    getProviders(): ListProvidersResult;
    invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
    selection: SelectionController;
  };
  /** 权限闸（policy）。返回 block=true 时该次工具调用被拒绝，reason 回给模型。 */
  beforeToolCall?: (ctx: {
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<{ block: boolean; reason?: string }>;
  onEvent?: (e: OpsRuntimeEvent) => void;
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

export interface OpsRuntime {
  prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  setSystemPrompt(prompt: string): void;
}

export interface CreateOpsRuntimeOptions {
  /** 默认 ~/.at-series/agent（auth.json / models.json / models-store.json 都落在这里）。 */
  agentDir?: string;
  cwd?: string;
  model?: { provider?: string; id?: string };
}

/** 组装 L0+L1+L2（+可选 playbook 注入层）系统提示词。 */
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
  execute(args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string>;
}

function toPiTool(pi: PiModule, source: OpsToolSource): ToolDefinition {
  const definition = {
    name: source.name,
    label: source.label,
    description: source.description,
    parameters: source.parameters,
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const args =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const text = await source.execute(args, signal);
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

function buildBusinessTools(pi: PiModule, handlers: OpsRuntimeHandlers): ToolDefinition[] {
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
      execute: async (args, signal) => {
        await applyToolGate(handlers, descriptor.name, args);
        const result = await handlers.hub.invoke({
          name: descriptor.name,
          arguments: args,
          abort: signal
        });
        return JSON.stringify(result);
      }
    })
  );
}

function exposedBusinessToolNames(handlers: OpsRuntimeHandlers): string[] {
  return listBusinessToolDescriptors(handlers.hub.listExposedTools()).map((t) => t.name);
}

function activeToolNames(handlers: OpsRuntimeHandlers): string[] {
  return [...discoveryToolSpecs.map((s) => s.name), ...exposedBusinessToolNames(handlers)];
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
  const model = await resolveModel(modelRuntime, options.model);

  let systemPrompt = buildSystemPrompt({});
  const settingsManager = pi.SettingsManager.inMemory();
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // 资源发现由 OpsResourceLoader（后续迭代）负责；这里保持最小面，
    // 不加载用户目录下的任意扩展/皮肤/上下文文件。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt
  });
  await resourceLoader.reload();

  const customTools = [
    ...buildDiscoveryTools(pi, handlers),
    ...buildBusinessTools(pi, handlers)
  ];

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: model as CreateAgentSessionOptions['model'],
    // 不要内置 coding 四件套（read/bash/edit/write）；只保留 custom 工具。
    noTools: 'builtin',
    customTools,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(cwd),
    settingsManager
  });

  // 初始 active = 发现工具 + 当前暴露的业务工具；select 变化后即时同步。
  session.setActiveToolsByName(activeToolNames(handlers));
  const selectionSub = handlers.hub.selection.onDidChange(() => {
    session.setActiveToolsByName(activeToolNames(handlers));
  });
  const unsubscribe = subscribeSessionEvents(session, handlers);

  return {
    async prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void> {
      try {
        if (opts?.mode) {
          await session.prompt(text, { streamingBehavior: opts.mode });
        } else if (session.isStreaming) {
          // 运行中未指定 mode 时按 steer 处理（追加约束），避免 pi 抛错。
          await session.prompt(text, { streamingBehavior: 'steer' });
        } else {
          await session.prompt(text);
        }
      } catch (error) {
        // prompt 期错误（如凭证被吊销）不往上抛：给 UI 一条事件并回 idle。
        handlers.onEvent?.({
          type: 'text_delta',
          id: 'runtime-error',
          text: `模型调用失败：${describeError(error)}`
        });
        handlers.onEvent?.({ type: 'idle' });
      }
    },
    abort(): void {
      void session.abort().catch(() => {
        // abort 竞态（会话已结束）无需上报。
      });
    },
    async dispose(): Promise<void> {
      selectionSub.dispose();
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
