/**
 * Playbook / orchestrator 服务：
 * - playbook yaml 目录缓存与 orchestrator 懒创建；
 * - 阶段驱动：用户显式 /playbook 或主代理 ops_start_playbook 后，
 *   首条用户消息 triage → selecting → investigating；阶段迁移时整体替换 L4。
 *   host **不会**用 NL 关键词自动启动 playbook；
 * - guidedManual：进入相关阶段时引导用户走插件命令/面板（Agent 不发明写工具）；
 * - orchestrator 事件 → host-protocol 事件；
 * - P2 会话并行：run / selectCount / L4 注入状态全部按 sessionId 分席。
 */
import * as vscode from 'vscode';
import type { Playbook } from '../../core';
import { clearHubSelection } from '../../hub-host';
import type {
  OrchestratorEventLike,
  OrchestratorLike,
  PlaybookMeta,
  PlaybookRunLike
} from '../hostTypes';
import { describeError, type HostContext } from './context';
import { GuidedManualFlow } from './guidedManualFlow';
import { ensureVisibleInspectionReport } from './inspectionSummary';
import { StageLayerInjector } from './stageLayers';

/** ops_advance_stage 未显式给目标阶段时的默认推进（合法迁移表的主线）。 */
const DEFAULT_NEXT_STAGE: Readonly<Record<string, string>> = {
  triage: 'selecting',
  selecting: 'investigating',
  investigating: 'synthesizing',
  synthesizing: 'reporting',
  executing: 'verifying',
  verifying: 'reporting',
  guidedManual: 'verifying',
  reporting: 'closed',
  escalated: 'closed'
};

export class PlaybookService {
  private orchestrator: OrchestratorLike | undefined;
  private orchestratorCreation: Promise<OrchestratorLike> | undefined;
  private playbookCache: Playbook[] | undefined;

  /** sessionId → 当前 playbook run（阶段驱动 / guidedManual/complete 的落点）。 */
  private readonly runs = new Map<string, PlaybookRunLike>();
  /** runId → sessionId（orchestrator 事件路由回所属会话）。 */
  private readonly runSessions = new Map<string, string>();
  /** sessionId → 本任务内 select 次数（policy selectCountThisTask）。 */
  private readonly selectCounts = new Map<string, number>();
  /** L4 阶段层注入（按会话席位独立）。 */
  private readonly layers: StageLayerInjector;
  /** guidedManual 流程（open / complete / 阶段提示）。 */
  readonly guided: GuidedManualFlow;

  constructor(private readonly ctx: HostContext) {
    this.layers = new StageLayerInjector(ctx, () => this.getPlaybooks());
    this.guided = new GuidedManualFlow(ctx, this);
  }

  // ── 目录 ────────────────────────────────────────────────────────────────

  async getPlaybooks(): Promise<PlaybookMeta[]> {
    return this.loadPlaybookCache();
  }

  /** 已加载的缓存（hydrate 快照消费；未加载时返回 undefined 并后台预热）。 */
  cachedPlaybooks(): Playbook[] | undefined {
    return this.playbookCache;
  }

  private async loadPlaybookCache(): Promise<Playbook[]> {
    if (this.playbookCache) return this.playbookCache;
    try {
      this.playbookCache = this.ctx.core.loadPlaybooks(this.ctx.playbooksDir);
    } catch (err) {
      this.ctx.log(`[orchestrator] loadPlaybooks 失败: ${describeError(err)}`);
      this.playbookCache = [];
    }
    return this.playbookCache;
  }

  /** ops_list_playbooks 的目录形态（id/title/description/whenToUse）。 */
  async listPlaybookCatalog(): Promise<
    Array<{ id: string; title: string; description?: string; whenToUse?: string[] }>
  > {
    const playbooks = await this.getPlaybooks();
    return playbooks.map((pb) => {
      const whenToUse = (pb.triggers ?? [])
        .filter((t) => t.kind === 'nl')
        .flatMap((t) => t.patterns ?? [])
        .filter((p) => p.trim().length > 0);
      return {
        id: pb.id,
        title: pb.title ?? pb.id,
        ...(typeof pb.description === 'string' ? { description: pb.description } : {}),
        ...(whenToUse.length > 0 ? { whenToUse } : {})
      };
    });
  }

  // ── orchestrator 懒创建 ─────────────────────────────────────────────────

