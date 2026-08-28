/**
 * Host 业务中枢：
 * - 懒创建 runtime（首个 chat/prompt 才碰 LLM 配置，activate 保持廉价）
 * - 懒创建 orchestrator（playbook / 审批首次使用时）
 * - runtime / orchestrator 事件 → host-protocol 事件
 *   （transcript/append|patch、tool/*、thinking/delta、approval/*…）
 * - webview 请求路由（chat/prompt、chat/abort、playbook/start、approval/respond…）
 * - beforeToolCall 权限闸装配（policy.evaluate；orchestrator 侧不重复）
 * - playbook 阶段驱动：首条用户消息 triage → selecting → investigating；
 *   进入 investigating/verifying 时下发子代理；阶段迁移时整体替换 L4；
 *   guidedManual（Jenkins/Nacos 人工步骤）发引导提示，completed 后续链路
 */
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  Emitter,
  envelope,
  type ApprovalBriefView,
  type ApprovalRespondReq,
  type ChatPromptReq,
  type Envelope,
  type Event,
  type HubHost,
  type HydrateEvt,
  type ModelSetReq,
  type SubagentCard,
  type ToolCallView
} from '../protocol';
import { evaluatePolicy } from '../policy';
import { FallbackOrchestrator, loadPlaybooksFallback } from './fallback/fallbackOrchestrator';
import { FallbackRuntime } from './fallback/fallbackRuntime';
import { buildGuidedManualNotice, guidedManualCommand, hasGuidedManualStep } from './guidedManual';
import type {
  ApprovalBriefLike,
  OrchestratorEventLike,
  OrchestratorLike,
  PlaybookMeta,
  PlaybookRunLike,
  RuntimeEventLike,
  RuntimeLike
} from './hostTypes';
import { loadOrchestratorModule, loadRuntimeModule } from './modules';
import { PlaybookLayerSource } from './playbookLayer';
import type { OpsSecrets } from './secrets';
import type { SessionStore } from './sessionStore';

const SELECT_TOOL_NAMES = new Set(['ops_select_tools', 'at_select_tools']);

export interface HostControllerOptions {
  hub: HubHost;
  store: SessionStore;
  secrets: OpsSecrets;
  output: vscode.OutputChannel;
  extensionPath: string;
}

export class HostController {
  readonly hub: HubHost;
  readonly store: SessionStore;
  readonly secrets: OpsSecrets;
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly playbooksDir: string;

  private readonly output: vscode.OutputChannel;
  private readonly extensionPath: string;

  private readonly uiEmitter = new Emitter<Envelope>();
  /** 面向 Chat webview 的事件流（由 ChatViewProvider 合批转发）。 */
  readonly onUiEvent: Event<Envelope> = this.uiEmitter.event;

  private readonly boardEmitter = new Emitter<Envelope>();
  /** 面向 Ops 看板的事件流（timeline/upsert）。 */
  readonly onBoardEvent: Event<Envelope> = this.boardEmitter.event;

  private runtime: RuntimeLike | undefined;
  private runtimeCreation: Promise<RuntimeLike> | undefined;

  private orchestrator: OrchestratorLike | undefined;
  private orchestratorCreation: Promise<OrchestratorLike> | undefined;

  private playbookCache: PlaybookMeta[] | undefined;
  private modelSelection: ModelSetReq | undefined;
  private selectCountThisTask = 0;
  /** briefId → runId（applyApproval 需要 runId 定位 run）。 */
  private readonly briefRuns = new Map<string, string>();
  private readonly hubSub: { dispose(): void };
  private readonly timelineSub: { dispose(): void };

  /** 当前 playbook run（阶段驱动 / guidedManual/complete 的落点）。 */
  private activeRun: PlaybookRunLike | undefined;
  /** 已下发过子代理的 runId:stage，防止重复 spawn。 */
  private readonly spawnedStageKeys = new Set<string>();
  /** 已发过 guidedManual 提示的 runId（每个 run 只提示一次）。 */
  private readonly guidedNoticeRuns = new Set<string>();
  /** 全局停止时需一并中止的在跑子代理。 */
  private readonly activeSubagentTaskIds = new Set<string>();
  private readonly layerSource: PlaybookLayerSource;
  /** L4 注入竞态防护：只应用最后一次请求的层。 */
  private stageLayerSeq = 0;
  private lastLayerKey: string | undefined;
  private lastLayerRuntime: RuntimeLike | undefined;

