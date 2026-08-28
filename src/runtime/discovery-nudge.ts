/**
 * 发现空转软顶（docs/13 §4.4，DeepSeek harness 式 advisory nudge）。
 *
 * 主会话对 ops_search_tools / ops_get_tool：同一工具 + 规范化参数
 * 连续 ≥2 次空结果时，在工具结果 JSON 上附加 `nudge` 字段提醒模型
 * 停止发现循环。纯函数 + 显式 state（state 由 createOpsRuntime 闭包
 * 持有，随 runtime 生命周期，绝不全局）；只附加字段、不改写原结果、
 * 不 block 调用。
 */

export const NUDGED_DISCOVERY_TOOLS: readonly string[] = ['ops_search_tools', 'ops_get_tool'];

/** 连续空结果达到该次数（含）起，附加 nudge。 */
export const DISCOVERY_NUDGE_THRESHOLD = 2;

export const DISCOVERY_NUDGE_TEXT =
  '停止 search/get_tool 空转：对 ops_list_providers 返回的 pluginIds 调用 ' +
  'ops_select_tools（如 {"pluginIds":["at.terminal"]}），select 后直接使用一等工具名；' +
  '若插件 healthy:false，请用中文告知用户桥未就绪，不要换关键词重搜。';

export interface DiscoveryNudgeState {
  /** 最近一次空结果的 toolName+argsKey；换 key 或出现非空结果都会重置计数。 */
  lastEmptyKey?: string;
  /** 同一 key 的连续空结果次数。 */
  consecutiveEmpties: number;
}

export function createDiscoveryNudgeState(): DiscoveryNudgeState {
  return { consecutiveEmpties: 0 };
}

/** 值的稳定序列化：对象键排序、忽略 undefined，同义参数得到同一 key。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 参数规范化 key（键顺序无关）。 */
export function canonicalArgsKey(args: Record<string, unknown>): string {
  return stableStringify(args);
}

/**
 * 登记一次发现调用的结果。
 * - 非空结果：重置计数，返回 undefined；
 * - 空结果但 toolName+argsKey 与上次不同：计数从 1 重新起步，返回 undefined；
 * - 同一 toolName+argsKey 连续第 ≥DISCOVERY_NUDGE_THRESHOLD 次空结果：返回 nudge 文案。
 */
export function recordDiscoveryOutcome(
  state: DiscoveryNudgeState,
  toolName: string,
  argsKey: string,
  empty: boolean
): string | undefined {
  if (!empty) {
    delete state.lastEmptyKey;
    state.consecutiveEmpties = 0;
    return undefined;
  }
  const key = `${toolName}\u0000${argsKey}`;
  state.consecutiveEmpties = state.lastEmptyKey === key ? state.consecutiveEmpties + 1 : 1;
  state.lastEmptyKey = key;
  return state.consecutiveEmpties >= DISCOVERY_NUDGE_THRESHOLD ? DISCOVERY_NUDGE_TEXT : undefined;
}

/**
 * 空结果判定：
 * - ops_search_tools：total === 0；
 * - ops_get_tool：error 为 NOT_FOUND 或 NOT_IN_LIVE_CATALOG
 *   （后者由发现层重设计分支引入，这里前向兼容）。
 */
export function isEmptyDiscoveryResult(toolName: string, parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') return false;
  const record = parsed as Record<string, unknown>;
  if (toolName === 'ops_search_tools') return record.total === 0;
  if (toolName === 'ops_get_tool') {
    return record.error === 'NOT_FOUND' || record.error === 'NOT_IN_LIVE_CATALOG';
  }
  return false;
}

/**
 * runtime 包装入口：对发现工具的结果 JSON 按需附加 `nudge` 字段。
 * 非发现工具、JSON 解析失败、结果不是对象时原样返回（绝不破坏结果）。
 */
export function applyDiscoveryNudge(
  state: DiscoveryNudgeState,
  toolName: string,
  args: Record<string, unknown>,
  resultJson: string
): string {
  if (!NUDGED_DISCOVERY_TOOLS.includes(toolName)) return resultJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return resultJson;
  }
  const empty = isEmptyDiscoveryResult(toolName, parsed);
  const nudge = recordDiscoveryOutcome(state, toolName, canonicalArgsKey(args), empty);
  if (nudge === undefined) return resultJson;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return resultJson;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), nudge });
}