  async ensureOrchestrator(): Promise<OrchestratorLike> {
    if (this.orchestrator) return this.orchestrator;
    if (!this.orchestratorCreation) {
      this.orchestratorCreation = this.createOrchestrator().finally(() => {
        this.orchestratorCreation = undefined;
      });
    }
    return this.orchestratorCreation;
  }

  private async createOrchestrator(): Promise<OrchestratorLike> {
    const playbooks = await this.loadPlaybookCache();
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const orchestrator: OrchestratorLike = this.ctx.core.createOrchestrator({
      playbooks,
      maxParallel: config.get<number>('subagent.maxParallel', 3),
      onEvent: (e: OrchestratorEventLike) => this.onOrchestratorEvent(e)
    });
    this.ctx.log(`[orchestrator] createOrchestrator 完成（${playbooks.length} 条 playbook）`);
    this.orchestrator = orchestrator;
    return orchestrator;
  }

  // ── 会话态访问（ApprovalService / ChatService 消费） ───────────────────

  runOf(sessionId: string): PlaybookRunLike | undefined {
    return this.runs.get(sessionId);
  }

  selectCount(sessionId: string): number {
    return this.selectCounts.get(sessionId) ?? 0;
  }

  bumpSelectCount(sessionId: string): void {
    this.selectCounts.set(sessionId, this.selectCount(sessionId) + 1);
  }

  abortSubagentInOrchestrator(taskId: string): void {
    try {
      this.orchestrator?.abortSubagent?.(taskId);
    } catch (err) {
      this.ctx.log(`[orchestrator] abortSubagent 失败: ${describeError(err)}`);
    }
  }

  /** 会话被驱逐出席位：清空该会话的 playbook 运行态。 */
  clearSession(sessionId: string): void {
    const run = this.runs.get(sessionId);
    this.runs.delete(sessionId);
    if (run) this.runSessions.delete(run.id);
    this.selectCounts.delete(sessionId);
    this.layers.clearSession(sessionId);
  }

  // ── 启动 / 推进 / 收尾 ──────────────────────────────────────────────────

  async startPlaybook(
    playbookId: string,
    opts?: { advance?: boolean },
    sessionId?: string
  ): Promise<{ ok: boolean; stage?: string; error?: string }> {
    const ctx = this.ctx;
    const sid = sessionId ?? ctx.store.activeSessionId;
    if (typeof playbookId !== 'string' || playbookId.length === 0) {
      return { ok: false, error: 'playbookId 不能为空' };
    }
    const existing = this.runs.get(sid);
    if (opts?.advance && existing) {
      return {
        ok: false,
        error: `已有进行中的 playbook ${existing.playbookId}，不要叠加启动`
      };
    }
    const orchestrator = await this.ensureOrchestrator();
    let run: PlaybookRunLike;
    try {
      run = orchestrator.startPlaybook(playbookId, sid);
    } catch (err) {
      ctx.log(`[orchestrator] startPlaybook 失败: ${describeError(err)}`);
      return { ok: false, error: describeError(err) };
    }
    this.selectCounts.set(sid, 0);
    this.runs.set(sid, run);
    this.runSessions.set(run.id, sid);
    // playbook/stage 事件已在 startPlaybook 内同步发出（store 已更新）。
    // 真编排从 triage 起步，select 在首条用户消息推进到 selecting 时代发。
    const desiredSelect = orchestrator.desiredSelect?.(run);
    if (desiredSelect) {
      try {
        await ctx.hub.selection.select(desiredSelect);
        this.bumpSelectCount(sid);
        orchestrator.recordSelect?.(run);
      } catch (err) {
        ctx.log(`[hub] playbook select 失败: ${describeError(err)}`);
      }
    }
    const stage = ctx.store.playbookOf(sid)?.stage ?? run.stage;
    if (ctx.store.playbookOf(sid)?.id !== playbookId) {
      // 编排器未发事件（异常路径）时兜底更新。
      ctx.store.setPlaybook({ id: playbookId, stage: run.stage }, sid);
      ctx.broadcastToSession(sid, 'playbook/stage', { playbookId, stage: run.stage });
    }
    // 主代理在对话中途启动链路时立即推进阶段并注入 L4；UI 手动选择仍等下一条消息。
    if (opts?.advance) {
      await this.advancePlaybookForPrompt(sid);
    }
    return { ok: true, stage: ctx.store.playbookOf(sid)?.stage ?? stage };
  }

