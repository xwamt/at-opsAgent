/**
 * Host 业务中枢：
 * - 懒创建 runtime（首个 chat/prompt 才碰 LLM 配置，activate 保持廉价）
 * - 懒创建 orchestrator（playbook / 审批首次使用时）
 * - runtime / orchestrator 事件 → host-protocol 事件
 *   （transcript/append|patch、tool/*、thinking/delta、approval/*…）
 * - webview 请求路由（chat/prompt、chat/abort、playbook/start、approval/respond…）
 * - beforeToolCall 权限闸装配（policy.evaluate；orchestrator 侧不重复）
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
  type ToolCallView
} from '../protocol';
import { evaluatePolicy } from '../policy';
import { FallbackOrchestrator, loadPlaybooksFallback } from './fallback/fallbackOrchestrator';
import { FallbackRuntime } from './fallback/fallbackRuntime';
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

  constructor(options: HostControllerOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.secrets = options.secrets;
    this.output = options.output;
    this.extensionPath = options.extensionPath;
    this.agentDir = path.join(os.homedir(), '.at-series', 'agent');
    this.modelsPath = path.join(this.agentDir, 'models.json');
    this.playbooksDir = path.join(this.extensionPath, 'skills', 'playbooks');

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
        const taskId = (payload as { taskId: string }).taskId;
        this.orchestrator?.abortSubagent?.(taskId);
        this.runtime?.abort();
        return { ok: true };
      }
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
    void runtime.prompt(text, { mode: req.mode }).catch((err) => {
      this.log(`[runtime] prompt 失败: ${describeError(err)}`);
      this.emitAssistantNotice(`⚠ 模型调用失败：${describeError(err)}`);
    });
    return { accepted: true };
  }

  abort(): void {
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
    // playbook/stage 事件已在 startPlaybook 内同步发出（store 已更新）。
    const desiredSelect = orchestrator.desiredSelect?.(run);
    if (desiredSelect) {
      try {
        await this.hub.selection.select(desiredSelect);
        this.selectCountThisTask += 1;
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
              onEvent
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

function toBriefView(brief: ApprovalBriefLike): ApprovalBriefView {
  const elements: Record<string, string | unknown> = { ...(brief.elements ?? {}) };
  if (brief.commandSet !== undefined && elements.commands === undefined) {
    elements.commands = brief.commandSet;
  }
  return {
    id: brief.briefId,
    risk: brief.risk,
    targetLabel: brief.elements?.goal ?? `${brief.risk} 变更（run ${brief.runId}）`,
    elements,
    // 第一期默认双确认（atOpsAgent.approval.dedupePluginModal 默认 false）。
    dualConfirmHint: true
  };
}
