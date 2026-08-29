/**
 * 子会话 env：模型解析、in-memory 子代理会话、主会话 subagent 调度层。
 *
 * 从 src/runtime/index.ts 搬移（createPiRuntime 的子会话部分），零行为变化。
 * 禁止 import vscode。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ModelRuntime
} from '@earendil-works/pi-coding-agent';

import type { TaskSpec } from '../orchestrator';
import { composeSubagentPrompt } from '../prompts/roles';
import { describeError } from './fallback';
import { listBusinessToolDescriptors } from './discovery-tools';
import {
  buildTaskSpec,
  createSubagentManager,
  filterToolsForSubagent,
  normalizeDispatchInput,
  type SubagentDispatchInput,
  type SubagentManager,
  type SubagentRunOutcome,
  type SubagentStatusEvent
} from './subagents';
import {
  executeBusinessTool,
  toPiTool,
  truncatePreview,
  type PiModule
} from './tool-gate';
import type {
  CreateOpsRuntimeOptions,
  DispatchSubagentResult,
  OpsRuntimeHandlers,
  ToolCallOrigin
} from './types';

export function defaultAgentDir(): string {
  return join(homedir(), '.at-series', 'agent');
}

interface PiModelRuntimeLike {
  getModel(providerId: string, modelId: string): unknown;
  getAvailable(providerId?: string): Promise<readonly unknown[]>;
}

export async function resolveModel(
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

export type RoleModelRole = 'investigator' | 'executor' | 'writer' | 'verifier';

/** settings `{provider, model}` → resolveModel 的 `{provider, id}`；也接受 `{id}`。 */
export function roleModelPrefOf(
  roleModels: CreateOpsRuntimeOptions['roleModels'] | undefined,
  role: string
): { provider: string; id: string } | undefined {
  if (roleModels === undefined) return undefined;
  const entry = roleModels[role as RoleModelRole];
  if (entry === undefined || typeof entry.provider !== 'string' || entry.provider.length === 0) {
    return undefined;
  }
  const id =
    typeof entry.id === 'string' && entry.id.length > 0
      ? entry.id
      : typeof entry.model === 'string' && entry.model.length > 0
        ? entry.model
        : undefined;
  if (id === undefined) return undefined;
  return { provider: entry.provider, id };
}

export interface ResolveSubagentModelInput {
  role: RoleModelRole;
  roleModels?: CreateOpsRuntimeOptions['roleModels'];
  fallback: unknown;
  modelRuntime: PiModelRuntimeLike;
  injectApiKey: (providerId: string | undefined) => Promise<void>;
  resolveModel?: (
    runtime: PiModelRuntimeLike,
    pref: CreateOpsRuntimeOptions['model']
  ) => Promise<unknown>;
  onError?: (message: string) => void;
}

/**
 * 子会话按 roleModels 解析模型；未配置或失败时回落 fallback（主会话模型），不抛错。
 * 导出供单测 mock resolveModel。
 */
export async function resolveSubagentModel(input: ResolveSubagentModelInput): Promise<unknown> {
  const pref = roleModelPrefOf(input.roleModels, input.role);
  if (pref === undefined) return input.fallback;
  try {
    await input.injectApiKey(pref.provider);
    const resolved = await (input.resolveModel ?? resolveModel)(input.modelRuntime, pref);
    const resolvedProvider = (resolved as { provider?: unknown } | undefined)?.provider;
    if (typeof resolvedProvider === 'string') {
      await input.injectApiKey(resolvedProvider);
    }
    return resolved;
  } catch (err) {
    input.onError?.(
      `roleModels[${input.role}] ${pref.provider}/${pref.id} 解析失败，回落主模型：${describeError(err)}`
    );
    return input.fallback;
  }
}

// ── 子代理子会话 ─────────────────────────────────────────────────────────

export interface SubagentSessionEnv {
  pi: PiModule;
  handlers: OpsRuntimeHandlers;
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: CreateAgentSessionOptions['model'];
  roleModels?: CreateOpsRuntimeOptions['roleModels'];
  injectApiKey: (providerId: string | undefined) => Promise<void>;
  resolveModel?: ResolveSubagentModelInput['resolveModel'];
}

/**
 * 在同进程内另起一个 in-memory pi 子会话跑单个 TaskSpec。
 * - customTools = 业务工具 ∩ allowTools ∩ hub 暴露集 ∩ riskCeiling（无任何 ops_* 发现/派发工具）；
 * - 系统提示词 = L0+L1+L3'+L5（无 L2）；
 * - 子代理事件不进主 transcript，只收集最后一条 assistant 文本供契约解析；
 * - signal 级联：manager 的 AbortController → session.abort()；
 * - maxToolCalls 超限即中止并按 degraded 上报。
 */
