/**
 * settings webview 的 Pinia store：
 * - 上行 req envelope（v:1），下行同时接 evt 与 res（settingsView.ts 把
 *   handleRequest 结果按原 type 以 res 回执；hydrate/tab 走 evt）。
 * - 启动 hydrate：settings/hydrate（主）→ hydrate（chat 快照兜底，吸收
 *   sessions/providers 等公共字段）→ models/state（host 未实现则回错误 res，
 *   静默忽略）。host 对未知 type 一律回 {ok:false,error}，不会 crash。
 * - settings/patchConfig 按 host 契约单键 {key,value}，改几个键发几个 req。
 * - 收到过 models/state（evt / 合法 res）⇒ host 支持 models/* 家族；打开
 *   models.json / auth.json 在 models/openFile|openAuth 与
 *   settings/openJson {kind:'models'|'auth'} 之间二选一（避免双开）。
 */
import { defineStore } from 'pinia';
import type { Envelope } from '../protocol/host-protocol';
import { getVsCodeApi, isMockHost } from '../webview-chat/vscode-api';
import {
  CONFIG_DEFAULTS,
  applyProviderPreset,
  buildConfigPatch,
  buildConfigPatchRequests,
  buildModelsFetchReq,
  buildModelsSavePayload,
  buildModelsTestReq,
  clampConfigToPolicyFloor,
  emptyModelsForm,
  modelsKeyMissing,
  normalizeConfig,
  normalizeFetchedModels,
  normalizeMcpState,
  normalizeModelsState,
  normalizeProviders,
  normalizeSessions,
  normalizeSettingsSnapshot,
  normalizeTabId,
  openAuthFileReq,
  openModelsFileReq,
  parseMcpConfig,
  resolveOauthProvider,
  type McpParseResult,
  type ModelsForm,
  type OpsConfig,
  type ProviderRow,
  type SessionRow,
  type SettingsTabId
} from './helpers';
import { setLocale, t } from './i18n';

type AnyRecord = Record<string, unknown>;

export type StatusArea = 'general' | 'models' | 'oauth' | 'mcp';

export interface StatusLine {
  ok: boolean;
  text: string;
}

function asRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

/** res 回执通用判读：{ok:false} / {error} / 纯字符串视为失败并带出文案。 */
function outcomeOf(payload: unknown): { ok: boolean; message: string } {
  if (typeof payload === 'string') {
    return { ok: false, message: payload };
  }
  const rec = asRecord(payload);
  const error = typeof rec.error === 'string' ? rec.error : '';
  const ok = rec.ok !== false && error.length === 0;
  const message = typeof rec.message === 'string' ? rec.message : error;
  return { ok, message };
}

/** res models/state 是否真是表单载荷（host 未实现时回 {ok:false,error}）。 */
function looksLikeModelsState(payload: unknown): boolean {
  const rec = asRecord(payload);
  if (rec.ok === false || typeof rec.error === 'string') {
    return false;
  }
  return typeof rec.baseUrl === 'string' || typeof rec.hasKey === 'boolean';
}

let reqSeq = 0;