  /** ops_advance_stage / playbook/advance：显式推进阶段（缺省走主线迁移）。 */
  async advancePlaybook(
    stage?: string,
    sessionId?: string
  ): Promise<{ ok: boolean; stage?: string; error?: string }> {
    const sid = sessionId ?? this.ctx.store.activeSessionId;
    const run = this.runs.get(sid);
    if (!run) return { ok: false, error: '没有进行中的 playbook run' };
    await this.ensureOrchestrator();
    const current = this.currentStage(run, sid);
    const target = typeof stage === 'string' && stage.length > 0 ? stage : DEFAULT_NEXT_STAGE[current];
    if (target === undefined) {
      return { ok: false, stage: current, error: `阶段 ${current} 没有默认下一步，请显式指定目标阶段` };
    }
    const next = this.tryAdvance(run, target);
    if (next === undefined) {
      return { ok: false, stage: current, error: `无法从 ${current} 迁移到 ${target}` };
    }
    return { ok: true, stage: next };
  }

  /** ops_close_playbook / playbook/close：收尾到 closed 并解除该席 run。 */
  async closePlaybook(sessionId?: string): Promise<{ ok: boolean; stage?: string; error?: string }> {
    const sid = sessionId ?? this.ctx.store.activeSessionId;
    const run = this.runs.get(sid);
    if (!run) return { ok: false, error: '没有进行中的 playbook run' };
    // docs/14 P0-report：模型整轮只调工具就 close 时，先根据工具 preview
    // 合成一份中文巡检结论上屏，再收尾；合成后绝不以此拒绝 close。
    ensureVisibleInspectionReport(this.ctx, sid);
    await this.ensureOrchestrator();
    let stage = this.currentStage(run, sid);
    if (stage !== 'closed') {
      // 主线收尾：非 reporting 时先尽力推进到 reporting，再 closed。
      if (stage !== 'reporting' && stage !== 'escalated') {
        const toReporting = this.tryAdvance(run, 'reporting');
        if (toReporting !== undefined) stage = toReporting;
      }
      const closed = this.tryAdvance(run, 'closed');
      if (closed === undefined) {
        return { ok: false, stage, error: `无法从 ${stage} 收尾到 closed` };
      }
      stage = closed;
    }
    this.runs.delete(sid);
    this.runSessions.delete(run.id);
    this.selectCounts.set(sid, 0);
    // Plan 01 T4: clear Hub selection only on the successful closed path.
    // Failure branches above return without touching selection (investigating
    // close that cannot advance stays selected; Plan 03 owns tryAdvance).
    await clearHubSelection(this.ctx.hub, (m) => this.ctx.log(m), 'playbook-closed');
    return { ok: true, stage };
  }

  /**
   * playbook/escalate-select：把当前阶段 yaml 的 escalateSelect（mode=add）
   * 应用到 hub.selection。首轮 investigating 之后 host 绝不自动调用——
   * 扩面由用户/模型显式请求驱动。
   */
  async applyEscalateSelect(sessionId?: string): Promise<{ ok: boolean; reason?: string }> {
    const ctx = this.ctx;
    const sid = sessionId ?? ctx.store.activeSessionId;
    const run = this.runs.get(sid);
    if (!run) return { ok: false, reason: '没有进行中的 playbook run' };
    const orchestrator = await this.ensureOrchestrator();
    let desired = orchestrator.desiredEscalateSelect?.(run);
    if (!desired) {
      // orchestrator 未实现时退回 playbook 元数据（同一 yaml 真源）。
      const playbookId = ctx.store.playbookOf(sid)?.id ?? run.playbookId;
      const stage = this.currentStage(run, sid);
      const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
      desired = meta?.stages?.find((s) => s.id === stage)?.escalateSelect;
    }
    if (!desired) return { ok: false, reason: '当前阶段没有 escalateSelect 定义' };
    try {
      await ctx.hub.selection.select({ ...desired, mode: 'add' });
      this.bumpSelectCount(sid);
      orchestrator.recordSelect?.(run);
      ctx.log(
        `[hub] escalateSelect 已应用（${(desired.pluginIds ?? desired.names ?? []).join(', ')}）`
      );
      return { ok: true };
    } catch (err) {
      ctx.log(`[hub] escalateSelect 失败: ${describeError(err)}`);
      return { ok: false, reason: describeError(err) };
    }
  }

  // ── 阶段驱动 ────────────────────────────────────────────────────────────

