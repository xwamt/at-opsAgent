/**
 * 聊天 / 会话服务：
 * - prompt 派发（playbook 阶段推进 + L4 注入 → runtime.prompt）与重试；
 * - 会话 runtime 池（P2 sessions.maxParallel ≤ 2）：sessionId → runtime，
 *   两个会话可同时 prompt（查库 + 查主机各占一席）；中止按会话定向；
 *   重建（换模型 / 新工具）逐 runtime 等各自 idle（P1-15）；
 * - runtime / 子代理事件 → host-protocol 事件（RuntimeEventRouter /
 *   subagentCards：写事件所属会话的 store 包，活动会话才实时广播）；
 * - atOpsAgent.running context key 反映**活动会话**是否运行中。
 */
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  ChatPromptReq,
  HydrateEvt,
  SessionSummary,
  UsageView
} from '../../protocol';
import type { CreateOpsRuntimeOptions, OpsRuntimeHandlers, OpsSubagentEvent } from '../../core';
import { clearHubSelection } from '../../hub-host';
import { readAgentSettings } from '../agentSettings';
import { normalizeRoleModels } from '../modelsView';
import type { RuntimeLike } from '../hostTypes';
import { describeError, type HostContext } from './context';
import { ensureVisibleInspectionReport } from './inspectionSummary';
import { RuntimeEventRouter } from './runtimeEvents';
import { SessionPoolExhaustedError, SessionRuntimePool } from './runtimePool';
import { StageLayerInjector } from './stageLayers';
import { appendEvidenceNote, patchSubagentCard, type SubagentCardPatch } from './subagentCards';

export class ChatService {
  private readonly pool: SessionRuntimePool;
  private readonly events: RuntimeEventRouter;
  /** atOpsAgent.running context key 当前值（避免重复 setContext）。 */
  private runningContext = false;
  /** sessionId → 最近一次 usage 事件（hydrate 回放；席位驱逐清空）。 */
  private readonly lastUsage = new Map<string, UsageView>();
  /** sessionId → 全局停止时需一并中止的在跑子代理。 */
  private readonly activeSubagentTaskIds = new Map<string, Set<string>>();
  /**
   * 每条 prompt 前的 L-env（+当前 L4）现场同步（docs/13 §4.2）。
   * PlaybookService 持有自己的注入器做阶段迁移注入；这里独立一份席位状态
   * 做 per-prompt 同步——两者合成同一份 buildSystemPrompt 内容，互不擦层。
   */
  private readonly liveLayers: StageLayerInjector;

  constructor(private readonly ctx: HostContext) {
    this.liveLayers = new StageLayerInjector(ctx, () => ctx.playbooks.getPlaybooks());
    this.pool = new SessionRuntimePool({
      maxParallel: () =>
        vscode.workspace.getConfiguration('atOpsAgent').get<number>('sessions.maxParallel', 1),
      createRuntime: (sessionId) => this.createRuntime(sessionId),
      onEvicted: (sessionId) => this.onSessionEvicted(sessionId),
      onBusyChange: () => this.updateRunningContext(),
      log: (m) => ctx.log(m)
    });
    this.events = new RuntimeEventRouter(ctx, {
      // docs/14 P0-report：idle 时本轮若只有工具、无可见 assistant 结论，
      // host 先合成中文巡检结论上屏再释放席位。
      onIdle: (sessionId) => {
        ensureVisibleInspectionReport(ctx, sessionId);
        this.pool.markIdle(sessionId);
      },
      setUsage: (sessionId, usage) => {
        this.lastUsage.set(sessionId, usage);
      }
    });
  }

  // ── 快照 ────────────────────────────────────────────────────────────────

  snapshot(): HydrateEvt {
    const ctx = this.ctx;
    const providers = ctx.config.safeProviders();
    const playbooks = ctx.playbooks.cachedPlaybooks();
    const modelsPayload = ctx.models.chatModelsExtra();
    if (!playbooks) {
      // 不阻塞快照：后台预热缓存，下一次 hydrate 自然带上。
      void ctx.playbooks.getPlaybooks().catch(() => {});
      return ctx.store.snapshot(providers, modelsPayload);
    }
    // webview 的 absorbCapabilities 从 providers 记录里取 playbooks；
    // 顶层字段同时下发，供后续消费方直接读取。
    const providersWithPlaybooks =
      typeof providers === 'object' && providers !== null && !Array.isArray(providers)
        ? { ...(providers as Record<string, unknown>), playbooks }
        : providers;
    return ctx.store.snapshot(providersWithPlaybooks, { playbooks, ...modelsPayload });
  }

