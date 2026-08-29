/**
 * GuidedManual（引导式人工操作）提示文案。
 *
 * Jenkins 触发构建、Nacos 发布配置等动作在 MCP 面没有写工具（凭据与
 * 二次确认留在能力插件内），Agent 不发明写工具——进入 guidedManual
 * （或相关 playbook 的 synthesizing）时向 transcript 发一条固定提示，
 * 引导用户走插件自身的命令 / 面板；完成后经 guidedManual/complete 续链路。
 */
import type { PlaybookMeta } from './hostTypes';
import type { NoticeAction } from '../protocol';

interface GuidedHint {
  command: string;
  hint: string;
}

/** 已知需要人工步骤的 playbook → 默认命令与提示（yaml 里的 guidedManual 优先）。 */
const DEFAULT_HINTS: Record<string, GuidedHint> = {
  'pb.release': {
    command: 'atJenkins.triggerBuild',
    hint: 'MCP 不能触发构建。请在 AT Jenkins 面板确认后手动触发/停止构建。'
  },
  'pb.config-change': {
    command: 'atNacos.publishConfig',
    hint: '发布、删除、回滚配置请在 AT Nacos 配置 diff 界面确认后完成。'
  }
};

export const GUIDED_MANUAL_PLAYBOOKS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_HINTS));

/** notice 双按钮：打开插件 / 我已在 UI 完成（不靠用户打「已完成」）。 */
export const GUIDED_MANUAL_NOTICE_ACTIONS: NoticeAction[] = [
  { id: 'gm-open', label: '打开对应插件', request: 'guidedManual/open' },
  { id: 'gm-complete', label: '我已在 UI 完成', request: 'guidedManual/complete' }
];

/** 该 playbook 是否含人工步骤（yaml 有 guidedManual 阶段，或在已知清单里）。 */
export function hasGuidedManualStep(playbookId: string, meta: PlaybookMeta | undefined): boolean {
  if (GUIDED_MANUAL_PLAYBOOKS.has(playbookId)) return true;
  return meta?.stages?.some((s) => s.id === 'guidedManual') === true;
}

/** 该 playbook 人工步骤对应的 VS Code 命令（yaml 优先，其次已知默认）。 */
export function guidedManualCommand(
  playbookId: string,
  meta: PlaybookMeta | undefined
): string | undefined {
  return (
    meta?.stages?.find((s) => s.id === 'guidedManual')?.guidedManual?.command ??
    DEFAULT_HINTS[playbookId]?.command
  );
}

/** 组装人工操作提示；playbook 无 guidedManual 信息且不在已知清单时返回 undefined。 */
export function buildGuidedManualNotice(
  playbookId: string,
  meta: PlaybookMeta | undefined
): string | undefined {
  const stageDef = meta?.stages?.find((s) => s.id === 'guidedManual');
  const fallback = DEFAULT_HINTS[playbookId];
  const command = stageDef?.guidedManual?.command ?? fallback?.command;
  const hint = stageDef?.guidedManual?.hint ?? fallback?.hint;
  if (!command && !hint) return undefined;
  const lines = ['【引导式人工操作】该步骤需要你在插件侧完成（MCP 无写权限）：'];
  if (hint) lines.push(`- ${hint}`);
  if (command) {
    lines.push(`- 推荐命令：\`${command}\`（命令面板运行，或打开对应 AT 插件面板）。`);
  }
  lines.push('- 完成后点下方按钮，链路将推进到验证 / 报告阶段。');
  return lines.join('\n');
}