  constructor(options: HostControllerOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.secrets = options.secrets;
    this.output = options.output;
    this.extensionPath = options.extensionPath;
    this.agentDir = path.join(os.homedir(), '.at-series', 'agent');
    this.modelsPath = path.join(this.agentDir, 'models.json');
    this.playbooksDir = path.join(this.extensionPath, 'skills', 'playbooks');
    this.layerSource = new PlaybookLayerSource(this.playbooksDir);

    this.hubSub = this.hub.onDidChangeTools(() => {
      this.broadcast('capabilities/snapshot', { providers: this.safeProviders() });
    });
    this.timelineSub = this.store.onDidAppendTimeline((event) => {
      this.boardEmitter.fire(envelope('evt', 'timeline/upsert', event, randomUUID()));
    });
  }

  log(message: string): void {
    this.output.appendLine(message);
  }

  // ── 快照 ───────────────────────────────────────────────────────────────

  safeProviders(): unknown {
    try {
      return this.hub.getProviders();
    } catch {
      return { hostApp: this.hub.hostApp, providers: [] };
    }
  }

  snapshot(): HydrateEvt {
    return this.store.snapshot(this.safeProviders());
  }

  // ── webview 请求路由 ───────────────────────────────────────────────────

  async handleRequest(type: string, payload: unknown): Promise<unknown> {
    switch (type) {
      case 'chat/prompt':
        return this.handlePrompt(payload as ChatPromptReq);
      case 'chat/abort':
        this.abort();
        return { ok: true };
      case 'model/set':
        return this.setModel(payload as ModelSetReq);
      case 'playbook/start':
        return this.startPlaybook((payload as { playbookId: string }).playbookId);
      case 'approval/respond':
        return this.applyApproval(payload as ApprovalRespondReq);
      case 'subagent/abort': {
        const taskId = (payload as { taskId?: string }).taskId;
        if (typeof taskId !== 'string' || taskId.length === 0) return { ok: false };
        this.abortSubagentTask(taskId);
        return { ok: true };
      }
      case 'guidedManual/open':
        return this.openGuidedManual((payload as { briefId?: string } | undefined)?.briefId);
      case 'guidedManual/complete':
        return this.completeGuidedManual((payload as { briefId?: string } | undefined)?.briefId);
      case 'log/open':
        return this.openLog((payload as { uri?: string } | undefined)?.uri);
      case 'skill/run':
        return this.runSkill((payload as { name?: string } | undefined)?.name);
      case 'hydrate':
        return this.snapshot();
      default:
        return { ok: false, error: `未知请求类型 ${type}` };
    }
  }

  // ── chat ───────────────────────────────────────────────────────────────

  async handlePrompt(req: ChatPromptReq): Promise<{ accepted: boolean }> {
    let text = typeof req?.text === 'string' ? req.text : '';
    for (const attachment of req?.attachments ?? []) {
      if (attachment.kind === 'alert-paste' && typeof attachment.text === 'string') {
        text += `\n\n[粘贴的告警]\n${attachment.text}`;
      } else if (attachment.kind === 'file' && typeof attachment.uri === 'string') {
        text += `\n\n[附件] ${attachment.uri}`;
      }
    }
    if (text.trim().length === 0) return { accepted: false };
    const userItem = { kind: 'user' as const, id: randomUUID(), text };
    this.store.appendItem(userItem);
    this.broadcast('transcript/append', { item: userItem });
    const runtime = await this.ensureRuntime();
    // playbook 阶段驱动 + 当前阶段 L4 注入在首次模型调用之前完成。
    await this.advancePlaybookForPrompt();
    void runtime.prompt(text, { mode: req.mode }).catch((err) => {
      this.log(`[runtime] prompt 失败: ${describeError(err)}`);
      this.emitAssistantNotice(`⚠ 模型调用失败：${describeError(err)}`);
    });
    return { accepted: true };
  }

  /** 全局停止：主会话 + 所有在跑子代理。 */
  abort(): void {
    for (const taskId of [...this.activeSubagentTaskIds]) {
      this.abortSubagentTask(taskId, { keepMainSession: true });
    }
    try {
      this.runtime?.abort();
    } catch (err) {
      this.log(`[runtime] abort 失败: ${describeError(err)}`);
    }
  }

  async setModel(req: ModelSetReq): Promise<{ ok: boolean }> {
    this.modelSelection = req;
    // 真 runtime 的模型在创建期绑定：丢弃现有实例，下次 prompt 按新模型重建。
    if (this.runtime) {
      this.log(`[runtime] 切换模型 ${req.provider}/${req.model}，重建会话`);
      this.disposeRuntime();
    }
    return { ok: true };
  }

