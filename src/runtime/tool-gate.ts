/**
 * 统一权限闸、业务工具执行、结果截断/落盘。从 index.ts 搬移，零行为变化。禁止 import vscode。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { injectPayloadCaps } from '../orchestrator';
import type { AgentToolDescriptor, ToolInvocationResult } from '../protocol';
import {
  discoveryToolSpecs,
  executeDiscoveryTool,
  isBusinessToolName,
  listBusinessToolDescriptors,
  type DiscoveryHub
} from './discovery-tools';
import { redactSecrets } from './sanitize';
import { dispatchToolSpec } from './subagents';
import type { CreateOpsRuntimeOptions, OpsRuntimeHandlers, ToolCallOrigin } from './types';

/** 我们实际构造的工具形状；通过 pi.defineTool 收窄成 ToolDefinition。 */
export interface OpsToolSource {
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

export type PiModule = typeof import('@earendil-works/pi-coding-agent');

/** tool_end 事件 preview 截断上限（4KB）。完整 result JSON 仍然给模型。 */
export const TOOL_END_PREVIEW_LIMIT = 4096;

export function truncatePreview(text: string, limit = TOOL_END_PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

/** 主会话工具调用的固定 origin。 */
export const MAIN_ORIGIN: ToolCallOrigin = { kind: 'main' };

/**
 * applyToolGate 的结果：allow = 继续执行；reject = 把 resultJson 作为工具
 * 结果原样返回给模型（审批被拒 / 审批通道未接线，不抛错、不让模型重试）。
 */
export type ToolGateResult = { kind: 'allow' } | { kind: 'reject'; resultJson: string };

/**
 * 统一权限闸（P0-D）：
 * - block=true → throw（pi 记为 isError，与旧行为一致）；
 * - needSessionApproval=true → 在本次 execute 内 await handlers.requestApproval：
 *   批准 → allow（继续同一调用）；拒绝 / host 未接线 → 返回结构化拒绝 JSON
 *   作为工具结果（绝不为审批抛错）。
 */
export async function applyToolGate(
  handlers: OpsRuntimeHandlers,
  toolName: string,
  args: Record<string, unknown>,
  origin: ToolCallOrigin = MAIN_ORIGIN
): Promise<ToolGateResult> {
  if (!handlers.beforeToolCall) return { kind: 'allow' };
  const verdict = await handlers.beforeToolCall({ toolName, args, origin });
  if (verdict.block) {
    throw new Error(verdict.reason ?? `工具 ${toolName} 被策略闸门拒绝`);
  }
  if (verdict.needSessionApproval !== true) return { kind: 'allow' };

  const risk: 'write' | 'exec' = verdict.risk ?? 'write';
  if (handlers.requestApproval === undefined) {
    return {
      kind: 'reject',
      resultJson: JSON.stringify({
        ok: false,
        error: {
          code: 'OPS_APPROVAL_REQUIRED',
          message:
            verdict.reason ??
            `${risk} 级工具 ${toolName} 需要会话内批准，但审批通道未接线；请告知用户在界面上处理。`
        }
      })
    };
  }
  const decision = await handlers.requestApproval({
    toolName,
    args,
    risk,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    origin
  });
  if (decision === 'approved') return { kind: 'allow' };
  return {
    kind: 'reject',
    resultJson: JSON.stringify({
      ok: false,
      error: {
        code: 'OPS_APPROVAL_REJECTED',
        message: `用户拒绝了 ${toolName} 的审批请求。不要原样重试同一调用；如需继续，请调整方案后重新征询用户。`
      }
    })
  };
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
  const full = redactSecrets(text).text;
  if (full.length <= limit) return full;
  const source = `${context.pluginId ?? '未知插件'}/${context.name ?? '未知工具'}`;
  const notice =
    `【截断提示】工具 ${source} 的完整输出共 ${full.length} 字符，超过 ${limit} 字符上限，以下内容已被截断` +
    (context.savedPath !== undefined ? `；完整 JSON 已写入 ${context.savedPath}` : '') +
    '。\n';
  const room = Math.max(limit - notice.length - TRUNCATED_SUFFIX.length, 0);
  return `${notice}${full.slice(0, room)}${TRUNCATED_SUFFIX}`;
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
    await writeFile(file, redactSecrets(json).text, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * 业务工具统一执行路径（主会话与子会话共用）：
 * - 先 injectPayloadCaps（playbook defaults；缺席 no-op），再策略闸门
 *   （origin 标识主会话/子代理；审批被拒时直接返回结构化拒绝 JSON，
 *   不 invoke、不抛错）→ hub.invoke；
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
  toolCallId?: string,
  origin: ToolCallOrigin = MAIN_ORIGIN
): Promise<string> {
  const capped = injectPayloadCaps(descriptor.name, args, handlers.payloadCaps);
  const gate = await applyToolGate(handlers, descriptor.name, capped, origin);
  if (gate.kind === 'reject') return gate.resultJson;
  const result = await handlers.hub.invoke({
    name: descriptor.name,
    arguments: capped,
    abort: signal
  });
  if (isCancelledInvocation(result)) {
    throw new Error(result.error?.message ?? `工具 ${descriptor.name} 调用已被用户取消`);
  }
  const full = redactSecrets(JSON.stringify(result)).text;
  if (full.length <= MODEL_RESULT_CHAR_LIMIT) return full;
  const savedPath = await persistFullToolResult(agentDir, toolCallId ?? randomUUID(), full);
  return truncateForModel(full, {
    pluginId: descriptor.pluginId,
    name: descriptor.name,
    ...(savedPath !== undefined ? { savedPath } : {})
  });
}

export function toPiTool(pi: PiModule, source: OpsToolSource): ToolDefinition {
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

export function buildDiscoveryTools(
  pi: PiModule,
  handlers: OpsRuntimeHandlers,
  decorateResult?: (toolName: string, args: Record<string, unknown>, resultJson: string) => string
): ToolDefinition[] {
  const hub: DiscoveryHub = handlers.hub;
  return discoveryToolSpecs.map((spec) =>
    toPiTool(pi, {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (args) => {
        const gate = await applyToolGate(handlers, spec.name, args, MAIN_ORIGIN);
        if (gate.kind === 'reject') return gate.resultJson;
        const result = await executeDiscoveryTool(hub, spec.name, args);
        return decorateResult !== undefined ? decorateResult(spec.name, args, result) : result;
      }
    })
  );
}

export function buildBusinessTools(
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

export function activeToolNames(
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

// ── 外部 MCP 代理工具（可选增强，导出缺席时静默跳过）─────────────────────

/** mcp-client 侧（未来）createExternalMcpProxyTools 返回项的最小面。 */
export interface ExternalProxyToolLike {
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
export async function loadExternalMcpProxyTools(agentDir: string): Promise<ExternalProxyToolLike[]> {
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

export function createApiKeyInjector(
  modelRuntime: { setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> },
  getApiKey: CreateOpsRuntimeOptions['getApiKey']
): (providerId: string | undefined) => Promise<void> {
  const keyedProviders = new Set<string>();
  return async (providerId: string | undefined): Promise<void> => {
    if (getApiKey === undefined) return;
    if (providerId === undefined || providerId.length === 0) return;
    if (keyedProviders.has(providerId)) return;
    keyedProviders.add(providerId);
    const apiKey = await getApiKey(providerId);
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      await modelRuntime.setRuntimeApiKey(providerId, apiKey);
    }
  };
}

/**
 * 外部 MCP 代理工具（phase-4 可选增强）：导出缺席/失败时静默跳过。
 * 保留 at_/ops_ 命名空间给内部工具；重名以 hub 业务工具优先。
 */
export async function appendExternalMcpProxyTools(
  pi: PiModule,
  handlers: OpsRuntimeHandlers,
  agentDir: string,
  customTools: ToolDefinition[],
  extraToolNames: string[],
  registeredBusinessNames: ReadonlySet<string>
): Promise<void> {
  const externalProxyTools = await loadExternalMcpProxyTools(agentDir);
  const takenNames = new Set<string>([
    ...discoveryToolSpecs.map((s) => s.name),
    dispatchToolSpec.name,
    ...extraToolNames,
    ...registeredBusinessNames
  ]);
  for (const proxy of externalProxyTools) {
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
          const gate = await applyToolGate(handlers, proxy.name, args, MAIN_ORIGIN);
          if (gate.kind === 'reject') return gate.resultJson;
          const result = await proxy.execute(args, signal);
          const text = typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
          return truncateForModel(text, { pluginId: 'external-mcp', name: proxy.name });
        }
      })
    );
  }
}
