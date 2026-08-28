/**
 * ops_* 发现工具的纯函数实现。
 *
 * 本文件不依赖 pi SDK（也不 import vscode），只依赖 protocol 契约，
 * 因此可以在 vitest 中用假 hub 直接单测。src/runtime/index.ts 负责把
 * 这些 spec 包装成 pi 的 defineTool。
 *
 * 注意：selection ≠ 授权。「调查中禁止 clear / 二次 replace」等策略
 * 由 policy 的 beforeToolCall 闸门拒绝，本模块始终暴露工具本身。
 */
import type {
  AgentToolDescriptor,
  ListProvidersResult,
  SelectionController,
  ToolInvocation,
  ToolInvocationResult,
  ToolRisk
} from '../protocol';

/** runtime 需要的 hub 面（OpsRuntimeHandlers['hub'] 的结构子集）。 */
export interface DiscoveryHub {
  listAllTools(): readonly AgentToolDescriptor[];
  listExposedTools(): readonly AgentToolDescriptor[];
  getProviders(): ListProvidersResult;
  invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
  selection: SelectionController;
}

export const DESCRIPTION_PREVIEW_LIMIT = 120;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

// ── ops_search_tools ─────────────────────────────────────────────────────

export interface SearchToolsArgs {
  query?: string;
  pluginId?: string;
  limit?: number;
}

export interface ToolSearchHit {
  name: string;
  title: string;
  pluginId: string;
  risk: ToolRisk;
  descriptionPreview: string;
}

export interface SearchToolsResult {
  total: number;
  returned: number;
  tools: ToolSearchHit[];
}

export function searchTools(hub: DiscoveryHub, args: SearchToolsArgs = {}): SearchToolsResult {
  const query = (args.query ?? '').trim().toLowerCase();
  let candidates = hub.listAllTools();
  if (args.pluginId) {
    candidates = candidates.filter((t) => t.pluginId === args.pluginId);
  }
  const matched = query
    ? candidates.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.title.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query)
      )
    : [...candidates];

  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_SEARCH_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_SEARCH_LIMIT);
  const hits = matched.slice(0, limit).map((t) => ({
    name: t.name,
    title: t.title,
    pluginId: t.pluginId,
    risk: t.risk,
    descriptionPreview: t.description.slice(0, DESCRIPTION_PREVIEW_LIMIT)
  }));

  return { total: matched.length, returned: hits.length, tools: hits };
}

// ── ops_get_tool ─────────────────────────────────────────────────────────

export type GetToolResult =
  | AgentToolDescriptor
  | { error: 'NOT_FOUND'; message: string };

export function getTool(hub: DiscoveryHub, name: string): GetToolResult {
  const tool = hub.listAllTools().find((t) => t.name === name);
  if (!tool) {
    return {
      error: 'NOT_FOUND',
      message: `未找到工具 "${name}"。用 ops_search_tools 按关键词搜索，或 ops_list_providers 查看可用插件。`
    };
  }
  return tool;
}

// ── ops_list_providers ───────────────────────────────────────────────────

export function listProviders(hub: DiscoveryHub): ListProvidersResult {
  return hub.getProviders();
}

// ── ops_select_tools / ops_clear_tool_selection ──────────────────────────

export interface SelectToolsArgs {
  pluginIds?: string[];
  names?: string[];
  mode?: 'replace' | 'add';
}

export type SelectToolsOutcome =
  | { selected: string[]; exposed: string[] }
  | { error: 'INVALID_ARGS'; message: string };

export async function selectTools(hub: DiscoveryHub, args: SelectToolsArgs = {}): Promise<SelectToolsOutcome> {
  const pluginIds = args.pluginIds?.filter((id) => typeof id === 'string' && id.length > 0);
  const names = args.names?.filter((n) => typeof n === 'string' && n.length > 0);
  if ((!pluginIds || pluginIds.length === 0) && (!names || names.length === 0)) {
    return {
      error: 'INVALID_ARGS',
      message: 'ops_select_tools 需要 pluginIds 或 names 至少其一；先用 ops_list_providers / ops_search_tools 确定目标。'
    };
  }
  return hub.selection.select({ pluginIds, names, mode: args.mode });
}

export interface ClearToolSelectionOutcome {
  cleared: true;
  state: ReturnType<SelectionController['state']>;
}