  newSession(): void {
    this.store.newSession();
    this.selectCountThisTask = 0;
    this.briefRuns.clear();
    this.activeRun = undefined;
    this.spawnedStageKeys.clear();
    this.guidedNoticeRuns.clear();
    this.activeSubagentTaskIds.clear();
    this.lastLayerKey = undefined;
    this.lastLayerRuntime = undefined;
    this.disposeRuntime();
    this.broadcast('hydrate', this.snapshot());
  }

  // ── playbook / 审批 ────────────────────────────────────────────────────

  async getPlaybooks(): Promise<PlaybookMeta[]> {
    if (this.playbookCache) return this.playbookCache;
    const mod = await loadOrchestratorModule((m) => this.log(m));
    if (mod) {
      try {
        this.playbookCache = mod.loadPlaybooks(this.playbooksDir);
        return this.playbookCache;
      } catch (err) {
        this.log(`[orchestrator] loadPlaybooks 失败: ${describeError(err)}`);
      }
    }
    this.playbookCache = await loadPlaybooksFallback(this.playbooksDir);
    return this.playbookCache;
  }

  async startPlaybook(playbookId: string): Promise<{ ok: boolean; stage?: string }> {
    if (typeof playbookId !== 'string' || playbookId.length === 0) return { ok: false };
    const orchestrator = await this.ensureOrchestrator();
    let run: PlaybookRunLike;
    try {
      run = orchestrator.startPlaybook(playbookId, this.store.activeSessionId);
    } catch (err) {
      this.log(`[orchestrator] startPlaybook 失败: ${describeError(err)}`);
      return { ok: false };
    }
    this.selectCountThisTask = 0;
    this.activeRun = run;
    // playbook/stage 事件已在 startPlaybook 内同步发出（store 已更新）。
    // 保留启动即 select（fallback 编排直接落在 select 阶段时命中；
    // 真编排从 triage 起步，select 在首条用户消息推进到 selecting 时代发）。
    const desiredSelect = orchestrator.desiredSelect?.(run);
    if (desiredSelect) {
      try {
        await this.hub.selection.select(desiredSelect);
        this.selectCountThisTask += 1;
        orchestrator.recordSelect?.(run);
      } catch (err) {
        this.log(`[hub] playbook select 失败: ${describeError(err)}`);
      }
    }
    const stage = this.store.playbook?.stage ?? run.stage;
    if (this.store.playbook?.id !== playbookId) {
      // 编排器未发事件（异常路径）时兜底更新。
      this.store.setPlaybook({ id: playbookId, stage: run.stage });
      this.broadcast('playbook/stage', { playbookId, stage: run.stage });
    }
    return { ok: true, stage };
  }

  async applyApproval(req: ApprovalRespondReq): Promise<{ ok: boolean }> {
    if (typeof req?.briefId !== 'string') return { ok: false };
    const orchestrator = await this.ensureOrchestrator();
    const runId = this.briefRuns.get(req.briefId) ?? '';
    try {
      orchestrator.applyApproval({
        brief: { briefId: req.briefId, runId },
        decision: req.decision
      });
    } catch (err) {
      this.log(`[orchestrator] applyApproval 失败: ${describeError(err)}`);
    }
    // 事件路径（approval/resolved）已清理时为幂等 no-op。
    if (this.store.resolveBrief(req.briefId)) {
      this.broadcast('approval/resolve', { briefId: req.briefId, decision: req.decision });
    }
    this.briefRuns.delete(req.briefId);
    this.store.appendTimeline({ kind: 'approval', briefId: req.briefId, decision: req.decision });
    return { ok: true };
  }

  // ── playbook 阶段驱动 ──────────────────────────────────────────────────

  /**
   * 首条用户消息驱动 playbook 前进：triage → selecting（代发 select）→
   * investigating。迁移失败只记日志不打断对话（合法迁移表由
   * src/orchestrator/engine.ts assertTransition 把关）。
   */
  private async advancePlaybookForPrompt(): Promise<void> {
    const run = this.activeRun;
    const orchestrator = this.orchestrator;
    if (!run || !orchestrator?.advanceTo) return;
    let stage = this.currentStage(run);
    if (stage === 'triage') {
      const next = this.tryAdvance(run, 'selecting');
      if (next) {
        stage = next;
        await this.applyStageSelect(orchestrator, run);
      }
    }
    if (stage === 'selecting') {
      stage = this.tryAdvance(run, 'investigating') ?? stage;
    }
    // 阶段事件里也会注入 L4；这里 await 保证首次模型调用前已生效
    // （并覆盖 runtime 重建后无阶段迁移的场景）。
    await this.injectStageLayer(this.store.playbook?.id ?? run.playbookId, stage);
  }

