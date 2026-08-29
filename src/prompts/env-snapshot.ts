/**
 * L-env 环境现场层（docs/13 §4.2，Claude 式 gather-context）。
 *
 * host 在每条用户 prompt 前把 Hub 现场（声明清单 vs live catalog、健康度、
 * 暴露集）合成本层并经 composeSystemPrompt({ envLayer }) 注入——模型开口前
 * 就知道有哪些插件/工具，不必用元工具把世界从零发现一遍。
 *
 * 关键差异表达：live catalog 为空但插件已**声明**工具时，明确指示
 * 「立刻 ops_select_tools，禁止 ops_get_tool / ops_search_tools 空转；
 * select 后 exposed 仍空则告知用户桥未就绪」。
 */

export interface EnvSnapshotProvider {
  pluginId: string;
  displayName?: string;
  healthy: boolean;
  bridgeCount: number;
  connectedTargets?: number;
  /** 插件 manifest 声明的工具名（与桥是否 healthy 无关）。 */
  toolNames: string[];
  /** live catalog（健康桥 MCP listTools）里属于该插件的工具数。 */
  liveToolCount?: number;
}

export interface EnvSnapshotInput {
  hostApp: string;
  /** live catalog 工具总数（hub.listAllTools().length）。 */
  catalogLiveToolCount: number;
  /** 当前暴露集（hub.listExposedTools() 的工具名）。 */
  exposed: string[];
  providers: EnvSnapshotProvider[];
  /** 发现层 listProviders 的顶层行动指引（有则原样带给模型）。 */
  hint?: string;
  /**
   * 用户确认的环境别名（memory/environment.json）。有键时追加 `aliases:`
   * 最多 15 行；缺席/空对象不提。
   */
  aliases?: Record<string, string>;
}

/** 快照行数软顶（docs/13：控制在 ~40 行内）。 */
export const ENV_SNAPSHOT_MAX_LINES = 40;

/** 每个插件展示的声明工具名上限（超过只列前 N 个并标注总数）。 */
export const DECLARED_NAMES_SHOWN = 8;

/** L-env 尾部 aliases 块行数上限（含 `aliases:` 标题）。 */
export const ENV_ALIAS_MAX_LINES = 15;

/** 合成 L-env 现场层文本。 */
export function formatEnvSnapshot(input: EnvSnapshotInput): string {
  const lines: string[] = [
    '# L-env 现场（host 注入，不必再发现）',
    `hostApp: ${input.hostApp}；live catalog 工具数: ${input.catalogLiveToolCount}`,
    `已暴露工具（exposed）: ${input.exposed.length > 0 ? input.exposed.join(', ') : '无'}`
  ];
  const declaredIds: string[] = [];
  for (const p of input.providers) {
    if (p.toolNames.length > 0) declaredIds.push(p.pluginId);
    const title = p.displayName !== undefined ? `${p.pluginId}（${p.displayName}）` : p.pluginId;
    const facts = [
      `healthy=${p.healthy}`,
      `桥 ${p.bridgeCount} 座`,
      ...(p.connectedTargets !== undefined ? [`connected=${p.connectedTargets}`] : []),
      ...(p.liveToolCount !== undefined ? [`live=${p.liveToolCount}`] : [])
    ];
    lines.push(`- ${title}: ${facts.join('，')}`);
    const shown = p.toolNames.slice(0, DECLARED_NAMES_SHOWN).join(', ');
    const label =
      p.toolNames.length > DECLARED_NAMES_SHOWN
        ? `声明工具（前 ${DECLARED_NAMES_SHOWN} 个，共 ${p.toolNames.length} 个）`
        : '声明工具';
    lines.push(`  ${label}: ${shown.length > 0 ? shown : '无'}`);
  }
  if (input.providers.length === 0) {
    lines.push('- （尚无已接入插件）');
  }
  const hint = input.hint?.trim();
  if (hint !== undefined && hint.length > 0) {
    lines.push(`hint: ${hint}`);
  }
  if (input.catalogLiveToolCount === 0 && declaredIds.length > 0) {
    lines.push(
      `下一步（必须）: 立刻 ops_select_tools {pluginIds:${JSON.stringify(declaredIds)}}；` +
        '禁止 ops_get_tool / ops_search_tools 空转；select 后 exposed 仍空则告知用户桥未就绪' +
        '（healthy=false ≠ 没有这个插件）。'
    );
  }
  const aliases = input.aliases;
  if (aliases !== undefined && Object.keys(aliases).length > 0) {
    const block = formatEnvAliasesBlock(aliases);
    if (block.length > 0) lines.push(block);
  }
  return lines.join('\n');
}

/** `aliases:` 块；无键返回空串。最多 ENV_ALIAS_MAX_LINES 行。 */
export function formatEnvAliasesBlock(aliases: Record<string, string>): string {
  const keys = Object.keys(aliases);
  if (keys.length === 0) return '';
  const lines = ['aliases:'];
  for (const key of keys) {
    if (lines.length >= ENV_ALIAS_MAX_LINES) break;
    lines.push(`- ${key}: ${aliases[key]}`);
  }
  return lines.join('\n');
}
