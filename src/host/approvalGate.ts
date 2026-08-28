/**
 * 审批闭环的纯函数装配件（不 import vscode，可直接单测）。
 *
 * buildApprovalCommandSet 与 src/policy/index.ts 的 deriveCommandSetHash
 * 推导保持一致：简报的 commandSetSha256 必须等于「批准后模型重试同一工具
 * 调用时」policy 从入参推导出的哈希，否则令牌永远命中 OPS_APPROVAL_STALE。
 */

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * 工具入参 → 简报命令集：
 * - args.commands 是数组 → 原样作为命令集（policy 侧 hashCommandSet(args.commands)）；
 * - 单条 command / sql / query 字符串 → [single]（policy 侧 hashCommandSet([single])）；
 * - 其余结构化入参 → { tool, args }（policy 侧推导不出哈希，跳过一致性比对，
 *   但令牌仍与该确切调用的哈希绑定）。
 */
export function buildApprovalCommandSet(
  toolName: string,
  args: Record<string, unknown>
): unknown {
  if (Array.isArray(args.commands)) return args.commands;
  const single = firstString(args.command, args.sql, args.query);
  if (single !== undefined) return [single];
  return { tool: toolName, args };
}

export const APPROVAL_ELEMENT_KEYS = [
  'goal',
  'evidence',
  'impact',
  'prechecks',
  'backup',
  'commands',
  'successCriteria',
  'rollback',
  'unknowns'
] as const;

const COMMANDS_PREVIEW_MAX = 2000;

function previewJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length > COMMANDS_PREVIEW_MAX) {
    return `${text.slice(0, COMMANDS_PREVIEW_MAX)}…（已截断）`;
  }
  return text;
}

/**
 * 由被拒工具调用尽力装配 9 要素简报文案（goal/evidence/impact/prechecks/
 * backup/commands/successCriteria/rollback/unknowns）。不替代人工判断：
 * unknowns 明示这是自动装配，插件确认弹窗（第三道闸）仍独立生效。
 */
export function buildApprovalElements(input: {
  toolName: string;
  args: Record<string, unknown>;
  risk: 'write' | 'exec';
  commandSet: unknown;
  pluginId?: string;
  stage?: string;
}): Record<string, string> {
  const target =
    input.pluginId !== undefined ? `${input.pluginId} 的 ${input.toolName}` : input.toolName;
  const riskLabel = input.risk === 'exec' ? '命令执行（exec）' : '写操作（write）';
  const stageNote = input.stage !== undefined ? `当前 playbook 阶段 ${input.stage}；` : '';
  return {
    goal: `执行${riskLabel}：${target}`,
    evidence: `${stageNote}模型在会话内请求调用 ${input.toolName}，调查证据见上方对话与证据便签。`,
    impact: `将通过 ${target} 对目标系统产生${
      input.risk === 'exec' ? '命令级' : '数据/配置写入'
    }影响，确切影响面以下方命令集为准。`,
    prechecks: '请人工核对命令集中的目标（实例/库表/主机/配置项）与预期一致后再批准。',
    backup: '涉及数据或配置变更时，请确认已有备份或可用回滚点；无法确认请先拒绝。',
    commands: previewJson(input.commandSet),
    successCriteria: '工具返回成功，且读回/监控验证结果符合预期。',
    rollback: '如结果异常，按回滚指引撤销本次变更；无回滚手段时请勿批准。',
    unknowns:
      '本简报由被拦截的工具调用自动装配，参数未经人工整理；批准仅放行该确切命令集，插件确认弹窗仍会独立生效。'
  };
}