  /**
   * 首条用户消息驱动 playbook 前进：triage → selecting（代发 select）→
   * investigating。迁移失败只记日志不打断对话（合法迁移表由
   * src/orchestrator/engine.ts assertTransition 把关）。
   */
  async advancePlaybookForPrompt(sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    const orchestrator = this.orchestrator;
    if (!run || !orchestrator?.advanceTo) return;
    let stage = this.currentStage(run, sessionId);
    if (stage === 'triage') {
      const next = this.tryAdvance(run, 'selecting');
      if (next) {
        stage = next;
        await this.applyStageSelect(orchestrator, run, sessionId);
      }
    }
    if (stage === 'selecting') {
      stage = this.tryAdvance(run, 'investigating') ?? stage;
    }
    // 阶段事件里也会注入 L4；这里 await 保证首次模型调用前已生效
    // （并覆盖 runtime 重建后无阶段迁移的场景）。
    await this.layers.inject(
      sessionId,
      this.ctx.store.playbookOf(sessionId)?.id ?? run.playbookId,
      stage
    );
  }

  currentStage(run: PlaybookRunLike, sessionId?: string): string {
    return (
      this.orchestrator?.getRun?.(run.id)?.stage ??
      this.ctx.store.playbookOf(sessionId)?.stage ??
      run.stage
    );
  }

  /** advanceTo 包一层：成功返回新阶段，失败（非法迁移等）记日志返回 undefined。 */
  tryAdvance(run: PlaybookRunLike, stage: string): string | undefined {
    try {
      const updated = this.orchestrator?.advanceTo?.(run, stage);
      return updated ? updated.stage : undefined;
    } catch (err) {
      this.ctx.log(`[orchestrator] advanceTo(${stage}) 失败: ${describeError(err)}`);
      return undefined;
    }
  }

  /** 当前阶段的 yaml select 由 orchestrator 代发（不让模型随意选面）。 */
  private async applyStageSelect(
    orchestrator: OrchestratorLike,
    run: PlaybookRunLike,
    sessionId: string
  ): Promise<void> {
    const desired = orchestrator.desiredSelect?.(run);
    if (!desired) return;
    try {
      await this.ctx.hub.selection.select(desired);
      this.bumpSelectCount(sessionId);
      orchestrator.recordSelect?.(run);
    } catch (err) {
      this.ctx.log(`[hub] playbook select 失败: ${describeError(err)}`);
    }
  }

  /** guidedManual/complete 需要知道 orchestrator 是否可推进阶段。 */
  canAdvance(): boolean {
    return typeof this.orchestrator?.advanceTo === 'function';
  }

  /** 阶段进入钩子：注入 L4、guidedManual 提示。子代理由主代理 ops_dispatch_subagent 派发，绝不在此自动下发。 */
  private handleStageEntered(
    sessionId: string,
    runId: string,
    playbookId: string,
    stage: string
  ): void {
    void this.layers.inject(sessionId, playbookId, stage);
    void this.guided.maybeEmitNotice(sessionId, runId, playbookId, stage).catch((err) =>
      this.ctx.log(`[guidedManual] 提示失败: ${describeError(err)}`)
    );
  }

  // ── orchestrator 事件 → host-protocol ─────────────────────────────────

  private onOrchestratorEvent(e: OrchestratorEventLike): void {
    const ctx = this.ctx;
    switch (e.type) {
      case 'playbook/stage': {
        const sid = this.runSessions.get(e.runId) ?? ctx.store.activeSessionId;
        ctx.store.setPlaybook({ id: e.playbookId, stage: e.stage }, sid);
        ctx.broadcastToSession(sid, 'playbook/stage', { playbookId: e.playbookId, stage: e.stage });
        ctx.store.appendTimeline(
          {
            kind: 'playbook_stage',
            playbookId: e.playbookId,
            from: e.from,
            stage: e.stage
          },
          sid
        );
        this.handleStageEntered(sid, e.runId, e.playbookId, e.stage);
        break;
      }
      case 'subagent/upsert': {
        const sid = this.runSessions.get(e.runId) ?? ctx.store.activeSessionId;
        ctx.store.upsertSubagent(e.card, sid);
        ctx.broadcastToSession(sid, 'subagent/upsert', e.card);
        break;
      }
      case 'approval/request': {
        const sid = this.runSessions.get(e.runId) ?? ctx.store.activeSessionId;
        ctx.approvals.registerBrief(e.brief, sid);
        break;
      }
      case 'approval/resolved': {
        ctx.approvals.handleResolvedEvent(e.briefId, e.decision);
        break;
      }
      default:
        break;
    }
  }

  dispose(): void {
    this.orchestrator?.dispose?.();
    this.orchestrator = undefined;
  }
}