export async function runSubagentSession(
  env: SubagentSessionEnv,
  spec: TaskSpec,
  signal: AbortSignal
): Promise<SubagentRunOutcome> {
  const { pi, handlers } = env;
  const model = (await resolveSubagentModel({
    role: spec.role,
    roleModels: env.roleModels,
    fallback: env.model,
    modelRuntime: env.modelRuntime,
    injectApiKey: env.injectApiKey,
    ...(env.resolveModel !== undefined ? { resolveModel: env.resolveModel } : {}),
    onError: (message) => {
      handlers.onEvent?.({ type: 'notice', variant: 'info', text: message });
    }
  })) as CreateAgentSessionOptions['model'];
  // P0-D：子会话的每次工具调用都带 origin（role/riskCeiling/approvalToken
  // 引用），host 透传给 evaluatePolicy 执行角色规则。
  const origin: ToolCallOrigin = {
    kind: 'subagent',
    taskId: spec.taskId,
    role: spec.role,
    riskCeiling: spec.toolPolicy.riskCeiling,
    ...(spec.approvalToken?.briefId !== undefined
      ? { approvalToken: spec.approvalToken.briefId }
      : {})
  };
  const descriptors = filterToolsForSubagent(
    listBusinessToolDescriptors(handlers.hub.listExposedTools()),
    spec
  );
  const customTools = descriptors.map((descriptor) =>
    toPiTool(pi, {
      name: descriptor.name,
      label: descriptor.title,
      description: descriptor.description,
      parameters: descriptor.inputSchema,
      execute: (args, toolSignal, toolCallId) =>
        executeBusinessTool(
          spec.toolPolicy.payloadCaps !== undefined
            ? { ...handlers, payloadCaps: spec.toolPolicy.payloadCaps }
            : handlers,
          descriptor,
          args,
          toolSignal ?? signal,
          env.agentDir,
          toolCallId,
          origin
        )
    })
  );

  const systemPrompt = composeSubagentPrompt({
    role: spec.role,
    spec,
    visibleTools: descriptors.map((d) => d.name)
  });
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
    model,
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

export function createMainSubagentLayer(input: {
  pi: PiModule;
  handlers: OpsRuntimeHandlers;
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: CreateAgentSessionOptions['model'];
  injectApiKey: (providerId: string | undefined) => Promise<void>;
  roleModels?: CreateOpsRuntimeOptions['roleModels'];
}): {
  subagents: SubagentManager;
  dispatchSubagent: (spec: SubagentDispatchInput | TaskSpec) => Promise<DispatchSubagentResult>;
} {
  const { pi, handlers } = input;
  // ── 子代理调度：同模型、同 hub 面，in-memory 子会话 ─────────────────────
  // P1-6：ops_dispatch_subagent 是阻塞式工具（工具结果 = 终态摘要 JSON），
  // 结果经 tool result 一次性回到主 transcript——deliverToMain 的 prompt
  // 回灌已删除（不再有伪装 user 消息的异步插播）。
  const subagentEnv: SubagentSessionEnv = {
    pi,
    handlers,
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: input.modelRuntime,
    model: input.model,
    injectApiKey: input.injectApiKey,
    ...(input.roleModels !== undefined ? { roleModels: input.roleModels } : {})
  };

  // 派发时登记 goal + 实际注入的工具名（与 runSubagentSession 用同一套
  // filterToolsForSubagent 过滤），全部生命周期事件都带上——host 侧子代理卡
  // 据此渲染「目标 / 可见工具」，摘要事件合并时不丢字段。
  const subagentMeta = new Map<string, { goal: string; visibleTools: string[] }>();
  const registerSubagentMeta = (spec: TaskSpec): void => {
    subagentMeta.set(spec.taskId, {
      goal: spec.goal,
      visibleTools: filterToolsForSubagent(
        listBusinessToolDescriptors(handlers.hub.listExposedTools()),
        spec
      ).map((tool) => tool.name)
    });
  };

  const onSubagentStatus = (e: SubagentStatusEvent): void => {
    const meta = subagentMeta.get(e.taskId);
    handlers.onSubagentEvent?.({
      taskId: e.taskId,
      status: e.status,
      role: e.role,
      ...(meta !== undefined ? { goal: meta.goal, visibleTools: [...meta.visibleTools] } : {}),
      ...(e.summary !== undefined ? { summary: e.summary } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.evidenceNote !== undefined ? { evidenceNote: e.evidenceNote } : {})
    });
    // 复用 host 已理解的 tool_start/tool_end 事件呈现子代理生命周期
    //（host API dispatchSubagent 派发的任务没有对应的模型侧工具调用卡片）。
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
    }
  };

  const rawSubagents: SubagentManager = createSubagentManager({
    runner: (spec, signal) => runSubagentSession(subagentEnv, spec, signal),
    onStatus: onSubagentStatus
  });
  // dispatch 前登记 meta：首个 queued 事件就带 goal/visibleTools。
  // 模型侧 ops_dispatch_subagent（runDispatchToolCall）与 host API 共用本包装。
  const subagents: SubagentManager = {
    ...rawSubagents,
    dispatch(spec: TaskSpec) {
      registerSubagentMeta(spec);
      return rawSubagents.dispatch(spec);
    }
  };

  const dispatchSubagent = async (
    spec: SubagentDispatchInput | TaskSpec
  ): Promise<DispatchSubagentResult> => {
    const built = buildTaskSpec(normalizeDispatchInput(spec));
    if (!built.ok) {
      return { taskId: '', status: 'rejected', notice: built.error };
    }
    return subagents.dispatch(built.spec);
  };

  return { subagents, dispatchSubagent };
}