export async function clearToolSelection(hub: DiscoveryHub): Promise<ClearToolSelectionOutcome> {
  await hub.selection.clear();
  return { cleared: true, state: hub.selection.state() };
}

// ── 业务工具过滤 ─────────────────────────────────────────────────────────

/** 非 at_ / 非 ops_ 前缀的工具才作为业务工具注册给模型。 */
export function isBusinessToolName(name: string): boolean {
  return !name.startsWith('at_') && !name.startsWith('ops_');
}

export function listBusinessToolDescriptors(
  tools: readonly AgentToolDescriptor[]
): AgentToolDescriptor[] {
  return tools.filter((t) => isBusinessToolName(t.name));
}

// ── 发现工具 spec（供 runtime 包装成 defineTool，供测试直接驱动）─────────

export interface DiscoveryToolSpec {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema（pi-ai 的参数校验兼容普通 JSON Schema 对象）。 */
  readonly parameters: Record<string, unknown>;
  /** 纯函数 execute：输入 hub 与模型参数，输出给模型的 JSON 字符串。 */
  execute(hub: DiscoveryHub, args: Record<string, unknown>): Promise<string>;
}

export const discoveryToolSpecs: readonly DiscoveryToolSpec[] = [
  {
    name: 'ops_list_providers',
    label: 'Ops：列出能力插件',
    description: '列出已接入的 AT 能力插件（provider）、健康状态、桥接数与工具名清单。开始任务前先看这里。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (hub) => JSON.stringify(listProviders(hub))
  },
  {
    name: 'ops_search_tools',
    label: 'Ops：搜索工具',
    description:
      '按关键词搜索所有已注册工具（匹配 name/title/description，不区分大小写），' +
      `返回 ${DESCRIPTION_PREVIEW_LIMIT} 字符描述预览。可用 pluginId 限定插件范围。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        pluginId: { type: 'string', description: '限定插件 id，如 at.grafana' },
        limit: {
          type: 'number',
          description: `返回条数上限，默认 ${DEFAULT_SEARCH_LIMIT}，最大 ${MAX_SEARCH_LIMIT}`
        }
      },
      required: ['query'],
      additionalProperties: false
    },
    execute: async (hub, args) => JSON.stringify(searchTools(hub, args as SearchToolsArgs))
  },
  {
    name: 'ops_get_tool',
    label: 'Ops：查看工具详情',
    description: '按名称取单个工具的完整 descriptor（含 inputSchema、risk、pluginId）。调用业务工具前先看清参数。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工具名，如 grafana_query_prometheus' }
      },
      required: ['name'],
      additionalProperties: false
    },
    execute: async (hub, args) => JSON.stringify(getTool(hub, String(args.name ?? '')))
  },
  {
    name: 'ops_select_tools',
    label: 'Ops：选择工具暴露集',
    description:
      '把插件（pluginIds）或具体工具（names）选入模型可见的暴露集。mode=replace 覆盖当前选择，mode=add 追加。' +
      '每个任务只做一轮 select；选择 ≠ 授权，write/exec 仍需审批。',
    parameters: {
      type: 'object',
      properties: {
        pluginIds: { type: 'array', items: { type: 'string' }, description: '插件 id 列表，如 ["at.grafana"]' },
        names: { type: 'array', items: { type: 'string' }, description: '具体工具名列表' },
        mode: { type: 'string', enum: ['replace', 'add'], description: '默认 replace' }
      },
      additionalProperties: false
    },
    execute: async (hub, args) => JSON.stringify(await selectTools(hub, args as SelectToolsArgs))
  },
  {
    name: 'ops_clear_tool_selection',
    label: 'Ops：清空工具选择',
    description: '清空当前工具暴露集选择。调查（investigating）中禁止调用，会被策略闸门拒绝。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (hub) => JSON.stringify(await clearToolSelection(hub))
  }
];

export const discoveryToolNames: readonly string[] = discoveryToolSpecs.map((s) => s.name);

/** 按名称执行某个发现工具（runtime 与测试共用的入口）。 */
export async function executeDiscoveryTool(
  hub: DiscoveryHub,
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const spec = discoveryToolSpecs.find((s) => s.name === name);
  if (!spec) {
    throw new Error(`未知发现工具: ${name}`);
  }
  return spec.execute(hub, args);
}
