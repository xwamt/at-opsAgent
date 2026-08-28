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
  Event,
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
  /**
   * 工具目录变化事件（插件桥接上线/下线）。可选：HubHost 的
   * Event<ToolChangeEvent> 可直接赋值（Event 对 T 逆变安全）。
   */
  onDidChangeTools?: Event<unknown>;
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
  /** true = live catalog 命中；false = 仅插件声明（stub）。缺省视为 live。 */
  live?: boolean;
}

export interface SearchToolsResult {
  total: number;
  returned: number;
  tools: ToolSearchHit[];
}

/** stub 命中的描述：告诉模型立刻 select，别再 get_tool 空转。 */
export const STUB_HIT_DESCRIPTION =
  '…声明工具，尚未进入 live catalog。请 ops_select_tools，不要重复 get_tool。';

/**
 * live catalog 未命中时的回退：在 providers[].toolNames（插件声明清单）里
 * 搜 stub 命中。query 匹配工具名，或匹配插件 displayName / pluginId（此时
 * 该插件全部未 live 的声明名都算命中）。已在 live catalog 的名字不出 stub。
 */
function searchDeclaredStubs(hub: DiscoveryHub, query: string, pluginId?: string): ToolSearchHit[] {
  const liveNames = new Set(hub.listAllTools().map((t) => t.name));
  let providers = hub.getProviders().providers;
  if (pluginId) {
    providers = providers.filter((p) => p.pluginId === pluginId);
  }
  const stubs: ToolSearchHit[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const providerMatched =
      query.length > 0 &&
      (provider.displayName.toLowerCase().includes(query) ||
        provider.pluginId.toLowerCase().includes(query));
    for (const name of provider.toolNames) {
      if (liveNames.has(name) || seen.has(name)) {
        continue;
      }
      if (query && !providerMatched && !name.toLowerCase().includes(query)) {
        continue;
      }
      seen.add(name);
      stubs.push({
        name,
        title: name,
        pluginId: provider.pluginId,
        risk: 'read',
        descriptionPreview: STUB_HIT_DESCRIPTION,
        live: false
      });
    }
  }
  return stubs;
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

  // live 未命中（含 catalog 为空）时回退到声明清单，避免对已声明的名字返回 total:0 空转。
  const stubs = matched.length === 0 ? searchDeclaredStubs(hub, query, args.pluginId) : [];

  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_SEARCH_LIMIT;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_SEARCH_LIMIT);
  const liveHits: ToolSearchHit[] = matched.slice(0, limit).map((t) => ({
    name: t.name,
    title: t.title,
    pluginId: t.pluginId,
    risk: t.risk,
    descriptionPreview: t.description.slice(0, DESCRIPTION_PREVIEW_LIMIT),
    live: true
  }));
  const hits = liveHits.length > 0 ? liveHits : stubs.slice(0, limit);

  return { total: matched.length + stubs.length, returned: hits.length, tools: hits };
}

// ── ops_get_tool ─────────────────────────────────────────────────────────

/** 名字已被插件声明、但尚未进入 live catalog（桥不健康 / 未 sync）时的结构化错误。 */
export interface NotInLiveCatalogError {
  error: 'NOT_IN_LIVE_CATALOG';
  message: string;
  pluginId: string;
  healthy: boolean;
  next: { tool: 'ops_select_tools'; args: { pluginIds: string[]; mode: 'add' } };
}

export type GetToolResult =
  | AgentToolDescriptor
  | NotInLiveCatalogError
  | { error: 'NOT_FOUND'; message: string };

export function getTool(hub: DiscoveryHub, name: string): GetToolResult {
  const tool = hub.listAllTools().find((t) => t.name === name);
  if (tool) {
    return tool;
  }
  const provider = hub.getProviders().providers.find((p) => p.toolNames.includes(name));
  if (provider) {
    return {
      error: 'NOT_IN_LIVE_CATALOG',
      message:
        `工具 "${name}" 已由插件 ${provider.pluginId}（healthy=${provider.healthy}）声明，但尚未进入 live catalog。` +
        `立刻 ops_select_tools {"pluginIds":["${provider.pluginId}"],"mode":"add"}，不要再对该名字 ops_get_tool / ops_search_tools；` +
        `若 select 后 exposed 仍为空，说明桥未就绪，请直接告知用户。`,
      pluginId: provider.pluginId,
      healthy: provider.healthy,
      next: { tool: 'ops_select_tools', args: { pluginIds: [provider.pluginId], mode: 'add' } }
    };
  }
  return {
    error: 'NOT_FOUND',
    message: `未找到工具 "${name}"（live catalog 与插件声明清单均无）。用 ops_search_tools 按关键词搜索，或 ops_list_providers 查看可用插件。`
  };
}

// ── ops_list_providers ───────────────────────────────────────────────────

/**
 * 包装 hub.getProviders()：附加 catalogLiveToolCount 与每插件 liveToolCount。
 * live catalog 为空但有声明工具时附顶层 hint，指示模型直接 select、禁止发现空转。
 */
export function listProviders(hub: DiscoveryHub): ListProvidersResult {
  const base = hub.getProviders();
  const liveTools = hub.listAllTools();
  const liveNames = new Set(liveTools.map((t) => t.name));
  const providers = base.providers.map((p) => ({
    ...p,
    liveToolCount: p.toolNames.filter((n) => liveNames.has(n)).length
  }));
  const declaredIds = providers.filter((p) => p.toolNames.length > 0).map((p) => p.pluginId);
  const hint =
    liveTools.length === 0 && declaredIds.length > 0
      ? `live catalog 为空，但插件已声明工具。不要用 ops_get_tool / ops_search_tools 空转；` +
        `立刻 ops_select_tools {"pluginIds":${JSON.stringify(declaredIds)}}；` +
        `若 select 后 exposed 仍为空，说明桥未就绪，请直接告知用户，停止发现循环。`
      : undefined;
  return {
    ...base,
    providers,
    catalogLiveToolCount: liveTools.length,
    ...(hint !== undefined ? { hint } : {})
  };
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
      '按关键词搜索 live catalog 工具（匹配 name/title/description，不区分大小写），' +
      `返回 ${DESCRIPTION_PREVIEW_LIMIT} 字符描述预览。可用 pluginId 限定插件范围。` +
      'live 未命中时回退到插件声明清单（live:false stub）。' +
      'ops_list_providers 已声明的工具名应立刻 ops_select_tools，禁止对声明名反复 search。',
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
    description:
      '按名称取单个工具的完整 descriptor（含 inputSchema、risk、pluginId）。只用于 live catalog 中、参数不清楚的工具。' +
      '若名字只出现在 ops_list_providers 的 toolNames（声明未 live），应立刻 ops_select_tools，禁止对声明名循环 get_tool / search。',
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
