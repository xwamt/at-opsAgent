/**
 * Host 业务中枢：
 * - 静态装配（src/core OpsCore facade）：runtime / orchestrator / policy /
 *   mcp-client 全部经 createOpsCore() 取用，不再有动态装载器与 host fallback
 * - 懒创建 runtime（首个 chat/prompt 才碰 LLM 配置，activate 保持廉价）；
 *   重建（换模型 / 新工具上线）只在会话 idle 时进行，并带 resumeSessionFile
 *   续接同一 pi JSONL——上下文不丢（P0-C / P1-15）
 * - runtime / orchestrator 事件 → host-protocol 事件
 *   （transcript/append|patch、tool/*、thinking/delta、usage、compaction、
 *   notice、approval/*…）
 * - webview 请求路由（chat/prompt|abort|retry|export、models/test|fetch、
 *   asset/pick、playbook/start|advance|close、approval/respond…）
 * - beforeToolCall 权限闸装配（policy.evaluate；orchestrator 侧不重复）；
 *   needSessionApproval 时 runtime 在同一 execute 内 await 会话审批
 *   （阻塞派发，P0-D）——批准继续同一调用，无需模型重试
 * - 会话审批闭环：write/exec 被策略闸拦下时产出 9 要素简报（有 playbook run
 *   经 orchestrator，普通问答走 host 本地简报），批准后 host 内存签发 HMAC
 *   令牌（不进 LLM/webview），配置了 IM webhook 时同步推送脱敏摘要
 * - playbook 阶段驱动：用户显式 /playbook 或主代理调用 ops_start_playbook
 *   后，首条用户消息 triage → selecting → investigating；
 *   阶段迁移时整体替换 L4。host **不会**用 NL 关键词自动启动 playbook。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  Emitter,
  envelope,
  type ApprovalBriefView,
  type ApprovalRespondReq,
  type AssetPickRes,
  type ChatAbortReq,
  type ChatPromptReq,
  type Envelope,
  type Event,
  type EvidenceNoteView,
  type HubHost,
  type HydrateEvt,
  type McpSaveReq,
  type ModelsFetchReq,
  type ModelsFetchRes,
  type ModelsTestReq,
  type ModelsTestRes,
  type ModelSetReq,
  type SessionSummary,
  type SettingsOpenJsonReq,
  type SettingsPatchConfigReq,
  type SubagentCard,
  type ToolCallView,
  type TranscriptItem,
  type UsageView
} from '../protocol';
import {
  createOpsCore,
  type CreateOpsRuntimeOptions,
  type OpsCore,
  type OpsRuntimeHandlers,
  type Playbook,
  type PolicyContext,
  type ToolCallOrigin
} from '../core';
import { hashCommandSet, issueApprovalToken, verifyApprovalToken, type ApprovalRef } from '../policy';
import { normalizeThinkingLevel, patchAgentSettings, readAgentSettings } from './agentSettings';
import { buildApprovalCommandSet, buildApprovalElements } from './approvalGate';
import { diagnoseHub } from './diagnose';
import { buildOpsReportMarkdown, exportReportFileName } from './exportReport';
import { buildGuidedManualNotice, guidedManualCommand, hasGuidedManualStep } from './guidedManual';
import type {
  ApprovalBriefLike,
  OrchestratorEventLike,
  OrchestratorLike,
  PlaybookMeta,
  PlaybookRunLike,
  RuntimeEventLike,
  RuntimeLike,
  ThinkingLevel
} from './hostTypes';
import { listConfiguredModels, pickSelectedModel, readLastModel } from './modelsCatalog';
import { fetchModelCatalog, probeOpenAiCompatible } from './modelsProbe';
import { normalizeRoleModels, openModelsJson, readModelsFormState, saveModelsForm } from './modelsView';
import { loginOAuthViaPi, openAuthJson } from './oauthLogin';
import { PlaybookLayerSource } from './playbookLayer';
import type { OpsSecrets } from './secrets';
import type { SessionStore } from './sessionStore';
import { listSkills, type SkillInfo } from './skillsScan';

const SELECT_TOOL_NAMES = new Set(['ops_select_tools', 'at_select_tools']);

const SUBAGENT_POLICY_ROLES: ReadonlySet<string> = new Set([
  'lead',
  'investigator',
  'executor',
  'writer',
  'verifier'
]);

const RISK_LEVELS: ReadonlySet<string> = new Set(['read', 'write', 'exec']);

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

/** settings/patchConfig 白名单：与 package.json contributes.configuration 对齐。 */
const KNOWN_CONFIG_KEYS: readonly string[] = [
  'discovery.mode',
  'discovery.threshold',
  'plugins.autoEnableNew',
  'approval.sessionRequiredFor',
  'approval.dedupePluginModal',
  'approval.sessionReadAllowlist',
  'models.defaultThinkingLevel',
  'models.toolCallPromptFallback',
  'workspaceShell.enabled',
  'subagent.maxParallel',
  'sessions.maxParallel',
  'streaming.batchMs',
  'inspection.intervalMinutes',
  'im.webhookUrl'
];

/** mcp/get 脱敏占位；mcp/save 时同值从现有文件回填，不会抹掉真实凭证。 */
const MCP_REDACTED = '***';

/** 「打开 mcp.json」文件缺失时写入的模板（无任何凭证）。 */
const MCP_TEMPLATE = `{
  "servers": {}
}
`;

/** settings/hydrate 的载荷（设置页 webview 全量快照）。 */
export interface SettingsSnapshot {
  /** atOpsAgent.* 已知键的当前值。 */
  config: Record<string, unknown>;
  modelsPath: string;
  agentDir: string;
  /** hub.getProviders() 结果（能力插件清单）。 */
  capabilities: unknown;
  /**
   * 恒为空：内置技能是 Agent 内部资源（OpsResourceLoader / ops_read_skill
   * 渐进披露给模型），不是用户可配置目录，不下发 webview。
   */
  skills: SkillInfo[];
  sessions: SessionSummary[];
  /** mcp.json 脱敏文本（env/header/bearer 值 → ***）。 */
  mcp: { path: string; exists: boolean; text: string; error?: string };
  pendingApprovals: number;
}

export interface HostControllerOptions {
  hub: HubHost;
  store: SessionStore;
  secrets: OpsSecrets;
  output: vscode.OutputChannel;
  extensionPath: string;
}

/** 阻塞派发审批的等待者（briefId → 决议 promise）。 */
interface ApprovalWaiter {
  commandSetSha256: string;
  promise: Promise<'approved' | 'rejected'>;
  resolve: (decision: 'approved' | 'rejected') => void;
}

export class HostController {
  readonly hub: HubHost;
  readonly store: SessionStore;
  readonly secrets: OpsSecrets;
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly playbooksDir: string;

  private readonly core: OpsCore = createOpsCore();
  private readonly output: vscode.OutputChannel;
  private readonly extensionPath: string;

  private readonly uiEmitter = new Emitter<Envelope>();
  /** 面向 Chat webview 的事件流（由 ChatViewProvider 合批转发）。 */
  readonly onUiEvent: Event<Envelope> = this.uiEmitter.event;

  private readonly boardEmitter = new Emitter<Envelope>();
  /** 面向 Ops 看板的事件流（timeline/upsert）。 */
  readonly onBoardEvent: Event<Envelope> = this.boardEmitter.event;

  private readonly statusEmitter = new Emitter<void>();
  /** 状态位变化（hasApiKey 等）；activate 的状态栏订阅。 */
  readonly onDidChangeStatus: Event<void> = this.statusEmitter.event;

  private runtime: RuntimeLike | undefined;
  private runtimeCreation: Promise<RuntimeLike> | undefined;
  /** 会话是否有进行中的模型轮（idle 事件清除）。 */
  private runtimeBusy = false;
  /** P1-15：运行中收到重建请求先挂起，idle 后再释放 runtime。 */
  private pendingRebuildReason: string | undefined;
  /** atOpsAgent.running context key 当前值（避免重复 setContext）。 */
  private runningContext = false;

  private orchestrator: OrchestratorLike | undefined;
  private orchestratorCreation: Promise<OrchestratorLike> | undefined;

  private playbookCache: Playbook[] | undefined;
  private modelSelection: ModelSetReq | undefined;
  /** SecretStorage 是否已有 LLM key（异步刷新；选择器不依赖此字段显示清单）。 */
  private hasApiKey = false;
  /** 最近一次 usage 事件（hydrate 回放；会话切换清空）。 */
  private lastUsage: UsageView | undefined;
  private selectCountThisTask = 0;
  /** 已知插件基线（plugins.autoEnableNew=false 时用于识别「新上线」插件）。 */
  private knownPluginIds: Set<string> | undefined;
  /** briefId → runId（applyApproval 需要 runId 定位 run；host 本地简报为 ''）。 */
  private readonly briefRuns = new Map<string, string>();
  /** briefId → commandSetSha256（批准时签发令牌用；resolved 后清除）。 */
  private readonly briefHashes = new Map<string, string>();
  /** briefId → 阻塞派发等待者（runtime 在 execute 内 await 的 promise）。 */
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  /** 本会话内已免审的 read 工具名（「本会话不再问」；切会话清空）。 */
  private readonly sessionReadAllowlist = new Set<string>();
  /**
   * 会话内当前有效的审批引用。token 只存 host 内存：
   * 不发给 LLM、不发给 webview、不写日志。
   */
  private currentApproval: ApprovalRef | null = null;
  /** 审批令牌 HMAC 秘钥：进程内随机生成，同样绝不外发/落日志。 */
  private readonly approvalSecret = randomBytes(32).toString('hex');
  private readonly hubSub: { dispose(): void };
  private readonly timelineSub: { dispose(): void };

