/**
 * Host 业务中枢——薄路由层（P2-1 拆分完成形态）：
 * 业务全部下沉到 src/host/services/*：
 * - ChatService      prompt/中止/会话生命周期/runtime 事件；内含会话 runtime
 *                    池（P2 sessions.maxParallel ≤ 2：sessionId → runtime，
 *                    两席可并行 prompt，中止/重建/idle 均按会话定向）
 * - ApprovalService  策略闸装配 + 阻塞派发会话审批（P0-D，不依赖 playbook）
 *                    + HMAC 令牌 + IM webhook；审批态按会话分席
 * - PlaybookService  orchestrator 生命周期 + 阶段驱动 + L4 注入 + guidedManual
 * - ModelService     模型清单/选择/连通性测试/目录拉取/OAuth/思考等级
 * - ConfigService    设置页快照/配置白名单/mcp.json 脱敏读写/技能/诊断
 * - WorkbenchService asset/pick、值班报告导出、日志打开
 * 本类只负责：服务装配（HostContext.wire）、webview 请求路由
 * （handleRequest）、对 activate/commands/chatView 保持既有公共 API。
 */
import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import {
  envelope,
  type ApprovalRespondReq,
  type ChatAbortReq,
  type ChatPromptReq,
  type Envelope,
  type Event,
  type HubHost,
  type HydrateEvt,
  type McpSaveReq,
  type ModelsFetchReq,
  type ModelsTestReq,
  type ModelSetReq,
  type SettingsOpenJsonReq,
  type SettingsPatchConfigReq
} from '../protocol';
import type { OpsSecrets } from './secrets';
import type { SessionStore } from './sessionStore';
import type { PlaybookMeta } from './hostTypes';
import { ApprovalService } from './services/approvalService';
import { ChatService } from './services/chatService';
import { ConfigService, type SettingsSnapshot } from './services/configService';
import { HostContext } from './services/context';
import { ModelService } from './services/modelService';
import { PlaybookService } from './services/playbookService';
import { WorkbenchService } from './services/workbenchService';
import { saveOpsDocFromTranscript } from './services/opsDocService';

