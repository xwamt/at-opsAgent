/**
 * guidedManual 流程（PlaybookService 拆件）：
 * Jenkins 触发构建 / Nacos 发布配置等写动作走插件命令与面板，
 * Agent 不发明 MCP 写工具（ADR / docs/07）。
 * - 进入 guidedManual（或含人工步骤 playbook 的 synthesizing）时发一条
 *   引导提示，每个 run 只提示一次；
 * - guidedManual/open：运行插件侧命令，凭据留在插件内；
 * - guidedManual/complete：人工步骤完成后按迁移表推进。
 */
import * as vscode from 'vscode';
import { buildGuidedManualNotice, guidedManualCommand, hasGuidedManualStep } from '../guidedManual';
import { describeError, type HostContext } from './context';
import type { PlaybookService } from './playbookService';

export class GuidedManualFlow {
  /** 已发过 guidedManual 提示的 runId（每个 run 只提示一次）。 */
  private readonly noticedRuns = new Set<string>();

  constructor(
    private readonly ctx: HostContext,
    private readonly playbooks: PlaybookService
  ) {}

  /** 阶段进入钩子（PlaybookService.handleStageEntered 调用）。 */
  async maybeEmitNotice(
    sessionId: string,
    runId: string,
    playbookId: string,
    stage: string
  ): Promise<void> {
    if (this.noticedRuns.has(runId)) return;
    const meta = (await this.playbooks.getPlaybooks()).find((p) => p.id === playbookId);
    const relevant =
      stage === 'guidedManual' ||
      (stage === 'synthesizing' && hasGuidedManualStep(playbookId, meta));
    if (!relevant) return;
    const notice = buildGuidedManualNotice(playbookId, meta);
    if (!notice) return;
    this.noticedRuns.add(runId);
    this.ctx.emitAssistantNotice(notice, sessionId);
  }

  /**
   * guidedManual/open：运行插件侧命令（如 atJenkins.triggerBuild），
   * 写动作与凭据留在插件内。简报 elements.guidedManual 优先，
   * 其次当前 playbook 的 yaml / 已知默认命令。
   */
  async open(briefId?: string): Promise<{ ok: boolean }> {
    const ctx = this.ctx;
    let command: string | undefined;
    if (briefId) {
      const gm = ctx.store.pendingBriefs.find((b) => b.id === briefId)?.elements?.guidedManual;
      if (typeof gm === 'string') command = gm;
      else if (gm && typeof gm === 'object' && typeof (gm as { command?: unknown }).command === 'string') {
        command = (gm as { command: string }).command;
      }
    }
    const playbookId = ctx.store.playbook?.id;
    if (!command && playbookId) {
      const meta = (await this.playbooks.getPlaybooks()).find((p) => p.id === playbookId);
      command = guidedManualCommand(playbookId, meta);
    }
    if (!command) return { ok: false };
    const commandId = command.startsWith('command:') ? command.slice('command:'.length) : command;
    try {
      await vscode.commands.executeCommand(commandId);
      return { ok: true };
    } catch (err) {
      ctx.log(`[guidedManual] 命令 ${commandId} 执行失败: ${describeError(err)}`);
      ctx.emitAssistantNotice(
        `无法运行命令 \`${commandId}\`（对应 AT 插件可能未安装）。请打开对应插件面板手动完成操作。`
      );
      return { ok: false };
    }
  }

  /** guidedManual/complete：人工步骤完成，按迁移表推向 verifying / reporting。 */
  async complete(briefId?: string): Promise<{ ok: boolean; stage?: string }> {
    const ctx = this.ctx;
    const sid = ctx.store.activeSessionId;
    // guided 简报是引导卡片而非 write/exec 审批：只清视图，不走 applyApproval 发 token。
    if (typeof briefId === 'string' && ctx.store.resolveBrief(briefId)) {
      ctx.broadcast('approval/resolve', { briefId, decision: 'approved' });
      ctx.store.appendTimeline({ kind: 'guided_manual', briefId, status: 'completed' });
    }
    const run = this.playbooks.runOf(sid);
    if (!run || !this.playbooks.canAdvance()) return { ok: false };
    for (const next of ['verifying', 'reporting']) {
      const stage = this.playbooks.tryAdvance(run, next);
      if (stage) return { ok: true, stage };
    }
    return { ok: false, stage: this.playbooks.currentStage(run, sid) };
  }
}