export const useSettingsStore = defineStore('ops-settings', {
  state: () => ({
    activeTab: 'general' as SettingsTabId,
    hydrated: false,
    /** 已保存配置（对比基准）与编辑稿。 */
    config: { ...CONFIG_DEFAULTS } as OpsConfig,
    draft: { ...CONFIG_DEFAULTS } as OpsConfig,
    /** settings/patchConfig 在途请求数（全部 ok 后才提交 config=draft）。 */
    pendingConfigSaves: 0,
    /** 本次保存因组织下限收紧了 sessionRequiredFor。 */
    pendingFloorClampNotice: false,
    models: emptyModelsForm() as ModelsForm,
    /** 收到过 models/state（evt 或合法 res）⇒ host 支持 models/* 家族。 */
    modelsChannel: false,
    /** 「保存并测试」链路状态：save 回执 ok 后自动发 models/test。 */
    testingModel: false,
    /** 本次 save 是否要在回执后接 models/test（缺 key 时不测，直接黄字警告）。 */
    pendingTestAfterSave: false,
    /** 本次 save 是否带了新 key（回执后本地把 hasKey 翻真，不等 host 状态）。 */
    sentApiKey: false,
    /** models/fetch 在途标志与拉回的模型 id 建议（datalist）。 */
    fetchingModels: false,
    modelSuggestions: [] as string[],
    oauthBusy: false,
    providers: [] as ProviderRow[],
    mcpPath: '',
    /** host 下发的已打码文本（对比基准）与编辑稿。 */
    mcpText: '',
    mcpDraft: '',
    sessions: [] as SessionRow[],
    activeSessionId: '',
    status: {} as Partial<Record<StatusArea, StatusLine>>,
    mock: false
  }),

  getters: {
    generalDirty(state): boolean {
      return buildConfigPatch(state.config, state.draft) !== null;
    },
    mcpDirty(state): boolean {
      return state.mcpDraft !== state.mcpText;
    },
    mcpParse(state): McpParseResult {
      return parseMcpConfig(state.mcpDraft);
    }
  },

  actions: {
    post(type: string, payload: unknown = {}): void {
      reqSeq += 1;
      const envelope: Envelope = {
        v: 1,
        id: `wvs-${Date.now().toString(36)}-${reqSeq}`,
        dir: 'req',
        type,
        payload,
        ts: Date.now()
      };
      getVsCodeApi().postMessage(envelope);
    },

    setTab(tab: SettingsTabId): void {
      this.activeTab = tab;
      getVsCodeApi().setState({ tab });
    },

    setStatus(area: StatusArea, ok: boolean, text: string): void {
      this.status = { ...this.status, [area]: { ok, text } };
    },

    attach(): void {
      this.mock = isMockHost();
      const saved = asRecord(getVsCodeApi().getState());
      if (saved.tab !== undefined) {
        this.activeTab = normalizeTabId(saved.tab);
      }
      window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as Partial<Envelope> | undefined;
        if (!data || data.v !== 1 || typeof data.type !== 'string') {
          return;
        }
        if (data.dir === 'evt') {
          this.handleEvent(data.type, data.payload);
        } else if (data.dir === 'res') {
          this.handleResponse(data.type, data.payload);
        }
      });
      // 启动 hydrate：主协议 + 兜底（host 对未知 type 回错误 res，静默忽略）。
      this.post('settings/hydrate', {});
      this.post('hydrate', {});
      this.post('models/state', {});
    },

    handleEvent(type: string, payload: unknown): void {
      switch (type) {
        case 'settings/hydrate':
        case 'hydrate':
          this.applySnapshot(payload);
          break;
        case 'settings/tab':
          this.setTab(normalizeTabId(asRecord(payload).tab));
          break;
        case 'settings/config':
          this.applyConfig(payload);
          break;
        case 'models/state':
        case 'models/saved':
          this.modelsChannel = true;
          this.applyModels(payload);
          if (type === 'models/saved') {
            this.setStatus('models', true, t('saved'));
          }
          break;
        case 'models/error':
        case 'error':
          if (typeof payload === 'string' && payload.length > 0) {
            this.setStatus('models', false, payload);
          }
          break;
        case 'models/oauthStatus':
        case 'oauthStatus':
          this.applyOauthStatus(payload);
          break;
        case 'capabilities/snapshot':
          this.applyProviders(payload);
          break;
        case 'mcp/state':
          this.applyMcp(payload);
          break;
        case 'sessions/state':
          this.applySessions(payload);
          break;
        default:
          break;
      }
    },

    /** res：与请求同 type 的回执（settingsView 模式：数据或 {ok,error}）。 */
    handleResponse(type: string, payload: unknown): void {
      switch (type) {
        case 'settings/hydrate':
          this.applySnapshot(payload);
          break;
        case 'hydrate':
          // chat 快照兜底：只吸收公共字段（providers/sessions/locale）。
          this.applySnapshot(payload);
          break;
        case 'settings/patchConfig': {
          const outcome = outcomeOf(payload);
          if (!outcome.ok) {
            this.pendingConfigSaves = 0;
            this.pendingFloorClampNotice = false;
            this.setStatus('general', false, outcome.message || t('saveFailed'));
            break;
          }
          if (this.pendingConfigSaves > 0) {
            this.pendingConfigSaves -= 1;
            if (this.pendingConfigSaves === 0) {
              this.config = { ...this.draft };
              const notice = this.pendingFloorClampNotice
                ? t('policyFloorClamped')
                : t('saved');
              this.pendingFloorClampNotice = false;
              this.setStatus('general', true, notice);
            }
          }
          break;
        }
        case 'models/state':
          if (looksLikeModelsState(payload)) {
            this.modelsChannel = true;
            this.applyModels(payload);
          }
          break;
        case 'models/save': {
          const outcome = outcomeOf(payload);
          const runTest = this.pendingTestAfterSave;
          const hadNewKey = this.sentApiKey;
          this.pendingTestAfterSave = false;
          this.sentApiKey = false;
          if (!outcome.ok) {
            this.setStatus('models', false, outcome.message || t('saveFailed'));
            break;
          }
          this.modelsChannel = true;
          const rec = asRecord(payload);
          const state = rec.state ?? payload;
          // host 无参读 models/state 恒回第一个 provider：只有同 provider 才吸收，
          // 避免用户刚保存的非第一 provider 表单被覆盖。
          if (
            looksLikeModelsState(state) &&
            (asRecord(state).providerId === this.models.providerId || !this.models.providerId)
          ) {
            this.applyModels(state);
          } else if (hadNewKey) {
            this.models.hasKey = true;
          }
          const warning = typeof rec.warning === 'string' ? rec.warning : '';
          if (!runTest) {
            // P0-B：缺 key 时不许报绿色「已保存」——黄字警告 + 不跑连通性测试。
            this.setStatus('models', false, warning || t('mKeyMissingWarn'));
            break;
          }
          this.testingModel = true;
          this.setStatus('models', true, t('mTesting'));
          this.post('models/test', buildModelsTestReq(this.models));
          break;
        }
        case 'models/test': {
          this.testingModel = false;
          const rec = asRecord(payload);
          if (rec.ok === true) {
            const latency =
              typeof rec.latencyMs === 'number' ? `（${Math.round(rec.latencyMs)} ms）` : '';
            this.setStatus('models', true, `${t('mTestOk')}${latency}`);
          } else {
            const message =
              rec.httpStatus === 401
                ? t('mTest401')
                : `${t('mTestFail')}${typeof rec.error === 'string' && rec.error ? rec.error : t('saveFailed')}`;
            this.setStatus('models', false, message);
          }
          break;
        }
        case 'models/fetch': {
          this.fetchingModels = false;
          const rec = asRecord(payload);
          if (rec.ok === false || typeof rec.error === 'string') {
            this.setStatus(
              'models',
              false,
              `${t('mFetchFail')}${typeof rec.error === 'string' && rec.error ? rec.error : ''}`
            );
            break;
          }
          const models = normalizeFetchedModels(payload);
          this.modelSuggestions = models;
          if (models.length > 0 && this.models.modelId.trim().length === 0) {
            this.models.modelId = models[0];
          }
          this.setStatus('models', true, `${t('mFetchOk')}${models.length} ${t('mFetchOkUnit')}`);
          break;
        }
        case 'models/oauth':
          this.applyOauthStatus(payload);
          break;
        case 'capabilities/refresh':
          this.applyProviders(payload);
          break;
        case 'mcp/get':
          if (asRecord(payload).text !== undefined) {
            this.applyMcp(payload);
          }
          break;
        case 'mcp/save': {
          const outcome = outcomeOf(payload);
          if (outcome.ok) {
            this.mcpText = this.mcpDraft;
            this.setStatus('mcp', true, outcome.message || t('saved'));
            // host 落盘时已从原文件回填 *** 占位；重新拉取脱敏稿保持同步。
            this.post('mcp/get', {});
          } else {
            this.setStatus('mcp', false, outcome.message || t('saveFailed'));
          }
          break;
        }
        case 'session/list':
          this.applySessions(payload);
          break;
        case 'session/new': {
          const rec = asRecord(payload);
          if (rec.ok !== false && typeof rec.sessionId === 'string') {
            this.activeSessionId = rec.sessionId;
          }
          this.post('session/list', {});
          break;
        }
        case 'session/switch':
          this.post('session/list', {});
          break;
        default:
          break;
      }
    },

    applySnapshot(payload: unknown): void {
      const snapshot = normalizeSettingsSnapshot(payload);
      setLocale(snapshot.locale);
      const rec = asRecord(payload);
      // 只有真的带 config 字段才覆盖（chat hydrate 兜底时没有 config）；
      // 覆盖时保留用户未保存的编辑（diff 重放到新基准上）。
      if (rec.config !== undefined || rec.settings !== undefined) {
        const localEdits = buildConfigPatch(this.config, this.draft);
        this.config = snapshot.config;
        this.draft = { ...snapshot.config, ...(localEdits ?? {}) };
        this.hydrated = true;
      }
      if (snapshot.models) {
        this.models = normalizeModelsState(snapshot.models, this.models);
      } else {
        // host 未实现 models/* 时，至少吸收快照顶层的 modelsPath / agentDir。
        if (snapshot.modelsPath && !this.models.modelsPath) {
          this.models.modelsPath = snapshot.modelsPath;
        }
        if (snapshot.agentDir && !this.models.authPath) {
          const sep = snapshot.agentDir.includes('\\') ? '\\' : '/';
          this.models.authPath = `${snapshot.agentDir.replace(/[\\/]+$/, '')}${sep}auth.json`;
        }
      }
      if (rec.providers !== undefined || rec.capabilities !== undefined) {
        this.providers = snapshot.providers;
      }
      if (rec.mcp !== undefined) {
        this.applyMcp(rec.mcp);
      }
      // snapshot.skills 不吸收：内置技能是 Agent 内部资源，设置页无技能目录。
      if (snapshot.activeSessionId) {
        this.activeSessionId = snapshot.activeSessionId;
      }
      if (rec.sessions !== undefined) {
        this.sessions = snapshot.sessions;
      }
    },

    applyConfig(payload: unknown): void {
      const rec = asRecord(payload);
      const config = normalizeConfig(rec.config ?? payload);
      this.config = config;
      this.draft = { ...config };
      this.hydrated = true;
    },

    applyModels(payload: unknown): void {
      this.models = normalizeModelsState(payload, this.models);
    },

    applyOauthStatus(payload: unknown): void {
      this.oauthBusy = false;
      const outcome = outcomeOf(payload);
      this.setStatus('oauth', outcome.ok, outcome.message);
    },

    applyProviders(payload: unknown): void {
      const rec = asRecord(payload);
      if (Array.isArray(payload) || Array.isArray(rec.providers)) {
        this.providers = normalizeProviders(payload);
      }
    },

    applyMcp(payload: unknown): void {
      const wasDirty = this.mcpDraft !== this.mcpText;
      const state = normalizeMcpState(payload);
      this.mcpPath = state.path || this.mcpPath;
      this.mcpText = state.text;
      if (!wasDirty) {
        this.mcpDraft = state.text;
      }
      if (state.error) {
        this.setStatus('mcp', false, state.error);
      }
    },

    applySessions(payload: unknown): void {
      const rec = asRecord(payload);
      if (typeof rec.activeSessionId === 'string' && rec.activeSessionId) {
        this.activeSessionId = rec.activeSessionId;
      }
      const list = Array.isArray(payload) ? payload : rec.sessions;
      if (Array.isArray(list)) {
        this.sessions = normalizeSessions(list, this.activeSessionId);
      }
    },

    // ── 常规 ──
    saveGeneral(): void {
      const { config: clampedDraft, clamped } = clampConfigToPolicyFloor(this.draft);
      this.draft = clampedDraft;
      const requests = buildConfigPatchRequests(this.config, this.draft);
      if (requests.length === 0) {
        this.setStatus('general', true, clamped ? t('policyFloorClamped') : t('noChanges'));
        return;
      }
      this.pendingConfigSaves = requests.length;
      this.pendingFloorClampNotice = clamped;
      for (const req of requests) {
        this.post('settings/patchConfig', req);
      }
    },

    openVsCodeSettings(): void {
      this.post('settings/openJson', { kind: 'vscode' });
    },

    // ── 模型 ──
    /** Provider 预设下拉：预填 baseUrl / api / thinkingFormat（P0-B / P1-1）。 */
    selectProviderPreset(presetId: string): void {
      this.models = applyProviderPreset(this.models, presetId);
      // 换 provider 后旧目录不再适用。
      this.modelSuggestions = [];
    },

    /**
     * 「保存并测试」：models/save 成功后自动 models/test（1-token / GET models 探测，
     * host 路由）。缺 key（且非 OAuth 预设）时仍落盘但以黄字警告呈现，不跑测试、
     * 绝不显示绿色「已保存」（P0-B）。
     */
    saveAndTestModels(): void {
      const result = buildModelsSavePayload(this.models);
      if (!result.ok) {
        this.setStatus('models', false, t('mRequired'));
        return;
      }
      const keyMissing = modelsKeyMissing(this.models);
      this.pendingTestAfterSave = !keyMissing;
      this.sentApiKey = typeof result.payload.apiKey === 'string';
      this.post('models/save', result.payload);
      // key 只上行一次，本地立即抹掉（绝不驻留、绝不回显）。
      this.models.apiKey = '';
      if (keyMissing) {
        this.setStatus('models', false, t('mKeyMissingWarn'));
      }
    },

    /** 「拉取模型列表」：GET {baseUrl}/models（host 路由 models/fetch），回填建议。 */
    fetchModels(): void {
      const baseUrl = this.models.baseUrl.trim();
      if (baseUrl.length === 0) {
        this.setStatus('models', false, t('mRequired'));
        return;
      }
      this.fetchingModels = true;
      this.setStatus('models', true, t('mFetching'));
      this.post('models/fetch', buildModelsFetchReq(this.models));
    },

    oauthLogin(): void {
      const providerId = resolveOauthProvider(this.models);
      if (!providerId) {
        return;
      }
      this.oauthBusy = true;
      this.setStatus('oauth', true, t('mOauthPending'));
      this.post('models/oauth', { providerId });
    },

    openModelsJson(): void {
      const req = openModelsFileReq(this.modelsChannel);
      this.post(req.type, req.payload);
    },

    openAuthJson(): void {
      const req = openAuthFileReq(this.modelsChannel);
      this.post(req.type, req.payload);
    },

    // ── 能力插件 ──
    refreshCapabilities(): void {
      // capabilities/refresh 是预留别名；settings/hydrate 是当前 host 的真源
      // （applySnapshot 会保留未保存的本地编辑）。
      this.post('capabilities/refresh', {});
      this.post('settings/hydrate', {});
    },

    diagnose(): void {
      this.post('diagnose', {});
    },

    // ── MCP ──
    saveMcp(): void {
      const parse = parseMcpConfig(this.mcpDraft);
      if (!parse.ok) {
        this.setStatus('mcp', false, `${t('mcpInvalid')}${parse.error ?? ''}`);
        return;
      }
      // 编辑稿仍是打码文本：*** 占位由 host 用原始文件回填后落盘（0600）。
      this.post('mcp/save', { text: this.mcpDraft });
    },

    openMcpJson(): void {
      this.post('settings/openJson', { kind: 'mcp' });
    },

    // ── 会话 ──
    newSession(): void {
      this.post('session/new', {});
    },

    switchSession(id: string): void {
      if (!id || id === this.activeSessionId) {
        return;
      }
      // 乐观更新；res session/switch 后再用 session/list 校准。
      this.activeSessionId = id;
      this.sessions = this.sessions.map((s) => ({ ...s, active: s.id === id }));
      this.post('session/switch', { id });
    }
  }
});