export type { SettingsSnapshot } from './services/configService';

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

  /** 面向 Chat webview 的事件流（由 ChatViewProvider 合批转发）。 */
  readonly onUiEvent: Event<Envelope>;
  /** 面向 Ops 看板的事件流（timeline/upsert）。 */
  readonly onBoardEvent: Event<Envelope>;
  /** 状态位变化（hasApiKey 等）；activate 的状态栏订阅。 */
  readonly onDidChangeStatus: Event<void>;

  private readonly ctx: HostContext;
  private readonly chat: ChatService;
  private readonly approvals: ApprovalService;
  private readonly playbooks: PlaybookService;
  private readonly models: ModelService;
  private readonly config: ConfigService;
  private readonly workbench: WorkbenchService;

  private readonly hubSub: { dispose(): void };
  private readonly timelineSub: { dispose(): void };

  constructor(options: HostControllerOptions) {
    this.ctx = new HostContext(options);
    this.hub = this.ctx.hub;
    this.store = this.ctx.store;
    this.secrets = this.ctx.secrets;
    this.agentDir = this.ctx.agentDir;
    this.modelsPath = this.ctx.modelsPath;
    this.playbooksDir = this.ctx.playbooksDir;
    this.onUiEvent = this.ctx.onUiEvent;
    this.onBoardEvent = this.ctx.onBoardEvent;
    this.onDidChangeStatus = this.ctx.onDidChangeStatus;

    this.chat = new ChatService(this.ctx);
    this.approvals = new ApprovalService(this.ctx);
    this.playbooks = new PlaybookService(this.ctx);
    this.models = new ModelService(this.ctx);
    this.config = new ConfigService(this.ctx);
    this.workbench = new WorkbenchService(this.ctx);
    this.ctx.wire({
      chat: this.chat,
      approvals: this.approvals,
      playbooks: this.playbooks,
      models: this.models,
      config: this.config,
      workbench: this.workbench
    });

    void this.models.bootstrapModelCatalog();

    this.hubSub = this.hub.onDidChangeTools(() => {
      this.config.handleToolCatalogChange();
      this.ctx.broadcast('capabilities/snapshot', this.chat.chatCapabilitiesPayload());
    });
    this.timelineSub = this.store.onDidAppendTimeline((event) => {
      this.ctx.fireBoardEvent(envelope('evt', 'timeline/upsert', event, randomUUID()));
    });
  }

  log(message: string): void {
    this.ctx.log(message);
  }

  /** SecretStorage 是否有 LLM key（状态栏未配置警示消费）。 */
  get hasModelApiKey(): boolean {
    return this.models.hasModelApiKey;
  }

  snapshot(): HydrateEvt {
    return this.chat.snapshot();
  }

  // ── webview 请求路由 ───────────────────────────────────────────────────

  async handleRequest(type: string, payload: unknown): Promise<unknown> {
    switch (type) {
      case 'chat/prompt':
        return this.chat.handlePrompt(payload as ChatPromptReq);
      case 'chat/abort':
        this.chat.abort((payload as ChatAbortReq | undefined)?.mode ?? 'stop');
        return { ok: true };
      case 'chat/retry':
        return this.chat.retryLastPrompt();
      case 'chat/export':
        return this.workbench.exportReport((payload as { sessionId?: string } | undefined)?.sessionId);
      case 'clipboard/write':
        return this.workbench.writeClipboard(String((payload as { text?: string })?.text ?? ''));
      case 'model/set':
        return this.models.setModel(payload as ModelSetReq);
      case 'playbook/start':
        return this.playbooks.startPlaybook((payload as { playbookId: string }).playbookId);
      case 'playbook/advance':
        return this.playbooks.advancePlaybook((payload as { stage?: string } | undefined)?.stage);
      case 'playbook/close':
        return this.playbooks.closePlaybook();
      case 'playbook/escalate-select':
        return this.playbooks.applyEscalateSelect();
      case 'approval/respond':
        return this.approvals.applyApproval(payload as ApprovalRespondReq);
      case 'subagent/abort': {
        const taskId = (payload as { taskId?: string }).taskId;
        if (typeof taskId !== 'string' || taskId.length === 0) return { ok: false };
        this.chat.abortSubagentTask(taskId);
        return { ok: true };
      }
      case 'guidedManual/open':
        return this.playbooks.guided.open((payload as { briefId?: string } | undefined)?.briefId);
      case 'guidedManual/complete':
        return this.playbooks.guided.complete(
          (payload as { briefId?: string } | undefined)?.briefId
        );
      case 'log/open':
        return this.workbench.openLog((payload as { uri?: string } | undefined)?.uri);
      case 'skill/run':
        return this.workbench.runSkill((payload as { name?: string } | undefined)?.name);
      case 'hydrate':
        return this.chat.snapshot();
      case 'session/list':
        return { sessions: this.chat.sessionSummaries() };
      case 'session/new': {
        this.chat.newSession();
        return { ok: true, sessionId: this.store.activeSessionId };
      }
      case 'session/switch': {
        const p = payload as { id?: string; sessionId?: string } | undefined;
        return this.chat.switchSession(p?.id ?? p?.sessionId);
      }
      case 'session/rename': {
        const p = payload as { id?: string; title?: string } | undefined;
        return this.chat.renameSession(p?.id ?? '', p?.title ?? '');
      }
      case 'session/delete': {
        const p = payload as { id?: string } | undefined;
        return this.chat.deleteSession(p?.id ?? '');
      }
      case 'opsDoc/save': {
        const p = payload as { itemId?: string } | undefined;
        return saveOpsDocFromTranscript(this.ctx, p?.itemId);
      }
      case 'notice/action': {
        const p = payload as { id?: string; sessionId?: string } | undefined;
        const id = typeof p?.id === 'string' ? p.id : '';
        if (id.length === 0) return { ok: false };
        return this.chat.handleNoticeAction(id, p?.sessionId);
      }
      case 'settings/hydrate':
        return this.config.settingsSnapshot();
      case 'settings/open':
        return this.config.openSettingsPanel((payload as { tab?: string } | undefined)?.tab);
      case 'settings/patchConfig':
        return this.config.patchConfig(payload as SettingsPatchConfigReq);
      case 'mcp/get':
        return this.config.readMcpRedacted();
      case 'mcp/save':
        return this.config.saveMcp((payload as McpSaveReq | undefined)?.text);
      case 'settings/openJson':
        return this.config.openJson((payload as SettingsOpenJsonReq | undefined)?.kind);
      case 'history/toggle':
        // controller 侧 no-op：标题栏命令由 chatView 直接向 chat webview 发 evt。
        return { ok: true };
      case 'models/state':
        return this.models.modelsFormState();
      case 'models/save':
        return this.models.saveModelsFromSettings(payload);
      case 'models/test':
        return this.models.testModel(payload as ModelsTestReq);
      case 'models/fetch':
        return this.models.fetchModels(payload as ModelsFetchReq);
      case 'models/oauth': {
        const providerId = (payload as { providerId?: string } | undefined)?.providerId;
        return this.models.loginOAuth(typeof providerId === 'string' ? providerId : '');
      }
      case 'models/openFile':
        return this.config.openJson('models');
      case 'models/openAuth':
        return this.config.openJson('auth');
      case 'asset/pick':
        return this.workbench.pickAsset((payload as { query?: string } | undefined)?.query);
      case 'capabilities/refresh':
        return this.config.refreshCapabilities();
      case 'diagnose':
        return this.config.runDiagnose();
      case 'skill/open':
        return this.config.openSkill(payload as { name?: string; path?: string } | undefined);
      default:
        return { ok: false, error: `未知请求类型 ${type}` };
    }
  }

  // ── 既有公共 API（activate / commands / 视图适配层消费） ────────────────

  async handlePrompt(req: ChatPromptReq): Promise<{ accepted: boolean }> {
    return this.chat.handlePrompt(req);
  }

  abort(mode: 'cancel' | 'stop' = 'stop'): void {
    this.chat.abort(mode);
  }

  newSession(): void {
    this.chat.newSession();
  }

  switchSession(id: string | undefined): { ok: boolean } {
    return this.chat.switchSession(id);
  }

  async saveOpsDoc(itemId?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return saveOpsDocFromTranscript(this.ctx, itemId);
  }

  async setModel(req: ModelSetReq): Promise<{ ok: boolean }> {
    return this.models.setModel(req);
  }

  async getPlaybooks(): Promise<PlaybookMeta[]> {
    return this.playbooks.getPlaybooks();
  }

  async startPlaybook(
    playbookId: string,
    opts?: { advance?: boolean }
  ): Promise<{ ok: boolean; stage?: string; error?: string }> {
    return this.playbooks.startPlaybook(playbookId, opts);
  }

  async advancePlaybook(stage?: string): Promise<{ ok: boolean; stage?: string; error?: string }> {
    return this.playbooks.advancePlaybook(stage);
  }

  async closePlaybook(): Promise<{ ok: boolean; stage?: string; error?: string }> {
    return this.playbooks.closePlaybook();
  }

  async applyEscalateSelect(): Promise<{ ok: boolean; reason?: string }> {
    return this.playbooks.applyEscalateSelect();
  }

  async applyApproval(req: ApprovalRespondReq): Promise<{ ok: boolean }> {
    return this.approvals.applyApproval(req);
  }

  async exportReport(sessionId?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return this.workbench.exportReport(sessionId);
  }

  async settingsSnapshot(): Promise<SettingsSnapshot> {
    return this.config.settingsSnapshot();
  }

  async readMcpRedacted(): Promise<SettingsSnapshot['mcp']> {
    return this.config.readMcpRedacted();
  }

  refreshSkills(): void {
    this.config.refreshSkills();
  }

  async loginOAuth(providerId: string): Promise<{ ok: boolean; message: string }> {
    return this.models.loginOAuth(providerId);
  }

  dispose(): void {
    this.approvals.dispose();
    this.hubSub.dispose();
    this.timelineSub.dispose();
    this.chat.dispose();
    this.playbooks.dispose();
    this.ctx.disposeEmitters();
  }
}