  private currentStage(run: PlaybookRunLike): string {
    return this.orchestrator?.getRun?.(run.id)?.stage ?? this.store.playbook?.stage ?? run.stage;
  }

  /** advanceTo 包一层：成功返回新阶段，失败（非法迁移等）记日志返回 undefined。 */
  private tryAdvance(run: PlaybookRunLike, stage: string): string | undefined {
    try {
      const updated = this.orchestrator?.advanceTo?.(run, stage);
      return updated ? updated.stage : undefined;
    } catch (err) {
      this.log(`[orchestrator] advanceTo(${stage}) 失败: ${describeError(err)}`);
      return undefined;
    }
  }

  /** 当前阶段的 yaml select 由 orchestrator 代发（不让模型随意选面）。 */
  private async applyStageSelect(
    orchestrator: OrchestratorLike,
    run: PlaybookRunLike
  ): Promise<void> {
    const desired = orchestrator.desiredSelect?.(run);
    if (!desired) return;
    try {
      await this.hub.selection.select(desired);
      this.selectCountThisTask += 1;
      orchestrator.recordSelect?.(run);
    } catch (err) {
      this.log(`[hub] playbook select 失败: ${describeError(err)}`);
    }
  }

  /** 阶段进入钩子：下发子代理、注入 L4、guidedManual 提示。绝不抛出。 */
  private handleStageEntered(runId: string, playbookId: string, stage: string): void {
    if (stage === 'investigating' || stage === 'verifying') {
      void this.spawnSubagentsFor(runId, stage).catch((err) =>
        this.log(`[subagent] spawn 失败: ${describeError(err)}`)
      );
    }
    void this.injectStageLayer(playbookId, stage);
    void this.maybeEmitGuidedManualNotice(runId, playbookId, stage).catch((err) =>
      this.log(`[guidedManual] 提示失败: ${describeError(err)}`)
    );
  }

  /**
   * 进入 investigating / verifying 时把 parallelGroup 转成 TaskSpec 并交
   * runtime 执行。orchestrator 缺 spawnSubagentSpecs 或 runtime 缺
   * dispatchSubagent 都静默降级：卡片仍显示（queued），但没有真实子代理。
   */
  private async spawnSubagentsFor(runId: string, stage: string): Promise<void> {
    const orchestrator = this.orchestrator;
    if (!orchestrator?.spawnSubagentSpecs) return;
    const key = `${runId}:${stage}`;
    if (this.spawnedStageKeys.has(key)) return;
    this.spawnedStageKeys.add(key);
    let specs: unknown[];
    try {
      // subagent/upsert（queued 卡片）在 spawnSubagentSpecs 内同步发出。
      specs = orchestrator.spawnSubagentSpecs(runId) ?? [];
    } catch (err) {
      this.log(`[orchestrator] spawnSubagentSpecs 失败: ${describeError(err)}`);
      return;
    }
    if (specs.length === 0) return;
    const runtime = this.runtime;
    for (const spec of specs) {
      const taskId = readTaskId(spec);
      if (taskId) this.activeSubagentTaskIds.add(taskId);
      if (!runtime?.dispatchSubagent) continue;
      void runtime
        .dispatchSubagent(spec)
        .then((res) => this.patchSubagentCard(res?.taskId ?? taskId, res?.status))
        .catch((err) => {
          this.log(`[runtime] dispatchSubagent 失败: ${describeError(err)}`);
          this.patchSubagentCard(taskId, 'failed', describeError(err));
        });
    }
    if (!runtime?.dispatchSubagent) {
      this.log(`[subagent] runtime 未提供 dispatchSubagent，${specs.length} 个任务保持 queued`);
    }
  }

  /**
   * 中止单个子代理：优先 runtime.abortSubagent（不牵连主会话）；
   * runtime 不支持子代理级中止时才退回整体 abort。
   */
  private abortSubagentTask(taskId: string, opts?: { keepMainSession?: boolean }): void {
    try {
      this.orchestrator?.abortSubagent?.(taskId);
    } catch (err) {
      this.log(`[orchestrator] abortSubagent 失败: ${describeError(err)}`);
    }
    const runtime = this.runtime;
    try {
      if (runtime?.abortSubagent) {
        runtime.abortSubagent(taskId);
      } else if (!opts?.keepMainSession) {
        runtime?.abort();
      }
    } catch (err) {
      this.log(`[runtime] abortSubagent 失败: ${describeError(err)}`);
    }
    this.activeSubagentTaskIds.delete(taskId);
    const card = this.store.getSubagent(taskId);
    if (card && (card.status === 'queued' || card.status === 'running')) {
      this.patchSubagentCard(taskId, 'aborted', '用户中止');
    }
  }