  /** 当前 playbook run（阶段驱动 / guidedManual/complete 的落点）。 */
  private activeRun: PlaybookRunLike | undefined;
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
    this.modelSelection = readLastModel(this.agentDir);
    void this.bootstrapModelCatalog();

    this.hubSub = this.hub.onDidChangeTools(() => {
      this.handleToolCatalogChange();
      this.broadcast('capabilities/snapshot', this.chatCapabilitiesPayload());
    });
    this.timelineSub = this.store.onDidAppendTimeline((event) => {
      this.boardEmitter.fire(envelope('evt', 'timeline/upsert', event, randomUUID()));
    });
  }

  log(message: string): void {
    this.output.appendLine(message);
  }

  /** SecretStorage 是否有 LLM key（状态栏未配置警示消费）。 */
  get hasModelApiKey(): boolean {
    return this.hasApiKey;
  }

  // ── 快照 ───────────────────────────────────────────────────────────────

  safeProviders(): unknown {
    try {
      return this.hub.getProviders();
    } catch {
      return { hostApp: this.hub.hostApp, providers: [] };
    }
  }

  /**
   * 工具目录变化：plugins.autoEnableNew=false 时，新上线插件不自动纳入
   * 已选工具面（只记日志）；默认 true 保持现行为（hub 策略决定暴露）。
   * 首个事件（启动扫描）作为基线，不算「新插件」。
   */
  private handleToolCatalogChange(): void {
    let currentIds: Set<string>;
    try {
      currentIds = new Set(this.hub.listAllTools().map((t) => t.pluginId));
    } catch {
      return;
    }
    const known = this.knownPluginIds;
    this.knownPluginIds = currentIds;
    if (!known) return;
    const fresh = [...currentIds].filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    const autoEnable = vscode.workspace
      .getConfiguration('atOpsAgent')
      .get<boolean>('plugins.autoEnableNew', true);
    if (autoEnable) return;
    this.log(
      `[hub] 新插件上线：${fresh.join(', ')}；plugins.autoEnableNew=false，不自动纳入已选工具面`
    );
    // 有显式选择且新插件工具混进了暴露面时剔除（保持原选择不变）；
    // 无显式选择（发现模式管理暴露面）只记通知，不强加选择。
    try {
      if (this.hub.selection.state().selected.length === 0) return;
      const freshSet = new Set(fresh);
      const exposed = this.hub.listExposedTools();
      const keep = exposed.filter((t) => !freshSet.has(t.pluginId)).map((t) => t.name);
      if (keep.length === exposed.length) return;
      void this.hub.selection
        .select({ names: keep, mode: 'replace' })
        .then(() =>
          this.log(`[hub] 已从当前选择剔除新插件工具 ${exposed.length - keep.length} 个`)
        )
        .catch((err) => this.log(`[hub] 剔除新插件工具失败: ${describeError(err)}`));
    } catch (err) {
      this.log(`[hub] autoEnableNew 处理失败: ${describeError(err)}`);
    }
  }

  snapshot(): HydrateEvt {
    const providers = this.safeProviders();
    const playbooks = this.playbookCache;
    const modelsPayload = this.chatModelsExtra();
    if (!playbooks) {
      // 不阻塞快照：后台预热缓存，下一次 hydrate 自然带上。
      void this.getPlaybooks().catch(() => {});
      return this.store.snapshot(providers, modelsPayload);
    }
    // webview 的 absorbCapabilities 从 providers 记录里取 playbooks；
    // 顶层字段同时下发，供后续消费方直接读取。
    const providersWithPlaybooks =
      typeof providers === 'object' && providers !== null && !Array.isArray(providers)
        ? { ...(providers as Record<string, unknown>), playbooks }
        : providers;
    return this.store.snapshot(providersWithPlaybooks, { playbooks, ...modelsPayload });
  }

  /** 聊天选择器 / hydrate 共用的模型清单（读 models.json，不含凭证）。 */
  private chatModelsExtra(): Partial<HydrateEvt> {
    const models = listConfiguredModels(this.modelsPath);
    const selected = pickSelectedModel(models, this.modelSelection);
    return {
      models,
      ...(selected !== undefined
        ? { model: selected.model, modelProvider: selected.provider }
        : {}),
      hasApiKey: this.hasApiKey,
      onboarded: models.length > 0,
      locale: vscode.env.language,
      ...(this.lastUsage !== undefined ? { usage: this.lastUsage } : {})
    };
  }

  private chatCapabilitiesPayload(): Record<string, unknown> {
    const extra = this.chatModelsExtra();
    return {
      providers: this.safeProviders(),
      ...extra,
      ...(this.playbookCache ? { playbooks: this.playbookCache } : {})
    };
  }

  private async bootstrapModelCatalog(): Promise<void> {
    await this.refreshModelKeyFlag();
    const models = listConfiguredModels(this.modelsPath);
    const selected = pickSelectedModel(models, this.modelSelection ?? readLastModel(this.agentDir));
    if (selected) this.modelSelection = { ...this.modelSelection, ...selected };
    this.broadcast('capabilities/snapshot', this.chatCapabilitiesPayload());
  }

  private async refreshModelKeyFlag(): Promise<void> {
    const before = this.hasApiKey;
    try {
      const key = await this.secrets.getLlmApiKey(this.modelSelection?.provider);
      this.hasApiKey = typeof key === 'string' && key.length > 0;
    } catch {
      this.hasApiKey = false;
    }
    if (this.hasApiKey !== before) this.statusEmitter.fire();
  }

  private resolveRuntimeModelPref(): { provider?: string; id?: string } | undefined {
    const models = listConfiguredModels(this.modelsPath);
    const selected = pickSelectedModel(models, this.modelSelection);
    if (!selected) return undefined;
    if (!this.modelSelection) this.modelSelection = selected;
    return { provider: selected.provider, id: selected.model };
  }

  private async listPlaybookCatalog(): Promise<
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

  // ── webview 请求路由 ───────────────────────────────────────────────────

  async handleRequest(type: string, payload: unknown): Promise<unknown> {
    switch (type) {
      case 'chat/prompt':
        return this.handlePrompt(payload as ChatPromptReq);
      case 'chat/abort':
        this.abort((payload as ChatAbortReq | undefined)?.mode ?? 'stop');
        return { ok: true };
      case 'chat/retry':
        return this.retryLastPrompt();
      case 'chat/export':
        return this.exportReport();
      case 'model/set':
        return this.setModel(payload as ModelSetReq);
      case 'playbook/start':
        return this.startPlaybook((payload as { playbookId: string }).playbookId);
      case 'playbook/advance':
        return this.advancePlaybook((payload as { stage?: string } | undefined)?.stage);
      case 'playbook/close':
        return this.closePlaybook();
      case 'playbook/escalate-select':
        return this.applyEscalateSelect();
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
      case 'session/list':
        return { sessions: this.sessionSummaries() };
      case 'session/new': {
        this.newSession();
        return { ok: true, sessionId: this.store.activeSessionId };
      }
      case 'session/switch': {
        const p = payload as { id?: string; sessionId?: string } | undefined;
        return this.switchSession(p?.id ?? p?.sessionId);
      }
      case 'settings/hydrate':
        return this.settingsSnapshot();
      case 'settings/open':
        return this.openSettingsPanel((payload as { tab?: string } | undefined)?.tab);
      case 'settings/patchConfig':
        return this.patchConfig(payload as SettingsPatchConfigReq);
      case 'mcp/get':
        return this.readMcpRedacted();
      case 'mcp/save':
        return this.saveMcp((payload as McpSaveReq | undefined)?.text);
      case 'settings/openJson':
        return this.openJson((payload as SettingsOpenJsonReq | undefined)?.kind);
      case 'history/toggle':
        // controller 侧 no-op：标题栏命令由 chatView 直接向 chat webview 发 evt。
        return { ok: true };
      case 'models/state':
        return this.modelsFormState();
      case 'models/save':
        return this.saveModelsFromSettings(payload);
      case 'models/test':
        return this.testModel(payload as ModelsTestReq);
      case 'models/fetch':
        return this.fetchModels(payload as ModelsFetchReq);
      case 'models/oauth': {
        const providerId = (payload as { providerId?: string } | undefined)?.providerId;
        return this.loginOAuth(typeof providerId === 'string' ? providerId : '');
      }
      case 'models/openFile':
        return this.openJson('models');
      case 'models/openAuth':
        return this.openJson('auth');
      case 'asset/pick':
        return this.pickAsset((payload as { query?: string } | undefined)?.query);
      case 'capabilities/refresh':
        return this.refreshCapabilities();
      case 'diagnose':
        return this.runDiagnose();
      case 'skill/open':
        return this.openSkill(payload as { name?: string; path?: string } | undefined);
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
      } else if (typeof attachment.text === 'string' && attachment.text.length > 0) {
        text += `\n\n[${attachment.label ?? attachment.kind}]\n${attachment.text}`;
      } else if (typeof attachment.uri === 'string') {
        text += `\n\n[附件] ${attachment.uri}`;
      }
    }
    if (text.trim().length === 0) return { accepted: false };
    const userItem = { kind: 'user' as const, id: randomUUID(), text };
    this.store.appendItem(userItem);
    this.broadcast('transcript/append', { item: userItem });
    return this.dispatchPrompt(text, req.mode);
  }

  /** chat/retry：重发最后一条用户消息（不重复追加 transcript 项）。 */
  private async retryLastPrompt(): Promise<{ accepted: boolean }> {
    const lastUser = [...this.store.items].reverse().find((i) => i.kind === 'user');
    if (!lastUser || lastUser.kind !== 'user' || lastUser.text.trim().length === 0) {
      return { accepted: false };
    }
    return this.dispatchPrompt(lastUser.text, undefined);
  }

  /**
   * prompt 统一派发：playbook 阶段推进 + L4 注入 → runtime.prompt。
   * atOpsAgent.sessions.maxParallel 目前只实现 1（单 runtime）：
   * 运行中再来的 prompt 由 pi 按 steer 语义并入当前轮；真正的第二个并行
   * runtime（查库 + 查主机各占一席）待 D-runtime 的多会话 API 落地后接线。
   */
  private async dispatchPrompt(
    text: string,
    mode: 'steer' | 'followUp' | undefined
  ): Promise<{ accepted: boolean }> {
    const runtime = await this.ensureRuntime();
    // playbook 阶段驱动 + 当前阶段 L4 注入在首次模型调用之前完成。
    await this.advancePlaybookForPrompt();
    this.markTurnStarted();
    void runtime.prompt(text, mode !== undefined ? { mode } : undefined).catch((err) => {
      this.log(`[runtime] prompt 失败: ${describeError(err)}`);
      this.emitAssistantNotice(`⚠ 模型调用失败：${describeError(err)}`);
      this.markTurnEnded();
    });
    return { accepted: true };
  }

  /**
   * 中止。mode='stop'（默认）：立即 abort 主会话并级联全部子代理；
   * mode='cancel'：软停——runtime 等当前 in-flight 工具结束后停止（保在途证据）。
   * 阻塞派发中挂起的审批在 stop 时一并按拒绝决议，避免 execute 悬挂。
   */
  abort(mode: 'cancel' | 'stop' = 'stop'): void {
    if (mode === 'stop') {
      for (const [briefId] of this.approvalWaiters) {
        this.resolveApprovalWaiter(briefId, 'rejected');
      }
      for (const taskId of [...this.activeSubagentTaskIds]) {
        this.abortSubagentTask(taskId, { keepMainSession: true });
      }
    }
    try {
      this.runtime?.abort(mode);
    } catch (err) {
      this.log(`[runtime] abort 失败: ${describeError(err)}`);
    }
  }

  async setModel(req: ModelSetReq): Promise<{ ok: boolean }> {
    this.modelSelection = req;
    void patchAgentSettings(this.agentDir, {
      lastModel: { provider: req.provider, model: req.model }
    }).catch((err) => this.log(`[models] 持久化 lastModel 失败: ${describeError(err)}`));
    void this.refreshModelKeyFlag();
    // 真 runtime 的模型在创建期绑定：空闲时释放实例，下次 prompt 按新模型
    // 重建并经 resumeSessionFile 续接同一会话（P0-C 不失忆）。
    if (this.runtime) {
      this.scheduleRuntimeRebuild(`切换模型 ${req.provider}/${req.model}`);
    }
    this.broadcast('capabilities/snapshot', this.chatCapabilitiesPayload());
    return { ok: true };
  }

  newSession(): void {
    this.store.newSession();
    this.resetSessionScopedState();
    this.broadcast('hydrate', this.snapshot());
  }

  /**
   * 切换会话：store 恢复目标会话的内存包（transcript / 简报 / 时间线），
   * controller 侧会话态（审批引用、playbook run、runtime）全部重置——
   * 审批令牌绑定 sessionId，跨会话绝不复用。切换后广播 hydrate。
   */
  switchSession(id: string | undefined): { ok: boolean } {
    if (typeof id !== 'string' || id.length === 0) return { ok: false };
    if (id === this.store.activeSessionId) return { ok: true };
    if (!this.store.switchSession(id)) return { ok: false };
    this.resetSessionScopedState();
    this.broadcast('hydrate', this.snapshot());
    return { ok: true };
  }

  /** newSession / switchSession 共用：清空绑定旧会话的运行态。 */
  private resetSessionScopedState(): void {
    for (const [briefId] of this.approvalWaiters) {
      this.resolveApprovalWaiter(briefId, 'rejected');
    }
    this.selectCountThisTask = 0;
    this.briefRuns.clear();
    this.briefHashes.clear();
    this.sessionReadAllowlist.clear();
    this.currentApproval = null;
    this.activeRun = undefined;
    this.lastUsage = undefined;
    this.guidedNoticeRuns.clear();
    this.activeSubagentTaskIds.clear();
    this.lastLayerKey = undefined;
    this.lastLayerRuntime = undefined;
    this.pendingRebuildReason = undefined;
    this.markTurnEnded();
    this.disposeRuntime();
  }

  private sessionSummaries(): SessionSummary[] {
    return this.store.sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt }));
  }

  // ── 运行态（context key + 空闲重建） ────────────────────────────────────

  private markTurnStarted(): void {
    this.runtimeBusy = true;
    this.setRunningContext(true);
  }

  private markTurnEnded(): void {
    this.runtimeBusy = false;
    this.setRunningContext(false);
    if (this.pendingRebuildReason !== undefined) {
      const reason = this.pendingRebuildReason;
      this.pendingRebuildReason = undefined;
      this.rebuildRuntimeNow(reason);
    }
  }

  private setRunningContext(value: boolean): void {
    if (this.runningContext === value) return;
    this.runningContext = value;
    void vscode.commands.executeCommand('setContext', 'atOpsAgent.running', value);
  }

  /**
   * P1-15：重建 runtime 只在会话 idle 时进行；运行中先挂起，
   * idle 事件到达后统一释放。释放后的下一次 prompt 以 resumeSessionFile
   * 续接同一 pi JSONL 重建（不丢上下文）。
   */
  private scheduleRuntimeRebuild(reason: string): void {
    if (this.runtimeBusy) {
      this.pendingRebuildReason = reason;
      this.log(`[runtime] ${reason}：会话进行中，等 idle 后重建`);
      return;
    }
    this.rebuildRuntimeNow(reason);
  }

  private rebuildRuntimeNow(reason: string): void {
    if (!this.runtime) return;
    this.log(`[runtime] ${reason}：释放当前 runtime，下次 prompt 续接重建`);
    this.disposeRuntime();
  }

  // ── 设置页 ─────────────────────────────────────────────────────────────

  /** 技能清单缓存：refresh 命令 / 设置页刷新时失效重扫。 */
  private skillsCache: SkillInfo[] | undefined;

  refreshSkills(): void {
    this.skillsCache = undefined;
  }

  /** settings/hydrate：设置页全量快照（不含任何明文凭证；skills 恒为空）。 */
  async settingsSnapshot(): Promise<SettingsSnapshot> {
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const configValues: Record<string, unknown> = {};
    for (const key of KNOWN_CONFIG_KEYS) configValues[key] = config.get(key);
    return {
      config: configValues,
      modelsPath: this.modelsPath,
      agentDir: this.agentDir,
      capabilities: this.safeProviders(),
      // 内置技能目录（listSkills）只服务 skill/open 路径校验与 ops 内部，不进 UI。
      skills: [],
      sessions: this.sessionSummaries(),
      mcp: await this.readMcpRedacted(),
      pendingApprovals: this.store.pendingBriefs.length
    };
  }

  /** settings/open（chat webview 深链）：打开设置页并聚焦指定页签。 */
  private async openSettingsPanel(tab: string | undefined): Promise<{ ok: boolean }> {
    try {
      await vscode.commands.executeCommand(
        tab === 'models' ? 'atOpsAgent.openModels' : 'atOpsAgent.openSettings'
      );
      return { ok: true };
    } catch (err) {
      this.log(`[settings] 打开设置页失败: ${describeError(err)}`);
      return { ok: false };
    }
  }

  private async modelsFormState(): Promise<Record<string, unknown>> {
    const state = await readModelsFormState({
      modelsPath: this.modelsPath,
      agentDir: this.agentDir,
      secrets: this.secrets
    });
    return { ...state };
  }

  private async saveModelsFromSettings(payload: unknown): Promise<{
    ok: boolean;
    error?: string;
    state?: Record<string, unknown>;
  }> {
    const outcome = await saveModelsForm(
      { modelsPath: this.modelsPath, agentDir: this.agentDir, secrets: this.secrets },
      isPlainRecord(payload) ? payload : {}
    );
    if (outcome.error !== undefined) {
      return { ok: false, error: outcome.error };
    }
    if (outcome.applied) {
      try {
        await this.setModel(outcome.applied);
      } catch (err) {
        this.log(`[models] setModel 同步失败: ${describeError(err)}`);
      }
    }
    await this.refreshModelKeyFlag();
    this.broadcast('capabilities/snapshot', this.chatCapabilitiesPayload());
    this.broadcast('hydrate', this.snapshot());
    // 保存后立刻重建 runtime，避免聊天仍走「未配置模型」的 Fallback。
    void this.ensureRuntime().catch((err) =>
      this.log(`[runtime] 保存模型后重建失败: ${describeError(err)}`)
    );
    return { ok: true, state: await this.modelsFormState() };
  }

  /**
   * models/test（P0-B「保存并测试」）：GET /models，404/405 退 1-token
   * chat completion。key 取 payload（表单未存态）或 SecretStorage 按 provider；
   * 错误信息已在 modelsProbe 分类脱敏，key 绝不落日志。
   */
  private async testModel(req: ModelsTestReq): Promise<ModelsTestRes> {
    const baseUrl = typeof req?.baseUrl === 'string' ? req.baseUrl.trim() : '';
    if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };
    const apiKey =
      typeof req.apiKey === 'string' && req.apiKey.length > 0
        ? req.apiKey
        : await this.secrets.getLlmApiKey(req.provider).catch(() => undefined);
    const result = await probeOpenAiCompatible({
      baseUrl,
      ...(typeof req.modelId === 'string' ? { modelId: req.modelId } : {}),
      ...(apiKey !== undefined ? { apiKey } : {})
    });
    this.log(
      `[models] 连通性测试 ${result.ok ? '通过' : '失败'}` +
        (result.latencyMs !== undefined ? `（${result.latencyMs}ms）` : '') +
        (result.error !== undefined ? `：${result.error}` : '')
    );
    return result;
  }

  /** models/fetch（P1-1）：GET /models 拉模型目录，供设置页下拉选择。 */
  private async fetchModels(req: ModelsFetchReq): Promise<ModelsFetchRes> {
    const baseUrl = typeof req?.baseUrl === 'string' ? req.baseUrl.trim() : '';
    if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };
    const apiKey =
      typeof req.apiKey === 'string' && req.apiKey.length > 0
        ? req.apiKey
        : await this.secrets.getLlmApiKey(req.provider).catch(() => undefined);
    return fetchModelCatalog({ baseUrl, ...(apiKey !== undefined ? { apiKey } : {}) });
  }

  private async refreshCapabilities(): Promise<SettingsSnapshot> {
    try {
      await this.hub.refresh();
    } catch (err) {
      this.log(`[hub] refresh 失败: ${describeError(err)}`);
    }
    this.refreshSkills();
    return this.settingsSnapshot();
  }

  private async runDiagnose(): Promise<{ ok: boolean }> {
    await diagnoseHub({ hostApp: this.hub.hostApp, hub: this.hub, output: this.output });
    this.output.show(true);
    return { ok: true };
  }

  private async openSkill(
    payload: { name?: string; path?: string } | undefined
  ): Promise<{ ok: boolean; error?: string }> {
    const skills = this.skillsCache ?? (await listSkills(this.extensionPath));
    this.skillsCache = skills;
    const requestedPath = typeof payload?.path === 'string' ? payload.path : undefined;
    const requestedName = typeof payload?.name === 'string' ? payload.name : undefined;
    const hit = skills.find(
      (s) =>
        (requestedPath !== undefined && s.skillFile === requestedPath) ||
        (requestedName !== undefined && (s.label === requestedName || s.skillFile === requestedName))
    );
    if (!hit) {
      return { ok: false, error: '未找到该技能文件' };
    }
    const skillsRoot = path.join(this.extensionPath, 'skills');
    const resolved = path.resolve(hit.skillFile);
    if (!resolved.startsWith(path.resolve(skillsRoot))) {
      return { ok: false, error: '技能路径越界' };
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(doc, { preview: true });
    return { ok: true };
  }

  /** settings/patchConfig：只接受 atOpsAgent.* 已知键，写用户级配置。 */
  private async patchConfig(req: SettingsPatchConfigReq): Promise<{ ok: boolean; error?: string }> {
    const key = typeof req?.key === 'string' ? req.key.replace(/^atOpsAgent\./, '') : '';
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      return { ok: false, error: `未知配置键 "${key}"（只允许 atOpsAgent.* 已知键）` };
    }
    try {
      await vscode.workspace
        .getConfiguration('atOpsAgent')
        .update(key, req.value, vscode.ConfigurationTarget.Global);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  private mcpPath(): string {
    return path.join(this.agentDir, 'mcp.json');
  }

  /** mcp/get：读 ~/.at-series/agent/mcp.json，env/header/bearer 值一律脱敏为 ***。 */
  async readMcpRedacted(): Promise<SettingsSnapshot['mcp']> {
    const filePath = this.mcpPath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        path: filePath,
        exists: false,
        text: MCP_TEMPLATE,
        ...(missing ? {} : { error: describeError(err) })
      };
    }
    try {
      const redacted = redactMcpConfig(JSON.parse(raw));
      return { path: filePath, exists: true, text: `${JSON.stringify(redacted, null, 2)}\n` };
    } catch {
      // 坏 JSON 无法可靠脱敏：绝不回传原文（可能含明文凭证）。
      return {
        path: filePath,
        exists: true,
        text: '',
        error: 'mcp.json 不是合法 JSON，无法脱敏预览；请用「打开 mcp.json」在编辑器修复。'
      };
    }
  }

  /**
   * mcp/save：写回 mcp.json（0600）。webview 提交的 *** 占位值从现有文件
   * 回填，真实凭证不经过 webview 往返；内容与凭证一律不落日志。
   * AT 系列 hub.js 项照存——运行时由 filterMcpServers 跳过，绝不 spawn。
   */
  private async saveMcp(text: string | undefined): Promise<{ ok: boolean; error?: string }> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'mcp.json 内容不能为空。' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `不是合法 JSON：${describeError(err)}` };
    }
    if (!isPlainRecord(parsed)) return { ok: false, error: 'mcp.json 根节点必须是对象。' };
    let existing: unknown;
    try {
      existing = JSON.parse(await fs.readFile(this.mcpPath(), 'utf8'));
    } catch {
      existing = undefined;
    }
    const merged = restoreRedactedMcpValues(parsed, existing);
    try {
      await fs.mkdir(this.agentDir, { recursive: true });
      await fs.writeFile(this.mcpPath(), `${JSON.stringify(merged, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    this.log('[mcp] 已保存 mcp.json（内容不落日志）');
    return { ok: true };
  }

  /** settings/openJson：在编辑器打开配置文件；kind=vscode 走原生设置页。 */
  private async openJson(
    kind: SettingsOpenJsonReq['kind'] | undefined
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (kind) {
        case 'models':
          await openModelsJson({ modelsPath: this.modelsPath, output: this.output });
          return { ok: true };
        case 'auth':
          await openAuthJson(this.agentDir);
          return { ok: true };
        case 'mcp': {
          await fs.mkdir(this.agentDir, { recursive: true });
          try {
            await fs.access(this.mcpPath());
          } catch {
            await fs.writeFile(this.mcpPath(), MCP_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
          }
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.mcpPath()));
          await vscode.window.showTextDocument(doc, { preview: false });
          return { ok: true };
        }
        case 'vscode':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'atOpsAgent');
          return { ok: true };
        default:
          return { ok: false, error: `未知 openJson kind "${String(kind)}"` };
      }
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  // ── asset/pick ─────────────────────────────────────────────────────────

  /**
   * asset/pick：QuickPick 选一条要附进 Composer 的素材——
   * 最近证据便签（透传摘要文本）+ 工作区文件（透传 uri，由 prompt 侧引用）。
   * 大文件内容不在这里读：附件只带 uri/标签，模型按需经工具读取。
   */
  private async pickAsset(query?: string): Promise<AssetPickRes> {
    type PickItem = vscode.QuickPickItem & { asset: AssetPickRes['items'][number] };
    const items: PickItem[] = [];

    const evidence = this.store.items
      .filter((i): i is Extract<TranscriptItem, { kind: 'evidence' }> => i.kind === 'evidence')
      .slice(-5)
      .reverse();
    for (const item of evidence) {
      const summary = item.note.summary.replace(/\s+/g, ' ').trim();
      items.push({
        label: `$(beaker) ${summary.slice(0, 60)}`,
        description: `证据 · ${item.note.taskId}`,
        asset: {
          kind: 'evidence',
          label: summary.slice(0, 60),
          text: `[证据 ${item.note.taskId} / ${item.note.confidence}] ${summary}`
        }
      });
    }

    try {
      const pattern = typeof query === 'string' && query.trim().length > 0 ? `**/*${query.trim()}*` : '**/*';
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 30);
      for (const uri of files) {
        const rel = vscode.workspace.asRelativePath(uri);
        items.push({
          label: `$(file) ${rel}`,
          description: '工作区文件',
          asset: { kind: 'file', label: rel, text: `[附件] ${rel}`, uri: uri.toString() }
        });
      }
    } catch (err) {
      this.log(`[asset/pick] findFiles 失败: ${describeError(err)}`);
    }

    if (items.length === 0) return { items: [] };
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要附加到对话的素材（证据 / 工作区文件）',
      matchOnDescription: true
    });
    return { items: picked ? [picked.asset] : [] };
  }

  // ── chat/export ────────────────────────────────────────────────────────

  /**
   * chat/export（P1-10）：当前会话 → Markdown 值班报告。
   * showSaveDialog 选路径；取消时落系统临时目录，两种路径都会在编辑器打开。
   * 报告绝不包含审批令牌 / API key。
   */
  async exportReport(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const session = this.store.sessions.find((s) => s.id === this.store.activeSessionId);
    const markdown = buildOpsReportMarkdown({
      sessionId: this.store.activeSessionId,
      ...(session !== undefined ? { sessionTitle: session.title } : {}),
      ...(this.store.playbook !== undefined ? { playbook: this.store.playbook } : {}),
      items: this.store.items,
      timeline: this.store.timeline,
      pendingBriefs: this.store.pendingBriefs
    });
    const fileName = exportReportFileName();
    let target: vscode.Uri | undefined;
    try {
      target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)),
        filters: { Markdown: ['md'] },
        title: '导出值班报告'
      });
    } catch {
      target = undefined;
    }
    const filePath = target?.fsPath ?? path.join(os.tmpdir(), fileName);
    try {
      await fs.writeFile(filePath, markdown, 'utf8');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      this.log(`[export] 值班报告已导出：${filePath}`);
      return { ok: true, path: filePath };
    } catch (err) {
      this.log(`[export] 导出失败: ${describeError(err)}`);
      return { ok: false, error: describeError(err) };
    }
  }

  // ── playbook / 审批 ────────────────────────────────────────────────────

  async getPlaybooks(): Promise<PlaybookMeta[]> {
    return this.loadPlaybookCache();
  }

  private async loadPlaybookCache(): Promise<Playbook[]> {
    if (this.playbookCache) return this.playbookCache;
    try {
      this.playbookCache = this.core.loadPlaybooks(this.playbooksDir);
    } catch (err) {
      this.log(`[orchestrator] loadPlaybooks 失败: ${describeError(err)}`);
      this.playbookCache = [];
    }
    return this.playbookCache;
  }

  async startPlaybook(
    playbookId: string,
    opts?: { advance?: boolean }
  ): Promise<{ ok: boolean; stage?: string; error?: string }> {
    if (typeof playbookId !== 'string' || playbookId.length === 0) {
      return { ok: false, error: 'playbookId 不能为空' };
    }
    if (opts?.advance && this.activeRun) {
      return {
        ok: false,
        error: `已有进行中的 playbook ${this.activeRun.playbookId}，不要叠加启动`
      };
    }
    const orchestrator = await this.ensureOrchestrator();
    let run: PlaybookRunLike;
    try {
      run = orchestrator.startPlaybook(playbookId, this.store.activeSessionId);
    } catch (err) {
      this.log(`[orchestrator] startPlaybook 失败: ${describeError(err)}`);
      return { ok: false, error: describeError(err) };
    }
    this.selectCountThisTask = 0;
    this.activeRun = run;
    // playbook/stage 事件已在 startPlaybook 内同步发出（store 已更新）。
    // 真编排从 triage 起步，select 在首条用户消息推进到 selecting 时代发。
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
    // 主代理在对话中途启动链路时立即推进阶段并注入 L4；UI 手动选择仍等下一条消息。
    if (opts?.advance) {
      await this.advancePlaybookForPrompt();
    }
    return { ok: true, stage: this.store.playbook?.stage ?? stage };
  }

  /** ops_advance_stage / playbook/advance：显式推进阶段（缺省走主线迁移）。 */
  async advancePlaybook(stage?: string): Promise<{ ok: boolean; stage?: string; error?: string }> {
    const run = this.activeRun;
    if (!run) return { ok: false, error: '没有进行中的 playbook run' };
    await this.ensureOrchestrator();
    const current = this.currentStage(run);
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

  /** ops_close_playbook / playbook/close：收尾到 closed 并解除 activeRun。 */
  async closePlaybook(): Promise<{ ok: boolean; stage?: string; error?: string }> {
    const run = this.activeRun;
    if (!run) return { ok: false, error: '没有进行中的 playbook run' };
    await this.ensureOrchestrator();
    let stage = this.currentStage(run);
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
    this.activeRun = undefined;
    this.selectCountThisTask = 0;
    return { ok: true, stage };
  }

  /**
   * playbook/escalate-select：把当前阶段 yaml 的 escalateSelect（mode=add）
   * 应用到 hub.selection。首轮 investigating 之后 host 绝不自动调用——
   * 扩面由用户/模型显式请求驱动。
   */
  async applyEscalateSelect(): Promise<{ ok: boolean; reason?: string }> {
    const run = this.activeRun;
    if (!run) return { ok: false, reason: '没有进行中的 playbook run' };
    const orchestrator = await this.ensureOrchestrator();
    let desired = orchestrator.desiredEscalateSelect?.(run);
    if (!desired) {
      // orchestrator 未实现时退回 playbook 元数据（同一 yaml 真源）。
      const playbookId = this.store.playbook?.id ?? run.playbookId;
      const stage = this.currentStage(run);
      const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
      desired = meta?.stages?.find((s) => s.id === stage)?.escalateSelect;
    }
    if (!desired) return { ok: false, reason: '当前阶段没有 escalateSelect 定义' };
    try {
      await this.hub.selection.select({ ...desired, mode: 'add' });
      this.selectCountThisTask += 1;
      orchestrator.recordSelect?.(run);
      this.log(
        `[hub] escalateSelect 已应用（${(desired.pluginIds ?? desired.names ?? []).join(', ')}）`
      );
      return { ok: true };
    } catch (err) {
      this.log(`[hub] escalateSelect 失败: ${describeError(err)}`);
      return { ok: false, reason: describeError(err) };
    }
  }

  /**
   * 用户审批决议（webview ApprovalBar / 命令面板）：
   * - 先签发 HMAC 令牌（approved 时；token 只存 host 内存，模型不可见）；
   * - 有 playbook run 的简报再走 orchestrator.applyApproval（推进状态机）；
   * - 最后决议阻塞派发的等待者：runtime 在同一 execute 内继续/拒绝该调用。
   * 旧的非阻塞路径（简报存在但没有等待者）在批准后 followUp 提示模型重试。
   */
  async applyApproval(req: ApprovalRespondReq): Promise<{ ok: boolean }> {
    if (typeof req?.briefId !== 'string') return { ok: false };
    const runId = this.briefRuns.get(req.briefId) ?? '';
    // approval/resolved 事件会同步清 briefHashes，先取哈希。
    const commandSetSha256 = this.briefHashes.get(req.briefId);
    // 令牌必须在等待者决议 / orchestrator.applyApproval 之前就位：
    // 放行后的同一命令集重试要经 policy 的 approval 校验命中。
    if (req.decision === 'approved') {
      if (commandSetSha256 !== undefined) {
        this.currentApproval = {
          briefId: req.briefId,
          commandSetSha256,
          token: issueApprovalToken(
            req.briefId,
            commandSetSha256,
            this.store.activeSessionId,
            this.approvalSecret
          )
        };
      }
    } else {
      this.currentApproval = null;
    }
    if (runId.length > 0) {
      try {
        const orchestrator = await this.ensureOrchestrator();
        orchestrator.applyApproval({
          brief: { briefId: req.briefId, runId },
          decision: req.decision
        });
      } catch (err) {
        this.log(`[orchestrator] applyApproval 失败: ${describeError(err)}`);
      }
    }
    // 事件路径（approval/resolved）已清理时为幂等 no-op。
    if (this.store.resolveBrief(req.briefId)) {
      this.broadcast('approval/resolve', { briefId: req.briefId, decision: req.decision });
    }
    this.briefRuns.delete(req.briefId);
    this.briefHashes.delete(req.briefId);
    this.store.appendTimeline({ kind: 'approval', briefId: req.briefId, decision: req.decision });

    const hadWaiter = this.resolveApprovalWaiter(req.briefId, req.decision);
    if (!hadWaiter && req.decision === 'approved' && this.runtime) {
      // 非阻塞旧路径：模型此前已收到结构化拒绝，批准后 followUp 提示继续。
      void this.runtime
        .prompt('审批已通过，请继续执行刚才被拦截的操作（同一命令集）。', { mode: 'followUp' })
        .catch((err) => this.log(`[runtime] 审批 followUp 失败: ${describeError(err)}`));
    }
    return { ok: true };
  }

  /** 决议阻塞派发等待者；返回是否存在等待者。 */
  private resolveApprovalWaiter(briefId: string, decision: 'approved' | 'rejected'): boolean {
    const waiter = this.approvalWaiters.get(briefId);
    if (!waiter) return false;
    this.approvalWaiters.delete(briefId);
    waiter.resolve(decision);
    return true;
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

  /** 阶段进入钩子：注入 L4、guidedManual 提示。子代理由主代理 ops_dispatch_subagent 派发，绝不在此自动下发。 */
  private handleStageEntered(runId: string, playbookId: string, stage: string): void {
    void this.injectStageLayer(playbookId, stage);
    void this.maybeEmitGuidedManualNotice(runId, playbookId, stage).catch((err) =>
      this.log(`[guidedManual] 提示失败: ${describeError(err)}`)
    );
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

  /** 子代理产出的 evidence-note@1 → transcript 证据卡片 + 看板时间线。 */
  private appendEvidenceNote(note: {
    taskId: string;
    confidence: 'confirmed' | 'hypothesis' | 'pending';
    summary: string;
    refs?: Array<{ kind: string; preview: string; artifactUri?: string }>;
  }): void {
    if (typeof note.taskId !== 'string' || typeof note.summary !== 'string') return;
    const view: EvidenceNoteView = {
      taskId: note.taskId,
      confidence: isEvidenceConfidence(note.confidence) ? note.confidence : 'pending',
      summary: note.summary,
      refs: Array.isArray(note.refs)
        ? note.refs.map((ref) => ({
            kind: String(ref.kind ?? 'note'),
            preview: String(ref.preview ?? ''),
            ...(typeof ref.artifactUri === 'string' ? { artifactUri: ref.artifactUri } : {})
          }))
        : []
    };
    const item = { kind: 'evidence' as const, id: randomUUID(), note: view };
    this.store.appendItem(item);
    this.broadcast('transcript/append', { item });
    this.store.appendTimeline({
      kind: 'evidence',
      taskId: view.taskId,
      confidence: view.confidence,
      summary: view.summary
    });
  }

  /** 更新或创建子代理卡片并广播；主代理 ops_dispatch_subagent 派发时没有事先 queued 卡。 */
  private patchSubagentCard(
    taskId: string | undefined,
    status?: string,
    latest?: string,
    role?: string
  ): void {
    if (!taskId) return;
    const existing = this.store.getSubagent(taskId);
    const nextRole = isSubagentRole(role) ? role : existing?.role ?? 'investigator';
    const next: SubagentCard = existing
      ? {
          ...existing,
          role: nextRole,
          status: isSubagentStatus(status) ? status : existing.status,
          ...(latest !== undefined ? { latest } : {})
        }
      : {
          taskId,
          role: nextRole,
          label: latest && latest.length > 0 ? latest : nextRole,
          status: isSubagentStatus(status) ? status : 'queued',
          riskCeiling: nextRole === 'executor' ? 'exec' : 'read',
          toolCalls: { used: 0, max: 15 },
          wallMs: { used: 0, max: 180_000 },
          ...(latest !== undefined ? { latest } : {})
        };
    this.store.upsertSubagent(next);
    this.broadcast('subagent/upsert', next);
    if (next.status === 'queued' || next.status === 'running') {
      this.activeSubagentTaskIds.add(taskId);
    } else {
      this.activeSubagentTaskIds.delete(taskId);
    }
  }

  // ── L4 注入 ────────────────────────────────────────────────────────────

  /**
   * 阶段迁移时整体替换 L4，经 core.buildSystemPrompt 与 L0–L2 合成后
   * setSystemPrompt——host 绝不用裸 L4 覆盖红线层。
   */
  private async injectStageLayer(playbookId: string, stage: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.setSystemPrompt) return;
    const key = `${playbookId}:${stage}`;
    if (this.lastLayerKey === key && this.lastLayerRuntime === runtime) return;
    const seq = ++this.stageLayerSeq;
    try {
      const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
      const layer = await this.layerSource.stageLayer(meta, playbookId, stage);
      if (seq !== this.stageLayerSeq || this.runtime !== runtime) return; // 已有更新的注入
      runtime.setSystemPrompt(this.core.buildSystemPrompt({ playbookLayer: layer }));
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

  /** skill/run：内置技能无用户可见入口，收到请求只记日志（无害 no-op）。 */
  private runSkill(name?: string): { ok: boolean } {
    if (typeof name !== 'string' || name.length === 0) return { ok: false };
    this.log(`[skill] 收到 skill/run ${name}（技能由模型按需读取，UI 不再提供入口）`);
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
    for (const [briefId] of this.approvalWaiters) {
      this.resolveApprovalWaiter(briefId, 'rejected');
    }
    this.hubSub.dispose();
    this.timelineSub.dispose();
    this.disposeRuntime();
    this.orchestrator?.dispose?.();
    this.orchestrator = undefined;
    this.uiEmitter.dispose();
    this.boardEmitter.dispose();
    this.statusEmitter.dispose();
  }

  // ── 内部：创建 ─────────────────────────────────────────────────────────

  private async createRuntime(): Promise<RuntimeLike> {
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const sessionId = this.store.activeSessionId;
    const handlers: OpsRuntimeHandlers = {
      hub: this.hub,
      beforeToolCall: (ctx) => this.gateToolCall(ctx.toolName, ctx.args, ctx.origin),
      // P0-D 阻塞派发：needSessionApproval 时 runtime 在同一 execute 内
      // await 本回调；批准继续同一调用，无需模型重试。
      requestApproval: (input) => this.resolveSessionApproval(input),
      onEvent: (e) => this.onRuntimeEvent(e),
      onSubagentEvent: (e) => {
        this.patchSubagentCard(e.taskId, e.status, e.summary ?? e.error, e.role);
        if (e.evidenceNote) this.appendEvidenceNote(e.evidenceNote);
      },
      // pi 会话无法追加新 ToolDefinition：目录需要重建时等 idle 释放，
      // 下一次 prompt 以最新工具目录 + resumeSessionFile 续接重建。
      onCatalogNeedsRebuild: () => this.scheduleRuntimeRebuild('工具目录出现新工具'),
      playbooks: {
        list: () => this.listPlaybookCatalog(),
        start: async (playbookId: string) => {
          const result = await this.startPlaybook(playbookId, { advance: true });
          return result.ok
            ? { ok: true, ...(result.stage !== undefined ? { stage: result.stage } : {}) }
            : { ok: false, error: result.error ?? '无法启动 playbook' };
        },
        advance: (stage?: string) => this.advancePlaybook(stage),
        close: () => this.closePlaybook()
      }
    };
    // per-role 模型映射（settings.json roleModels；C 提供 UI）。
    // D-runtime 落地 roleModels 选项前多余字段会被忽略——行为不劣于现状。
    const roleModels = normalizeRoleModels((await readAgentSettings(this.agentDir)).roleModels);
    const resumeSessionFile = this.store.sessionFileOf(sessionId);
    // 变量承载（避免字面量多余属性检查）：runtime 未落地 roleModels 前忽略该字段。
    const options: CreateOpsRuntimeOptions & {
      roleModels?: ReturnType<typeof normalizeRoleModels>;
    } = {
      agentDir: this.agentDir,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      model: this.resolveRuntimeModelPref(),
      // 按 provider 取 key（缺省用当前选中模型的 provider；旧键自动回退）。
      getApiKey: (providerId?: string) =>
        Promise.resolve(this.secrets.getLlmApiKey(providerId ?? this.modelSelection?.provider)),
      bundledSkillsDir: path.join(this.extensionPath, 'skills'),
      thinkingLevel: await this.resolveThinkingLevel(config),
      workspaceShellEnabled: config.get<boolean>('workspaceShell.enabled', false),
      ...(resumeSessionFile !== undefined ? { resumeSessionFile } : {}),
      ...(Object.keys(roleModels).length > 0 ? { roleModels } : {})
    };
    let runtime: RuntimeLike;
    try {
      // 真 runtime 创建期内部兜底（缺 key → 自带 FallbackRuntime），不抛出。
      runtime = await this.core.createRuntime(handlers, options);
      this.log('[runtime] createOpsRuntime 完成');
    } catch (err) {
      this.log(`[runtime] createOpsRuntime 失败（${describeError(err)}），使用兜底 runtime`);
      runtime = this.core.createFallbackRuntime(handlers, describeError(err));
    }
    this.runtime = runtime;
    // P0-C：记录本会话的 pi JSONL，重建 / 重载后续接同一会话。
    if (typeof runtime.sessionFile === 'string' && runtime.sessionFile.length > 0) {
      this.store.setSessionFile(sessionId, runtime.sessionFile);
    }
    return runtime;
  }

  private async createOrchestrator(): Promise<OrchestratorLike> {
    const playbooks = await this.loadPlaybookCache();
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const orchestrator: OrchestratorLike = this.core.createOrchestrator({
      playbooks,
      maxParallel: config.get<number>('subagent.maxParallel', 3),
      onEvent: (e: OrchestratorEventLike) => this.onOrchestratorEvent(e)
    });
    this.log(`[orchestrator] createOrchestrator 完成（${playbooks.length} 条 playbook）`);
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

  /** 思考等级：会话内 model/set → agentDir settings.json → 配置默认（medium）。 */
  private async resolveThinkingLevel(config: vscode.WorkspaceConfiguration): Promise<ThinkingLevel> {
    if (this.modelSelection?.thinkingLevel) return this.modelSelection.thinkingLevel;
    const fromSettings = normalizeThinkingLevel(
      (await readAgentSettings(this.agentDir)).thinkingLevel
    );
    if (fromSettings) return fromSettings;
    return (
      normalizeThinkingLevel(config.get<string>('models.defaultThinkingLevel', 'medium')) ??
      'medium'
    );
  }

  /**
   * Models 面板 OAuth 页入口：优先 runtime.loginOAuth（已创建且支持时），
   * 否则 host 直驱 pi ModelRuntime.login（src/host/oauthLogin.ts）。
   * 结果消息绝不含 token。
   */
  async loginOAuth(providerId: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = typeof providerId === 'string' ? providerId.trim() : '';
    if (trimmed.length === 0) return { ok: false, message: '请先填写 provider id。' };
    const runtime = this.runtime;
    if (runtime?.loginOAuth) {
      try {
        await runtime.loginOAuth(trimmed);
        return { ok: true, message: `OAuth 登录完成（${trimmed}），凭证已写入 auth.json。` };
      } catch (err) {
        this.log(`[oauth] runtime.loginOAuth 失败: ${describeError(err)}，改走 host 直驱`);
      }
    }
    return loginOAuthViaPi({ providerId: trimmed, agentDir: this.agentDir, log: (m) => this.log(m) });
  }

  // ── 权限闸（policy.evaluate 装配点） ──────────────────────────────────

  private async gateToolCall(
    toolName: string,
    args: Record<string, unknown>,
    origin?: ToolCallOrigin
  ): Promise<{ block: boolean; reason?: string; needSessionApproval?: boolean; risk?: 'write' | 'exec' }> {
    try {
      const descriptor = this.hub.listAllTools().find((t) => t.name === toolName);
      // ops_* 发现工具视为 read；未知业务工具 fail-closed 为 exec。
      const risk = descriptor?.risk ?? (toolName.startsWith('ops_') ? 'read' : 'exec');
      const config = vscode.workspace.getConfiguration('atOpsAgent');
      // 变量承载（非字面量）：policy 增加 sessionReadAllowlist 字段前多余
      // 属性被忽略，落地后即刻生效（read 且命中 → 免审）。
      const ctx: PolicyContext & { sessionReadAllowlist?: string[] } = {
        toolName,
        args,
        risk,
        ...(descriptor?.pluginId !== undefined ? { pluginId: descriptor.pluginId } : {}),
        ...(this.store.playbook?.stage !== undefined ? { stage: this.store.playbook.stage } : {}),
        ...(origin?.kind === 'subagent' && SUBAGENT_POLICY_ROLES.has(origin.role)
          ? { role: origin.role as PolicyContext['role'] }
          : {}),
        ...(origin?.kind === 'subagent' && RISK_LEVELS.has(origin.riskCeiling)
          ? { riskCeiling: origin.riskCeiling as PolicyContext['riskCeiling'] }
          : {}),
        approval: this.approvalForOrigin(origin),
        sessionRequiredFor: config.get<'write-exec' | 'exec-only' | 'never'>(
          'approval.sessionRequiredFor',
          'write-exec'
        ),
        selectCountThisTask: this.selectCountThisTask,
        sessionReadAllowlist: this.readToolAllowlist()
      };
      const decision = this.core.evaluatePolicy(ctx);
      if (decision.block) {
        this.log(`[policy] ${toolName} 被拒: ${decision.code} ${decision.reason}`);
        return { block: true, reason: `${decision.code}: ${decision.reason}` };
      }
      if (SELECT_TOOL_NAMES.has(toolName)) {
        this.selectCountThisTask += 1;
      }
      if (decision.needSessionApproval) {
        // 会话审批闭环：runtime 在同一 execute 内 await requestApproval。
        return {
          block: false,
          needSessionApproval: true,
          risk: risk === 'exec' ? 'exec' : 'write',
          reason: decision.reason
        };
      }
      return { block: false };
    } catch (err) {
      // 闸门自身出错必须 fail-closed。
      this.log(`[policy] evaluate 异常，fail-closed: ${describeError(err)}`);
      return { block: true, reason: `策略闸异常，已按拒绝处理（${describeError(err)}）` };
    }
  }

  /** 配置 + 会话内「本会话不再问」集合的合并 read 免审清单。 */
  private readToolAllowlist(): string[] {
    const configured = vscode.workspace
      .getConfiguration('atOpsAgent')
      .get<string[]>('approval.sessionReadAllowlist', []);
    return [
      ...new Set([
        ...(Array.isArray(configured) ? configured.filter((v) => typeof v === 'string') : []),
        ...this.sessionReadAllowlist
      ])
    ];
  }

  /** 调用方的审批引用：主会话用 currentApproval；子代理按 briefId 对齐。 */
  private approvalForOrigin(origin: ToolCallOrigin | undefined): ApprovalRef | null {
    const approval = this.validApproval();
    if (!approval) return null;
    if (origin?.kind === 'subagent') {
      // origin.approvalToken = TaskSpec.approvalToken.briefId（简报 id 引用）。
      return origin.approvalToken === approval.briefId ? approval : null;
    }
    return approval;
  }

  /** host 内存中的审批引用；HMAC 与当前会话验证不过即视为无审批。 */
  private validApproval(): ApprovalRef | null {
    const approval = this.currentApproval;
    if (!approval) return null;
    const ok = verifyApprovalToken(
      approval.token,
      approval.briefId,
      approval.commandSetSha256,
      this.store.activeSessionId,
      this.approvalSecret
    );
    if (!ok) {
      // 会话已切换等：引用作废，不留过期令牌。
      this.currentApproval = null;
      return null;
    }
    return approval;
  }

  /**
   * P0-D 阻塞派发审批：runtime 在工具 execute 内 await 本方法。
   * - 有 playbook run：经 orchestrator.requestApproval 产出 9 要素简报
   *   （approval/request 事件由 onOrchestratorEvent 广播）；
   * - 无 run（普通问答的 write/exec）：host 本地装配同构简报并走同一广播；
   * - 同一命令集已有待审简报时共享同一决议 promise（不重复开简报）。
   * 用户在 ApprovalBar / 命令面板决议后（applyApproval）该 promise 才落定。
   */
  private async resolveSessionApproval(input: {
    toolName: string;
    args: Record<string, unknown>;
    risk: 'write' | 'exec';
    reason?: string;
    origin?: ToolCallOrigin;
  }): Promise<'approved' | 'rejected'> {
    const commandSet = buildApprovalCommandSet(input.toolName, input.args);
    const commandSetSha256 = hashCommandSet(commandSet);
    // 同一命令集已在等待决议（并行子代理等）：共享同一 promise。
    for (const waiter of this.approvalWaiters.values()) {
      if (waiter.commandSetSha256 === commandSetSha256) return waiter.promise;
    }
    const elements = buildApprovalElements({
      toolName: input.toolName,
      args: input.args,
      risk: input.risk,
      commandSet,
      ...(this.pluginIdOf(input.toolName) !== undefined
        ? { pluginId: this.pluginIdOf(input.toolName) }
        : {}),
      ...(this.store.playbook?.stage !== undefined ? { stage: this.store.playbook.stage } : {})
    });

    let brief: ApprovalBriefLike | undefined;
    const run = this.activeRun;
    if (run) {
      try {
        const orchestrator = await this.ensureOrchestrator();
        if (orchestrator.requestApproval) {
          // awaitingApproval 只能从 synthesizing / executing 进入；调查中先推进。
          if (this.currentStage(run) === 'investigating') {
            this.tryAdvance(run, 'synthesizing');
          }
          brief = orchestrator.requestApproval(run.id, {
            risk: input.risk,
            commandSet,
            elements
          });
          // approval/request 事件已同步广播（onOrchestratorEvent）。
        }
      } catch (err) {
        this.log(`[orchestrator] requestApproval 失败: ${describeError(err)}，改走 host 本地简报`);
      }
    }
    if (!brief) {
      // 无 playbook run 的普通会话审批（P0 修复：审批不再依赖 playbook）。
      brief = {
        briefId: `brief-local-${randomUUID().slice(0, 8)}`,
        runId: '',
        risk: input.risk,
        commandSet,
        commandSetSha256,
        elements
      };
      this.onOrchestratorEvent({ type: 'approval/request', runId: '', brief });
    }

    let resolve!: (decision: 'approved' | 'rejected') => void;
    const promise = new Promise<'approved' | 'rejected'>((r) => {
      resolve = r;
    });
    this.approvalWaiters.set(brief.briefId, { commandSetSha256, promise, resolve });
    return promise;
  }

  private pluginIdOf(toolName: string): string | undefined {
    try {
      return this.hub.listAllTools().find((t) => t.name === toolName)?.pluginId;
    } catch {
      return undefined;
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
        const untrustedQuotes = this.collectUntrustedQuotes(e.id);
        this.broadcast('thinking/delta', {
          itemId: e.id,
          text: e.text,
          ...(untrustedQuotes !== undefined ? { untrustedQuotes } : {})
        });
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
      case 'usage': {
        const { type: _type, ...usage } = e;
        this.lastUsage = usage;
        this.broadcast('usage', usage);
        break;
      }
      case 'compaction': {
        const item = {
          kind: 'system' as const,
          id: randomUUID(),
          text: `上下文已自动压缩：${e.summary}`
        };
        this.store.appendItem(item);
        this.broadcast('transcript/append', { item });
        this.broadcast('compaction', { summary: e.summary });
        break;
      }
      case 'notice': {
        const item = {
          kind: 'notice' as const,
          id: randomUUID(),
          variant: e.variant,
          text: e.text,
          ...(e.actions !== undefined ? { actions: e.actions } : {})
        };
        this.store.appendItem(item);
        this.broadcast('transcript/append', { item });
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
        // 空闲：清 running context，并释放挂起的重建请求（P1-15）。
        this.markTurnEnded();
        break;
      }
      default:
        // runtime 可扩展事件面；未知类型忽略。
        break;
    }
  }

  /**
   * pb.security-triage 的思考卡片附「不可信引用」（docs/07 提示注入防线）：
   * 最近工具输出 preview 里疑似日志/SQL 的片段单独框出，提醒操作者
   * 这些内容来自被调查对象、可能包含注入指令，不能当作 Agent 结论。
   */
  private collectUntrustedQuotes(thinkingItemId: string): string[] | undefined {
    if (this.store.playbook?.id !== 'pb.security-triage') return undefined;
    const item = this.store.findItem(thinkingItemId);
    if (item?.kind !== 'thinking') return undefined;
    const items = this.store.items;
    let idx = items.findIndex((i) => i.id === thinkingItemId);
    if (idx < 0) idx = items.length;
    // 从思考卡片往前扫本轮（遇 user 停）最近的工具输出，最多取 3 条命中。
    const quotes: string[] = [];
    for (let i = idx - 1, scanned = 0; i >= 0 && scanned < 8 && quotes.length < 3; i -= 1) {
      const candidate = items[i];
      if (candidate.kind === 'user') break;
      if (candidate.kind !== 'tool') continue;
      scanned += 1;
      const preview = candidate.call.preview;
      if (typeof preview === 'string' && looksLikeLogOrSql(preview)) {
        quotes.push(truncateUntrustedQuote(preview));
      }
    }
    if (quotes.length === 0) return item.untrustedQuotes;
    const merged = [...new Set([...(item.untrustedQuotes ?? []), ...quotes.reverse()])].slice(0, 5);
    item.untrustedQuotes = merged;
    return merged;
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
        if (typeof e.brief.commandSetSha256 === 'string') {
          this.briefHashes.set(e.brief.briefId, e.brief.commandSetSha256);
        }
        this.store.addBrief(view);
        const item = { kind: 'approval' as const, id: randomUUID(), briefId: view.id };
        this.store.appendItem(item);
        this.broadcast('transcript/append', { item });
        this.broadcast('approval/request', view);
        this.postApprovalWebhook(view);
        break;
      }
      case 'approval/resolved': {
        if (this.store.resolveBrief(e.briefId)) {
          this.broadcast('approval/resolve', { briefId: e.briefId, decision: e.decision });
        }
        this.briefRuns.delete(e.briefId);
        this.briefHashes.delete(e.briefId);
        break;
      }
      default:
        break;
    }
  }

  /**
   * IM webhook（P2）：配置了 atOpsAgent.im.webhookUrl 时，待审批简报产生
   * 即 POST 一条脱敏 JSON 摘要（无令牌 / 无凭证 / 无完整命令集），
   * 提示值班人回 IDE 会话内批准。失败只记日志，绝不影响审批主链路。
   */
  private postApprovalWebhook(view: ApprovalBriefView): void {
    const url = vscode.workspace.getConfiguration('atOpsAgent').get<string>('im.webhookUrl', '');
    if (typeof url !== 'string' || url.trim().length === 0) return;
    const body = JSON.stringify({
      type: 'approval/request',
      briefId: view.id,
      risk: view.risk,
      target: view.targetLabel,
      sessionId: this.store.activeSessionId,
      ts: Date.now(),
      hint: '请回到 IDE 的 AT Ops Agent 会话中查看 9 要素简报并批准/拒绝。'
    });
    void fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000)
    })
      .then((res) => {
        if (!res.ok) this.log(`[im] webhook 返回 ${res.status}`);
      })
      .catch((err) => this.log(`[im] webhook 推送失败: ${describeError(err)}`));
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** mcp.json 脱敏：servers / mcpServers 两种映射的 env、headers 值与 bearerToken → ***。 */
function redactMcpConfig(root: unknown): unknown {
  if (!isPlainRecord(root)) return root;
  const out: Record<string, unknown> = { ...root };
  for (const mapKey of ['servers', 'mcpServers'] as const) {
    const map = out[mapKey];
    if (!isPlainRecord(map)) continue;
    out[mapKey] = Object.fromEntries(
      Object.entries(map).map(([name, entry]) => [name, redactMcpEntry(entry)])
    );
  }
  return out;
}

function redactMcpEntry(entry: unknown): unknown {
  if (!isPlainRecord(entry)) return entry;
  const out: Record<string, unknown> = { ...entry };
  for (const key of ['env', 'headers'] as const) {
    const rec = out[key];
    if (isPlainRecord(rec)) {
      out[key] = Object.fromEntries(Object.keys(rec).map((k) => [k, MCP_REDACTED]));
    }
  }
  if (typeof out.bearerToken === 'string' && out.bearerToken.length > 0) {
    out.bearerToken = MCP_REDACTED;
  }
  return out;
}

/** mcp/save：webview 传回的 *** 占位值按 server+键 从现有文件回填。 */
function restoreRedactedMcpValues(
  next: Record<string, unknown>,
  existing: unknown
): Record<string, unknown> {
  if (!isPlainRecord(existing)) return next;
  const out: Record<string, unknown> = { ...next };
  for (const mapKey of ['servers', 'mcpServers'] as const) {
    const nextMap = out[mapKey];
    const prevMap = existing[mapKey];
    if (!isPlainRecord(nextMap) || !isPlainRecord(prevMap)) continue;
    out[mapKey] = Object.fromEntries(
      Object.entries(nextMap).map(([name, entry]) => [
        name,
        restoreRedactedEntry(entry, prevMap[name])
      ])
    );
  }
  return out;
}

function restoreRedactedEntry(entry: unknown, prev: unknown): unknown {
  if (!isPlainRecord(entry)) return entry;
  const prevRec = isPlainRecord(prev) ? prev : undefined;
  const out: Record<string, unknown> = { ...entry };
  for (const key of ['env', 'headers'] as const) {
    const rec = out[key];
    if (!isPlainRecord(rec)) continue;
    const prevValues = prevRec && isPlainRecord(prevRec[key]) ? prevRec[key] : undefined;
    out[key] = Object.fromEntries(
      Object.entries(rec).map(([k, v]) => [
        k,
        v === MCP_REDACTED && typeof prevValues?.[k] === 'string' ? prevValues[k] : v
      ])
    );
  }
  if (out.bearerToken === MCP_REDACTED && typeof prevRec?.bearerToken === 'string') {
    out.bearerToken = prevRec.bearerToken;
  }
  return out;
}

/** 简单启发式：工具输出是否像日志 / SQL（时间戳、日志级别、异常栈、SQL 关键字）。 */
function looksLikeLogOrSql(text: string): boolean {
  return (
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/.test(text) ||
    /\b(ERROR|WARN(ING)?|FATAL|SEVERE|PANIC)\b/.test(text) ||
    /\b(exception|stack ?trace|traceback)\b/i.test(text) ||
    /^\s*at\s+[\w$.<>]+\s*\(/m.test(text) ||
    /\b(select|insert|update|delete|drop|alter|union)\b[\s\S]{0,200}\b(from|into|table|where|values|set)\b/i.test(
      text
    )
  );
}

function truncateUntrustedQuote(text: string, limit = 240): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
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

const SUBAGENT_ROLES: ReadonlySet<string> = new Set([
  'investigator',
  'executor',
  'writer',
  'verifier'
]);

function isSubagentRole(value: string | undefined): value is SubagentCard['role'] {
  return value !== undefined && SUBAGENT_ROLES.has(value);
}

const EVIDENCE_CONFIDENCES: ReadonlySet<string> = new Set(['confirmed', 'hypothesis', 'pending']);

function isEvidenceConfidence(value: unknown): value is EvidenceNoteView['confidence'] {
  return typeof value === 'string' && EVIDENCE_CONFIDENCES.has(value);
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
