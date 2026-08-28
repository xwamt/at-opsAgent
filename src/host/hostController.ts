/**
 * Host 业务中枢：
 * - 懒创建 runtime（首个 chat/prompt 才碰 LLM 配置，activate 保持廉价）
 * - 懒创建 orchestrator（playbook / 审批首次使用时）
 * - runtime / orchestrator 事件 → host-protocol 事件
 *   （transcript/append|patch、tool/*、thinking/delta、approval/*…）
 * - webview 请求路由（chat/prompt、chat/abort、playbook/start、approval/respond…）
 * - beforeToolCall 权限闸装配（policy.evaluate；orchestrator 侧不重复）
 * - playbook 阶段驱动：首条用户消息 triage → selecting → investigating；
 *   进入 investigating/executing/verifying/reporting 时下发子代理；
 *   阶段迁移时整体替换 L4；无进行中 playbook 时 NL 触发词唯一命中可自动启动；
 *   guidedManual（Jenkins/Nacos 人工步骤）发引导提示，completed 后续链路
 * - 会话审批闭环：write/exec 被策略闸拦下时经 orchestrator 产出 9 要素简报，
 *   批准后 host 内存签发 HMAC 令牌（不进 LLM/webview），模型重试同一命令集放行
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
  type ChatPromptReq,
  type Envelope,
  type Event,
  type EvidenceNoteView,
  type HubHost,
  type HydrateEvt,
  type McpSaveReq,
  type ModelSetReq,
  type SessionSummary,
  type SessionSwitchReq,
  type SettingsOpenJsonReq,
  type SettingsPatchConfigReq,
  type SubagentCard,
  type ToolCallView
} from '../protocol';
import {
  evaluatePolicy,
  hashCommandSet,
  issueApprovalToken,
  verifyApprovalToken,
  type ApprovalRef
} from '../policy';
import { normalizeThinkingLevel, readAgentSettings } from './agentSettings';
import { buildApprovalCommandSet, buildApprovalElements } from './approvalGate';
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
  RuntimeLike,
  ThinkingLevel
} from './hostTypes';
import { diagnoseHub } from './diagnose';
import { openModelsJson, readModelsFormState, saveModelsForm } from './modelsView';
import { loadOrchestratorModule, loadRuntimeModule } from './modules';
import { loginOAuthViaPi, openAuthJson } from './oauthLogin';
import { PlaybookLayerSource } from './playbookLayer';
import type { OpsSecrets } from './secrets';
import type { SessionStore } from './sessionStore';
import { listSkills, type SkillInfo } from './skillsScan';

const SELECT_TOOL_NAMES = new Set(['ops_select_tools', 'at_select_tools']);

/** settings/patchConfig 白名单：与 package.json contributes.configuration 对齐。 */
const KNOWN_CONFIG_KEYS: readonly string[] = [
  'discovery.mode',
  'discovery.threshold',
  'plugins.autoEnableNew',
  'approval.sessionRequiredFor',
  'approval.dedupePluginModal',
  'models.defaultThinkingLevel',
  'models.toolCallPromptFallback',
  'workspaceShell.enabled',
  'subagent.maxParallel',
  'streaming.batchMs'
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
  /** NL 触发词自动启动 playbook：每会话最多一次，不重复替用户拍板。 */
  private nlTriggerConsumed = false;
  /** 已知插件基线（plugins.autoEnableNew=false 时用于识别「新上线」插件）。 */
  private knownPluginIds: Set<string> | undefined;
  /** briefId → runId（applyApproval 需要 runId 定位 run）。 */
  private readonly briefRuns = new Map<string, string>();
  /** briefId → commandSetSha256（批准时签发令牌用；resolved 后清除）。 */
  private readonly briefHashes = new Map<string, string>();
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
      this.handleToolCatalogChange();
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
    if (!playbooks) {
      // 不阻塞快照：后台预热缓存，下一次 hydrate 自然带上。
      void this.getPlaybooks().catch(() => {});
      return this.store.snapshot(providers);
    }
    // webview 的 absorbCapabilities 从 providers 记录里取 playbooks；
    // 顶层字段同时下发，供后续消费方直接读取。
    const providersWithPlaybooks =
      typeof providers === 'object' && providers !== null && !Array.isArray(providers)
        ? { ...(providers as Record<string, unknown>), playbooks }
        : providers;
    return this.store.snapshot(providersWithPlaybooks, { playbooks });
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
      case 'session/switch':
        return this.switchSession((payload as SessionSwitchReq | undefined)?.id);
      case 'settings/hydrate':
        return this.settingsSnapshot();
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
      case 'models/oauth': {
        const providerId = (payload as { providerId?: string } | undefined)?.providerId;
        return this.loginOAuth(typeof providerId === 'string' ? providerId : '');
      }
      case 'models/openFile':
        return this.openJson('models');
      case 'models/openAuth':
        return this.openJson('auth');
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
      } else if (attachment.kind === 'file' && typeof attachment.uri === 'string') {
        text += `\n\n[附件] ${attachment.uri}`;
      }
    }
    if (text.trim().length === 0) return { accepted: false };
    const userItem = { kind: 'user' as const, id: randomUUID(), text };
    this.store.appendItem(userItem);
    this.broadcast('transcript/append', { item: userItem });
    // 无进行中 playbook 时按 yaml triggers（kind=nl）尝试自动启动，再继续对话。
    await this.maybeAutoStartPlaybook(text);
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
    this.selectCountThisTask = 0;
    this.nlTriggerConsumed = false;
    this.briefRuns.clear();
    this.briefHashes.clear();
    this.currentApproval = null;
    this.activeRun = undefined;
    this.spawnedStageKeys.clear();
    this.guidedNoticeRuns.clear();
    this.activeSubagentTaskIds.clear();
    this.lastLayerKey = undefined;
    this.lastLayerRuntime = undefined;
    this.disposeRuntime();
  }

  private sessionSummaries(): SessionSummary[] {
    return this.store.sessions.map((s) => ({ ...s }));
  }

  // ── 设置页 ─────────────────────────────────────────────────────────────

  /** 技能清单缓存：refresh 命令 / 设置页刷新时失效重扫。 */
  private skillsCache: SkillInfo[] | undefined;

  refreshSkills(): void {
    this.skillsCache = undefined;
  }

  /** settings/hydrate：设置页全量快照（不含任何明文凭证）。 */
  async settingsSnapshot(): Promise<SettingsSnapshot> {
    if (!this.skillsCache) {
      try {
        this.skillsCache = await listSkills(this.extensionPath);
      } catch (err) {
        this.log(`[settings] 技能扫描失败: ${describeError(err)}`);
        this.skillsCache = [];
      }
    }
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const configValues: Record<string, unknown> = {};
    for (const key of KNOWN_CONFIG_KEYS) configValues[key] = config.get(key);
    return {
      config: configValues,
      modelsPath: this.modelsPath,
      agentDir: this.agentDir,
      capabilities: this.safeProviders(),
      skills: this.skillsCache,
      sessions: this.sessionSummaries(),
      mcp: await this.readMcpRedacted(),
      pendingApprovals: this.store.pendingBriefs.length
    };
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
    return { ok: true, state: await this.modelsFormState() };
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

  /**
   * NL 触发词（playbook.yaml triggers.kind=nl 的 patterns）自动启动 playbook：
   * 仅在没有进行中 playbook、且 **唯一** 命中一条时启动（多条命中视为不确定，
   * 绝不静默替用户拍板，也绝不默认落到 pb.incident）。每会话最多自动启动一次。
   */
  private async maybeAutoStartPlaybook(text: string): Promise<void> {
    if (this.nlTriggerConsumed || this.activeRun || this.store.playbook) return;
    let playbooks: PlaybookMeta[];
    try {
      playbooks = await this.getPlaybooks();
    } catch {
      return;
    }
    const matches = playbooks.filter((pb) => matchesNlTrigger(pb, text));
    if (matches.length !== 1) {
      if (matches.length > 1) {
        this.log(
          `[playbook] NL 触发词命中多条（${matches.map((p) => p.id).join(', ')}），不自动启动`
        );
      }
      return;
    }
    this.nlTriggerConsumed = true;
    const target = matches[0];
    this.log(`[playbook] 用户输入命中 ${target.id} 的 NL 触发词，自动启动`);
    try {
      const result = await this.startPlaybook(target.id);
      if (result.ok) {
        this.emitAssistantNotice(
          `已根据触发词自动启动 playbook **${target.title ?? target.id}**（${target.id}）。` +
            `如不需要可通过标题栏重新选择链路。`
        );
      }
    } catch (err) {
      this.log(`[playbook] NL 自动启动 ${target.id} 失败: ${describeError(err)}`);
    }
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

  async applyApproval(req: ApprovalRespondReq): Promise<{ ok: boolean }> {
    if (typeof req?.briefId !== 'string') return { ok: false };
    const orchestrator = await this.ensureOrchestrator();
    const runId = this.briefRuns.get(req.briefId) ?? '';
    // approval/resolved 事件会同步清 briefHashes，先取哈希。
    const commandSetSha256 = this.briefHashes.get(req.briefId);
    // 令牌必须在 orchestrator.applyApproval 之前就位：approved 会同步推进
    // executing 并触发 executor 下发，届时 spec 合并要读 currentApproval。
    // token 仅存 host 内存；模型只会收到「已批准，请重试」的语义，不见令牌。
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
    this.briefHashes.delete(req.briefId);
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
    // reporting 阶段的 parallelGroup 是 writer（运维文档产出），一并下发。
    if (
      stage === 'investigating' ||
      stage === 'executing' ||
      stage === 'verifying' ||
      stage === 'reporting'
    ) {
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
   * 进入 investigating / executing / verifying 时把 parallelGroup 转成
   * TaskSpec 并交 runtime 执行。orchestrator 缺 spawnSubagentSpecs 或 runtime
   * 缺 dispatchSubagent 都静默降级：卡片仍显示（queued），但没有真实子代理。
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
    for (const rawSpec of specs) {
      // 已批准的会话内，executor spec 附上 {briefId, commandSetSha256}
      //（不含 hmac token——token 只留在 host，闸门校验时使用）。
      const spec = this.attachApprovalToken(rawSpec);
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

  /** executor spec 合并审批引用（TaskSpec.approvalToken 形状不含 hmac token）。 */
  private attachApprovalToken(spec: unknown): unknown {
    const approval = this.currentApproval;
    if (!approval) return spec;
    if (typeof spec !== 'object' || spec === null) return spec;
    if ((spec as { role?: unknown }).role !== 'executor') return spec;
    return {
      ...(spec as Record<string, unknown>),
      approvalToken: { briefId: approval.briefId, commandSetSha256: approval.commandSetSha256 }
    };
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
        const config = vscode.workspace.getConfiguration('atOpsAgent');
        // 真 runtime 创建期内部兜底（缺 key → 自带 FallbackRuntime），不抛出。
        runtime = await Promise.resolve(
          mod.createOpsRuntime(
            {
              hub: this.hub,
              beforeToolCall: async (ctx) => this.gateToolCall(ctx.toolName, ctx.args),
              onEvent,
              onSubagentEvent: (e) => {
                this.patchSubagentCard(e.taskId, e.status, e.summary ?? e.error);
                if (e.evidenceNote) this.appendEvidenceNote(e.evidenceNote);
              },
              // pi 会话无法追加新 ToolDefinition：目录需要重建时释放 runtime，
              // 下一次 prompt 以最新工具目录重建。
              onCatalogNeedsRebuild: () => {
                this.log('[runtime] 工具目录需重建：释放当前 runtime，下次 prompt 重建工具面');
                this.disposeRuntime();
              }
            },
            {
              agentDir: this.agentDir,
              cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
              model: this.modelSelection
                ? { provider: this.modelSelection.provider, id: this.modelSelection.model }
                : undefined,
              getApiKey: () => Promise.resolve(this.secrets.getLlmApiKey()),
              bundledSkillsDir: path.join(this.extensionPath, 'skills'),
              thinkingLevel: await this.resolveThinkingLevel(config),
              workspaceShellEnabled: config.get<boolean>('workspaceShell.enabled', false)
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
        approval: this.validApproval(),
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
        // 会话审批闭环：产出 9 要素简报并拒绝本次调用；批准后模型重试同一
        // 调用时 approval 命中放行。绝不在批准后代模型自动重放工具。
        return this.requestSessionApproval(
          toolName,
          args,
          risk === 'exec' ? 'exec' : 'write',
          descriptor?.pluginId,
          decision.reason
        );
      }
      return { block: false };
    } catch (err) {
      // 闸门自身出错必须 fail-closed。
      this.log(`[policy] evaluate 异常，fail-closed: ${describeError(err)}`);
      return { block: true, reason: `策略闸异常，已按拒绝处理（${describeError(err)}）` };
    }
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
   * needSessionApproval → 经 orchestrator 产出 9 要素简报（approval/request
   * 事件由 onOrchestratorEvent 广播为 ApprovalBar），并拒绝本次调用。
   * orchestrator / run 缺席或状态机不允许进入 awaitingApproval 时退回纯文本拒绝。
   */
  private async requestSessionApproval(
    toolName: string,
    args: Record<string, unknown>,
    risk: 'write' | 'exec',
    pluginId: string | undefined,
    policyReason: string
  ): Promise<{ block: boolean; reason?: string }> {
    const fallback = {
      block: true,
      reason: `OPS_APPROVAL_REQUIRED: ${policyReason}。请先产出 9 要素审批简报并等待会话内批准。`
    };
    let orchestrator: OrchestratorLike;
    try {
      orchestrator = await this.ensureOrchestrator();
    } catch (err) {
      this.log(`[orchestrator] ensure 失败: ${describeError(err)}`);
      return fallback;
    }
    const run = this.activeRun;
    if (!orchestrator.requestApproval || !run) return fallback;

    const commandSet = buildApprovalCommandSet(toolName, args);
    const commandSetSha256 = hashCommandSet(commandSet);
    // 同一命令集已有待审简报（模型在批准前重试是常态）：不重复开新简报。
    for (const [briefId, hash] of this.briefHashes) {
      if (hash === commandSetSha256 && this.store.pendingBriefs.some((b) => b.id === briefId)) {
        return {
          block: true,
          reason: `OPS_APPROVAL_REQUIRED: 已发出 9 要素简报 ${briefId}，请在会话内批准后再试。`
        };
      }
    }
    // awaitingApproval 只能从 synthesizing / executing 进入；调查中先推进。
    if (this.currentStage(run) === 'investigating') {
      this.tryAdvance(run, 'synthesizing');
    }
    let briefId: string;
    try {
      const brief = orchestrator.requestApproval(run.id, {
        risk,
        commandSet,
        elements: buildApprovalElements({
          toolName,
          args,
          risk,
          commandSet,
          pluginId,
          stage: this.store.playbook?.stage
        })
      });
      briefId = brief.briefId;
    } catch (err) {
      this.log(`[orchestrator] requestApproval 失败: ${describeError(err)}`);
      return fallback;
    }
    return {
      block: true,
      reason: `OPS_APPROVAL_REQUIRED: 已发出 9 要素简报 ${briefId}，请在会话内批准后再试。`
    };
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

/** kind=nl 触发词匹配：pattern 先按（大小写不敏感）正则试，非法正则退回子串包含。 */
function matchesNlTrigger(pb: PlaybookMeta, text: string): boolean {
  const lower = text.toLowerCase();
  for (const trigger of pb.triggers ?? []) {
    if (trigger.kind !== 'nl') continue;
    for (const pattern of trigger.patterns ?? []) {
      if (typeof pattern !== 'string' || pattern.trim().length === 0) continue;
      try {
        if (new RegExp(pattern, 'i').test(text)) return true;
      } catch {
        if (lower.includes(pattern.toLowerCase())) return true;
      }
    }
  }
  return false;
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

const EVIDENCE_CONFIDENCES: ReadonlySet<string> = new Set(['confirmed', 'hypothesis', 'pending']);

function isEvidenceConfidence(value: unknown): value is EvidenceNoteView['confidence'] {
  return typeof value === 'string' && EVIDENCE_CONFIDENCES.has(value);
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