  chatCapabilitiesPayload(): Record<string, unknown> {
    const extra = this.ctx.models.chatModelsExtra();
    const playbooks = this.ctx.playbooks.cachedPlaybooks();
    return {
      providers: this.ctx.config.safeProviders(),
      ...extra,
      ...(playbooks ? { playbooks } : {})
    };
  }

  usageOf(sessionId: string): UsageView | undefined {
    return this.lastUsage.get(sessionId);
  }

  runtimeFor(sessionId: string): RuntimeLike | undefined {
    return this.pool.runtimeOf(sessionId);
  }

  /** 活动会话 runtime 懒创建（模型保存后预热等）。 */
  ensureActiveRuntime(): Promise<RuntimeLike> {
    return this.pool.ensure(this.ctx.store.activeSessionId);
  }

  /** 换模型：全部在池席位请求重建（各自 idle 后续接重建）。 */
  scheduleRebuildAll(reason: string): void {
    this.pool.scheduleRebuildAll(reason);
  }

  // ── chat ────────────────────────────────────────────────────────────────

  async handlePrompt(req: ChatPromptReq): Promise<{ accepted: boolean }> {
    let text = typeof req?.text === 'string' ? req.text : '';
    for (const attachment of req?.attachments ?? []) {
      if (attachment.kind === 'alert-paste' && typeof attachment.text === 'string') {
        text += `\n\n[粘贴的告警]\n${attachment.text}`;
      } else if (typeof attachment.text === 'string' && attachment.text.length > 0) {
        text += `\n\n[${attachment.label ?? attachment.kind}]\n${attachment.text}`;
      } else if (typeof attachment.uri === 'string') {
        text += `\n\n[附件] ${attachment.uri}`;
      }
    }
    if (text.trim().length === 0) return { accepted: false };
    const userItem = { kind: 'user' as const, id: randomUUID(), text };
    this.ctx.store.appendItem(userItem);
    this.ctx.broadcast('transcript/append', { item: userItem });
    return this.dispatchPrompt(text, req.mode);
  }

  /** chat/retry：重发最后一条用户消息（不重复追加 transcript 项）。 */
  async retryLastPrompt(): Promise<{ accepted: boolean }> {
    const lastUser = [...this.ctx.store.items].reverse().find((i) => i.kind === 'user');
    if (!lastUser || lastUser.kind !== 'user' || lastUser.text.trim().length === 0) {
      return { accepted: false };
    }
    return this.dispatchPrompt(lastUser.text, undefined);
  }

  /**
   * prompt 统一派发（活动会话席位）：playbook 阶段推进 + L4 注入 →
   * runtime.prompt。sessions.maxParallel=2 时另一会话可同时在跑；
   * 席位耗尽（两席都忙）时拒绝派发并上屏提示，不排队阻塞。
   */
  private async dispatchPrompt(
    text: string,
    mode: 'steer' | 'followUp' | undefined
  ): Promise<{ accepted: boolean }> {
    const ctx = this.ctx;
    const sessionId = ctx.store.activeSessionId;
    let runtime: RuntimeLike;
    try {
      runtime = await this.pool.ensure(sessionId);
    } catch (err) {
      if (err instanceof SessionPoolExhaustedError) {
        ctx.emitAssistantNotice(`⚠ ${err.message}`, sessionId);
        return { accepted: false };
      }
      throw err;
    }
    // docs/13 §4.2：模型开口前先等一轮 Hub catalog 刷新（消掉 start 竞态；
    // 失败只记日志，绝不因此拒发 prompt）。
    try {
      await ctx.hub.refresh();
    } catch (err) {
      ctx.log(`[hub] refresh 失败（继续派发）: ${describeError(err)}`);
    }
    // playbook 阶段驱动 + 当前阶段 L4 注入在首次模型调用之前完成。
    await ctx.playbooks.advancePlaybookForPrompt(sessionId);
    // 现场同步：L-env（hub 实时快照）+ 当前 L4（若本会话有进行中的 playbook）
    // 一起经 buildSystemPrompt 合成后 setSystemPrompt——互不擦层。
    await this.liveLayers.syncLivePrompt(sessionId);
    this.pool.markBusy(sessionId);
    void runtime.prompt(text, mode !== undefined ? { mode } : undefined).catch((err) => {
      ctx.log(`[runtime] prompt 失败: ${describeError(err)}`);
      ctx.emitAssistantNotice(`⚠ 模型调用失败：${describeError(err)}`, sessionId);
      this.pool.markIdle(sessionId);
    });
    return { accepted: true };
  }