  /** 更新子代理卡片状态并广播；终态任务从全局停止清单摘除。 */
  private patchSubagentCard(taskId: string | undefined, status?: string, latest?: string): void {
    if (!taskId) return;
    const card = this.store.getSubagent(taskId);
    if (!card) return;
    const next: SubagentCard = {
      ...card,
      status: isSubagentStatus(status) ? status : card.status,
      ...(latest !== undefined ? { latest } : {})
    };
    this.store.upsertSubagent(next);
    this.broadcast('subagent/upsert', next);
    if (next.status !== 'queued' && next.status !== 'running') {
      this.activeSubagentTaskIds.delete(taskId);
    }
  }

  // ── L4 注入 ────────────────────────────────────────────────────────────

  /**
   * 阶段迁移时整体替换 L4，经 runtime 模块的 buildSystemPrompt 与 L0–L2
   * 合成后 setSystemPrompt。无法合成完整提示词（模块缺席）时跳过——
   * host 绝不用裸 L4 覆盖红线层。
   */
  private async injectStageLayer(playbookId: string, stage: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.setSystemPrompt) return;
    const key = `${playbookId}:${stage}`;
    if (this.lastLayerKey === key && this.lastLayerRuntime === runtime) return;
    const seq = ++this.stageLayerSeq;
    try {
      const mod = await loadRuntimeModule((m) => this.log(m));
      if (!mod?.buildSystemPrompt) return;
      const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
      const layer = await this.layerSource.stageLayer(meta, playbookId, stage);
      if (seq !== this.stageLayerSeq || this.runtime !== runtime) return; // 已有更新的注入
      runtime.setSystemPrompt(mod.buildSystemPrompt({ playbookLayer: layer }));
      this.lastLayerKey = key;
      this.lastLayerRuntime = runtime;
      this.log(`[runtime] 已注入 L4（${playbookId}/${stage}）`);
    } catch (err) {
      this.log(`[runtime] L4 注入失败: ${describeError(err)}`);
    }
  }

  // ── guidedManual ───────────────────────────────────────────────────────

  /**
   * 进入 guidedManual（或含人工步骤 playbook 的 synthesizing）时发一条
   * 引导提示：Jenkins 触发构建 / Nacos 发布配置走插件命令与面板，
   * Agent 不发明 MCP 写工具。每个 run 只提示一次。
   */
  private async maybeEmitGuidedManualNotice(
    runId: string,
    playbookId: string,
    stage: string
  ): Promise<void> {
    if (this.guidedNoticeRuns.has(runId)) return;
    const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
    const relevant =
      stage === 'guidedManual' ||
      (stage === 'synthesizing' && hasGuidedManualStep(playbookId, meta));
    if (!relevant) return;
    const notice = buildGuidedManualNotice(playbookId, meta);
    if (!notice) return;
    this.guidedNoticeRuns.add(runId);
    this.emitAssistantNotice(notice);
  }

  /**
   * guidedManual/open：运行插件侧命令（如 atJenkins.triggerBuild），
   * 写动作与凭据留在插件内。简报 elements.guidedManual 优先，
   * 其次当前 playbook 的 yaml / 已知默认命令。
   */
  private async openGuidedManual(briefId?: string): Promise<{ ok: boolean }> {
    let command: string | undefined;
    if (briefId) {
      const gm = this.store.pendingBriefs.find((b) => b.id === briefId)?.elements?.guidedManual;
      if (typeof gm === 'string') command = gm;
      else if (gm && typeof gm === 'object' && typeof (gm as { command?: unknown }).command === 'string') {
        command = (gm as { command: string }).command;
      }
    }
    const playbookId = this.store.playbook?.id;
    if (!command && playbookId) {
      const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
      command = guidedManualCommand(playbookId, meta);
    }
    if (!command) return { ok: false };
    const commandId = command.startsWith('command:') ? command.slice('command:'.length) : command;
    try {
      await vscode.commands.executeCommand(commandId);
      return { ok: true };
    } catch (err) {
      this.log(`[guidedManual] 命令 ${commandId} 执行失败: ${describeError(err)}`);
      this.emitAssistantNotice(
        `无法运行命令 \`${commandId}\`（对应 AT 插件可能未安装）。请打开对应插件面板手动完成操作。`
      );
      return { ok: false };
    }
  }

  /** guidedManual/complete：人工步骤完成，按迁移表推向 verifying / reporting。 */
  private async completeGuidedManual(briefId?: string): Promise<{ ok: boolean; stage?: string }> {
    // guided 简报是引导卡片而非 write/exec 审批：只清视图，不走 applyApproval 发 token。
    if (typeof briefId === 'string' && this.store.resolveBrief(briefId)) {
      this.broadcast('approval/resolve', { briefId, decision: 'approved' });
      this.briefRuns.delete(briefId);
      this.store.appendTimeline({ kind: 'guided_manual', briefId, status: 'completed' });
    }
    const run = this.activeRun;
    if (!run || !this.orchestrator?.advanceTo) return { ok: false };
    for (const next of ['verifying', 'reporting']) {
      const stage = this.tryAdvance(run, next);
      if (stage) return { ok: true, stage };
    }
    return { ok: false, stage: this.currentStage(run) };
  }

  /** LogViewer「在编辑器打开」：只打开 URI，不把大日志 postMessage 回 webview。 */
  private async openLog(uri?: string): Promise<{ ok: boolean }> {
    if (typeof uri !== 'string' || uri.trim().length === 0) {
      void vscode.window.showWarningMessage('没有可打开的日志 URI（结果可能已截断且未落盘）。');
      return { ok: false };
    }
    try {
      const parsed = vscode.Uri.parse(uri);
      const doc = await vscode.workspace.openTextDocument(parsed);
      await vscode.window.showTextDocument(doc, { preview: true });
      return { ok: true };
    } catch (err) {
      this.log(`[log/open] 打开失败: ${describeError(err)}`);
      void vscode.window.showErrorMessage(`无法打开日志：${describeError(err)}`);
      return { ok: false };
    }
  }

  /** SkillPicker：技能是渐进披露的参考文档，不在此执行写操作。 */
  private runSkill(name?: string): { ok: boolean } {
    if (typeof name !== 'string' || name.length === 0) return { ok: false };
    this.log(`[skill] 选用 ${name}（渐进披露，不自动执行变更）`);
    void vscode.window.showInformationMessage(
      `已选用技能 ${name}。Agent 会按需读取对应 SKILL.md / references，不会因此触发写操作。`
    );
    return { ok: true };
  }

  // ── 懒创建 ─────────────────────────────────────────────────────────────

  async ensureRuntime(): Promise<RuntimeLike> {
    if (this.runtime) return this.runtime;
    if (!this.runtimeCreation) {
      this.runtimeCreation = this.createRuntime().finally(() => {
        this.runtimeCreation = undefined;
      });
    }
    return this.runtimeCreation;
  }

  async ensureOrchestrator(): Promise<OrchestratorLike> {
    if (this.orchestrator) return this.orchestrator;
    if (!this.orchestratorCreation) {
      this.orchestratorCreation = this.createOrchestrator().finally(() => {
        this.orchestratorCreation = undefined;
      });
    }
    return this.orchestratorCreation;
  }

  dispose(): void {
    this.hubSub.dispose();
    this.timelineSub.dispose();
    this.disposeRuntime();
    this.orchestrator?.dispose?.();
    this.orchestrator = undefined;
    this.uiEmitter.dispose();
    this.boardEmitter.dispose();
  }

  // ── 内部：创建 ─────────────────────────────────────────────────────────

  private async createRuntime(): Promise<RuntimeLike> {
    const mod = await loadRuntimeModule((m) => this.log(m));
    const onEvent = (e: RuntimeEventLike) => this.onRuntimeEvent(e);
    let runtime: RuntimeLike;
    if (mod) {
      try {
        // 真 runtime 创建期内部兜底（缺 key → 自带 FallbackRuntime），不抛出。
        runtime = await Promise.resolve(
          mod.createOpsRuntime(
            {
              hub: this.hub,
              beforeToolCall: async (ctx) => this.gateToolCall(ctx.toolName, ctx.args),
              onEvent,
              onSubagentEvent: (e) =>
                this.patchSubagentCard(e.taskId, e.status, e.summary ?? e.error)
            },
            {
              agentDir: this.agentDir,
              cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
              model: this.modelSelection
                ? { provider: this.modelSelection.provider, id: this.modelSelection.model }
                : undefined
            }
          )
        );
        this.log('[runtime] createOpsRuntime 完成');
      } catch (err) {
        this.log(`[runtime] createOpsRuntime 失败（${describeError(err)}），使用 host 兜底 runtime`);
        runtime = new FallbackRuntime(onEvent);
      }
    } else {
      runtime = new FallbackRuntime(onEvent);
    }
    this.runtime = runtime;
    return runtime;
  }

  private async createOrchestrator(): Promise<OrchestratorLike> {
    const playbooks = await this.getPlaybooks();
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const onEvent = (e: OrchestratorEventLike) => this.onOrchestratorEvent(e);
    const mod = await loadOrchestratorModule((m) => this.log(m));
    let orchestrator: OrchestratorLike;
    if (mod) {
      try {
        orchestrator = mod.createOrchestrator({
          playbooks,
          maxParallel: config.get<number>('subagent.maxParallel', 3),
          onEvent
        });
        this.log(`[orchestrator] createOrchestrator 完成（${playbooks.length} 条 playbook）`);
      } catch (err) {
        this.log(`[orchestrator] createOrchestrator 失败（${describeError(err)}），使用兜底编排`);
        orchestrator = new FallbackOrchestrator(playbooks, onEvent, (m) => this.log(m));
      }
    } else {
      orchestrator = new FallbackOrchestrator(playbooks, onEvent, (m) => this.log(m));
    }
    this.orchestrator = orchestrator;
    return orchestrator;
  }

  private disposeRuntime(): void {
    const runtime = this.runtime;
    this.runtime = undefined;
    if (!runtime) return;
    void Promise.resolve()
      .then(() => runtime.dispose())
      .catch((err) => this.log(`[runtime] dispose 失败: ${describeError(err)}`));
  }

  // ── 权限闸（policy.evaluate 装配点） ──────────────────────────────────

  private async gateToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ block: boolean; reason?: string }> {
    try {
      const descriptor = this.hub.listAllTools().find((t) => t.name === toolName);
      // ops_* 发现工具视为 read；未知业务工具 fail-closed 为 exec。
      const risk = descriptor?.risk ?? (toolName.startsWith('ops_') ? 'read' : 'exec');
      const config = vscode.workspace.getConfiguration('atOpsAgent');
      const decision = evaluatePolicy({
        toolName,
        args,
        risk,
        pluginId: descriptor?.pluginId,
        stage: this.store.playbook?.stage,
        approval: null,
        sessionRequiredFor: config.get<'write-exec' | 'exec-only' | 'never'>(
          'approval.sessionRequiredFor',
          'write-exec'
        ),
        selectCountThisTask: this.selectCountThisTask
      });
      if (decision.block) {
        this.log(`[policy] ${toolName} 被拒: ${decision.code} ${decision.reason}`);
        return { block: true, reason: `${decision.code}: ${decision.reason}` };
      }
      if (SELECT_TOOL_NAMES.has(toolName)) {
        this.selectCountThisTask += 1;
      }
      if (decision.needSessionApproval) {
        // 会话审批闭环由 orchestrator 的 9 要素简报承载；无有效 token 一律拒。
        return {
          block: true,
          reason: `OPS_APPROVAL_REQUIRED: ${decision.reason}。请先产出 9 要素审批简报并等待会话内批准。`
        };
      }
      return { block: false };
    } catch (err) {
      // 闸门自身出错必须 fail-closed。
      this.log(`[policy] evaluate 异常，fail-closed: ${describeError(err)}`);
      return { block: true, reason: `策略闸异常，已按拒绝处理（${describeError(err)}）` };
    }
  }

  // ── runtime 事件 → host-protocol ──────────────────────────────────────

  private onRuntimeEvent(e: RuntimeEventLike): void {
    switch (e.type) {
      case 'text_delta': {
        if (!this.store.findItem(e.id)) {
          const item = { kind: 'assistant' as const, id: e.id, text: '', streaming: true };
          this.store.appendItem(item);
          this.broadcast('transcript/append', { item });
        }
        this.store.appendAssistantText(e.id, e.text);
        this.broadcast('transcript/patch', { itemId: e.id, patch: { appendText: e.text } });
        break;
      }
      case 'thinking_delta': {
        if (!this.store.findItem(e.id)) {
          const item = { kind: 'thinking' as const, id: e.id, steps: [] as string[] };
          this.store.appendItem(item);
          this.broadcast('transcript/append', { item });
        }
        this.store.appendThinkingText(e.id, e.text);
        this.broadcast('thinking/delta', { itemId: e.id, text: e.text });
        break;
      }
      case 'tool_start': {
        const descriptor = this.hub.listAllTools().find((t) => t.name === e.name);
        const call: ToolCallView = {
          name: e.name,
          pluginId: descriptor?.pluginId,
          risk: descriptor?.risk ?? (e.name.startsWith('ops_') ? 'read' : 'exec'),
          status: 'running',
          preview: e.preview
        };
        this.store.appendItem({ kind: 'tool', id: e.id, call });
        this.broadcast('tool/start', { itemId: e.id, call });
        break;
      }
      case 'tool_end': {
        const item = this.store.findItem(e.id);
        if (item?.kind !== 'tool') break;
        item.call = {
          ...item.call,
          status: e.ok === false ? 'error' : 'ok',
          preview: e.preview ?? item.call.preview,
          errorMessage: e.error
        };
        this.broadcast('tool/end', { itemId: e.id, call: item.call });
        break;
      }
      case 'idle': {
        for (const item of this.store.items) {
          if (item.kind === 'assistant' && item.streaming) {
            this.store.finalizeAssistant(item.id);
            this.broadcast('transcript/patch', { itemId: item.id, patch: { streaming: false } });
          }
        }
        this.broadcast('turn/end', {});
        break;
      }
      default:
        // runtime 可扩展事件面；未知类型忽略。
        break;
    }
  }

  // ── orchestrator 事件 → host-protocol ─────────────────────────────────

  private onOrchestratorEvent(e: OrchestratorEventLike): void {
    switch (e.type) {
      case 'playbook/stage': {
        this.store.setPlaybook({ id: e.playbookId, stage: e.stage });
        this.broadcast('playbook/stage', { playbookId: e.playbookId, stage: e.stage });
        this.store.appendTimeline({
          kind: 'playbook_stage',
          playbookId: e.playbookId,
          from: e.from,
          stage: e.stage
        });
        this.handleStageEntered(e.runId, e.playbookId, e.stage);
        break;
      }
      case 'subagent/upsert': {
        this.store.upsertSubagent(e.card);
        this.broadcast('subagent/upsert', e.card);
        break;
      }
      case 'approval/request': {
        const view = toBriefView(e.brief);
        this.briefRuns.set(e.brief.briefId, e.brief.runId);
        this.store.addBrief(view);
        const item = { kind: 'approval' as const, id: randomUUID(), briefId: view.id };
        this.store.appendItem(item);
        this.broadcast('transcript/append', { item });
        this.broadcast('approval/request', view);
        break;
      }
      case 'approval/resolved': {
        if (this.store.resolveBrief(e.briefId)) {
          this.broadcast('approval/resolve', { briefId: e.briefId, decision: e.decision });
        }
        this.briefRuns.delete(e.briefId);
        break;
      }
      default:
        break;
    }
  }

  // ── 内部：杂项 ─────────────────────────────────────────────────────────

  private broadcast(type: string, payload: unknown): void {
    const env = envelope('evt', type, payload, randomUUID());
    this.uiEmitter.fire(env);
    if (type === 'playbook/stage' || type === 'subagent/upsert') {
      this.boardEmitter.fire(env);
    }
  }

  private emitAssistantNotice(text: string): void {
    const item = { kind: 'assistant' as const, id: randomUUID(), text };
    this.store.appendItem(item);
    this.broadcast('transcript/append', { item });
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SUBAGENT_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'ok',
  'degraded',
  'failed',
  'aborted'
]);

function isSubagentStatus(value: string | undefined): value is SubagentCard['status'] {
  return value !== undefined && SUBAGENT_STATUSES.has(value);
}

function readTaskId(spec: unknown): string | undefined {
  if (typeof spec !== 'object' || spec === null) return undefined;
  const taskId = (spec as { taskId?: unknown }).taskId;
  return typeof taskId === 'string' ? taskId : undefined;
}

function toBriefView(brief: ApprovalBriefLike): ApprovalBriefView {
  const elements: Record<string, string | unknown> = { ...(brief.elements ?? {}) };
  if (brief.commandSet !== undefined && elements.commands === undefined) {
    elements.commands = brief.commandSet;
  }
  // 默认双确认（会话审批 + 插件内确认弹窗）；仅当用户显式开启
  // dedupePluginModal 去重时 UI 才不再提示第二道闸。
  const dedupePluginModal = vscode.workspace
    .getConfiguration('atOpsAgent')
    .get<boolean>('approval.dedupePluginModal', false);
  return {
    id: brief.briefId,
    risk: brief.risk,
    targetLabel: brief.elements?.goal ?? `${brief.risk} 变更（run ${brief.runId}）`,
    elements,
    dualConfirmHint: !dedupePluginModal
  };
}