  /**
   * 中止（按会话定向，缺省活动会话；不牵连另一席）。
   * mode='stop'（默认）：立即 abort 该会话并级联其子代理；
   * mode='cancel'：软停——runtime 等当前 in-flight 非审批工具结束后停止（保在途证据）。
   * 阻塞派发中挂起的审批在 cancel 与 stop 时均按拒绝决议，避免 execute 悬挂。
   */
  abort(mode: 'cancel' | 'stop' = 'stop', sessionId?: string): void {
    const sid = sessionId ?? this.ctx.store.activeSessionId;
    this.ctx.approvals.rejectWaitersFor(sid);
    if (mode === 'stop') {
      for (const taskId of [...(this.activeSubagentTaskIds.get(sid) ?? [])]) {
        this.abortSubagentTask(taskId, { keepMainSession: true }, sid);
      }
    }
    this.pool.abort(sid, mode);
  }

  // ── 会话生命周期 ────────────────────────────────────────────────────────

  newSession(): void {
    this.ctx.store.newSession();
    this.afterActiveSessionChanged();
    this.ctx.broadcast('hydrate', this.snapshot());
  }

  /**
   * 切换会话：store 恢复目标会话的内存包（transcript / 简报 / 时间线）。
   * sessions.maxParallel=1 时其余席位（含旧会话 runtime 与其审批/playbook
   * 运行态）随切换驱逐——审批令牌绑定 sessionId，跨会话绝不复用；
   * =2 时后台席位保留，后台会话可继续在跑。切换后广播 hydrate。
   */
  switchSession(id: string | undefined): { ok: boolean } {
    if (typeof id !== 'string' || id.length === 0) return { ok: false };
    if (id === this.ctx.store.activeSessionId) return { ok: true };
    if (!this.ctx.store.switchSession(id)) return { ok: false };
    this.afterActiveSessionChanged();
    this.ctx.broadcast('hydrate', this.snapshot());
    return { ok: true };
  }

  private afterActiveSessionChanged(): void {
    if (this.pool.effectiveMaxParallel() <= 1) {
      // 单席位：保持既有行为——切换即释放其余会话的 runtime 与运行态。
      this.pool.evictAllExcept(this.ctx.store.activeSessionId);
    }
    this.updateRunningContext();
  }

  /** 席位驱逐回调：清空该会话绑定的运行态（store 会话包与 JSONL 不动）。 */
  private onSessionEvicted(sessionId: string): void {
    this.ctx.approvals.clearSession(sessionId);
    this.ctx.playbooks.clearSession(sessionId);
    this.liveLayers.clearSession(sessionId);
    this.lastUsage.delete(sessionId);
    this.activeSubagentTaskIds.delete(sessionId);
    void clearHubSelection(this.ctx.hub, (m) => this.ctx.log(m), 'eviction');
  }

  sessionSummaries(): SessionSummary[] {
    return this.ctx.store.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt
    }));
  }

  private updateRunningContext(): void {
    const value = this.pool.isBusy(this.ctx.store.activeSessionId);
    if (this.runningContext === value) return;
    this.runningContext = value;
    void vscode.commands.executeCommand('setContext', 'atOpsAgent.running', value);
  }

  dispose(): void {
    this.pool.dispose();
  }

  // ── 子代理 ──────────────────────────────────────────────────────────────

  /**
   * 中止单个子代理：优先 runtime.abortSubagent（不牵连主会话）；
   * runtime 不支持子代理级中止时才退回整体 abort。
   */
  abortSubagentTask(
    taskId: string,
    opts?: { keepMainSession?: boolean },
    sessionId?: string
  ): void {
    const ctx = this.ctx;
    const sid = sessionId ?? ctx.store.activeSessionId;
    ctx.playbooks.abortSubagentInOrchestrator(taskId);
    const runtime = this.pool.runtimeOf(sid);
    try {
      if (runtime?.abortSubagent) {
        runtime.abortSubagent(taskId);
      } else if (!opts?.keepMainSession) {
        runtime?.abort();
      }
    } catch (err) {
      ctx.log(`[runtime] abortSubagent 失败: ${describeError(err)}`);
    }
    this.activeSubagentTaskIds.get(sid)?.delete(taskId);
    const card = ctx.store.getSubagent(taskId, sid);
    if (card && (card.status === 'queued' || card.status === 'running')) {
      this.upsertSubagentCard(sid, taskId, { status: 'aborted', latest: '用户中止' });
    }
  }

  /** 卡片写 store + 广播 + live 集维护（stop 级联中止用）。 */
  private upsertSubagentCard(
    sessionId: string,
    taskId: string | undefined,
    patch: SubagentCardPatch
  ): void {
    const live = patchSubagentCard(this.ctx, sessionId, taskId, patch);
    if (live === undefined || taskId === undefined) return;
    let set = this.activeSubagentTaskIds.get(sessionId);
    if (!set) {
      set = new Set();
      this.activeSubagentTaskIds.set(sessionId, set);
    }
    if (live) set.add(taskId);
    else set.delete(taskId);
  }

  // ── runtime 创建 ────────────────────────────────────────────────────────

  private async createRuntime(sessionId: string): Promise<RuntimeLike> {
    const ctx = this.ctx;
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const handlers: OpsRuntimeHandlers = {
      hub: ctx.hub,
      beforeToolCall: (c) => ctx.approvals.gateToolCall(sessionId, c.toolName, c.args, c.origin),
      // P0-D 阻塞派发：needSessionApproval 时 runtime 在同一 execute 内
      // await 本回调；批准继续同一调用，无需模型重试。
      requestApproval: (input) => ctx.approvals.resolveSessionApproval(sessionId, input),
      onEvent: (e) => this.events.route(sessionId, e),
      // goal / visibleTools 为 runtime 侧后续开始发送的可选字段：交集类型
      // 让旧 runtime（不带这两个字段）与新 runtime 都能通过类型检查。
      onSubagentEvent: (e: OpsSubagentEvent & { goal?: string; visibleTools?: string[] }) => {
        this.upsertSubagentCard(sessionId, e.taskId, {
          status: e.status,
          latest: e.summary ?? e.error,
          role: e.role,
          goal: e.goal,
          visibleTools: e.visibleTools
        });
        if (e.evidenceNote) appendEvidenceNote(ctx, sessionId, e.evidenceNote);
      },
      // pi 会话无法追加新 ToolDefinition：目录需要重建时等该席 idle 释放，
      // 下一次 prompt 以最新工具目录 + resumeSessionFile 续接重建。
      onCatalogNeedsRebuild: () => this.pool.scheduleRebuild(sessionId, '工具目录出现新工具'),
      playbooks: {
        list: () => ctx.playbooks.listPlaybookCatalog(),
        start: async (playbookId: string) => {
          const result = await ctx.playbooks.startPlaybook(playbookId, { advance: true }, sessionId);
          return result.ok
            ? { ok: true, ...(result.stage !== undefined ? { stage: result.stage } : {}) }
            : { ok: false, error: result.error ?? '无法启动 playbook' };
        },
        advance: (stage?: string) => ctx.playbooks.advancePlaybook(stage, sessionId),
        close: () => ctx.playbooks.closePlaybook(sessionId)
      }
    };
    // per-role 模型映射（settings.json roleModels；C 提供 UI）。
    // D-runtime 落地 roleModels 选项前多余字段会被忽略——行为不劣于现状。
    const roleModels = normalizeRoleModels((await readAgentSettings(ctx.agentDir)).roleModels);
    const resumeSessionFile = ctx.store.sessionFileOf(sessionId);
    // 变量承载（避免字面量多余属性检查）：runtime 未落地 roleModels 前忽略该字段。
    const options: CreateOpsRuntimeOptions & {
      roleModels?: ReturnType<typeof normalizeRoleModels>;
    } = {
      agentDir: ctx.agentDir,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      model: ctx.models.resolveRuntimeModelPref(),
      // 按 provider 取 key（缺省用当前选中模型的 provider；旧键自动回退）。
      getApiKey: (providerId?: string) =>
        Promise.resolve(ctx.secrets.getLlmApiKey(providerId ?? ctx.models.selection?.provider)),
      bundledSkillsDir: path.join(ctx.extensionPath, 'skills'),
      thinkingLevel: await ctx.models.resolveThinkingLevel(config),
      workspaceShellEnabled: config.get<boolean>('workspaceShell.enabled', false),
      ...(resumeSessionFile !== undefined ? { resumeSessionFile } : {}),
      ...(Object.keys(roleModels).length > 0 ? { roleModels } : {})
    };
    let runtime: RuntimeLike;
    try {
      // 真 runtime 创建期内部兜底（缺 key → 自带 FallbackRuntime），不抛出。
      runtime = await ctx.core.createRuntime(handlers, options);
      ctx.log('[runtime] createOpsRuntime 完成');
    } catch (err) {
      ctx.log(`[runtime] createOpsRuntime 失败（${describeError(err)}），使用兜底 runtime`);
      runtime = ctx.core.createFallbackRuntime(handlers, describeError(err));
    }
    // P0-C：记录该会话的 pi JSONL，重建 / 重载后续接同一会话。
    if (typeof runtime.sessionFile === 'string' && runtime.sessionFile.length > 0) {
      ctx.store.setSessionFile(sessionId, runtime.sessionFile);
    }
    return runtime;
  }
}
