/**
 * 模型服务：模型清单（models.json，不含凭证）、当前选择与持久化、
 * SecretStorage key 状态位、连通性测试（P0-B「保存并测试」）、
 * 模型目录拉取（P1-1）、OAuth 登录、思考等级解析。
 * 换模型触发的 runtime 重建按席位调度（各会话 idle 后续接重建）。
 */
import * as vscode from 'vscode';
import type {
  HydrateEvt,
  ModelSetReq,
  ModelsFetchReq,
  ModelsFetchRes,
  ModelsTestReq,
  ModelsTestRes
} from '../../protocol';
import { normalizeThinkingLevel, patchAgentSettings, readAgentSettings } from '../agentSettings';
import type { ThinkingLevel } from '../hostTypes';
import { listConfiguredModels, pickSelectedModel, readLastModel } from '../modelsCatalog';
import { fetchModelCatalog, probeOpenAiCompatible } from '../modelsProbe';
import {
  deleteModelEntry,
  deleteProviderEntry,
  openModelsJson,
  readFullModelsConfig,
  saveModelsForm
} from '../modelsView';
import { loginOAuthViaPi, openAuthJson } from '../oauthLogin';
import { describeError, isPlainRecord, type HostContext } from './context';

export class ModelService {
  private modelSelection: ModelSetReq | undefined;
  /** SecretStorage 是否已有 LLM key（异步刷新；选择器不依赖此字段显示清单）。 */
  private hasApiKey = false;

  constructor(private readonly ctx: HostContext) {
    this.modelSelection = readLastModel(ctx.agentDir);
  }

  /** SecretStorage 是否有 LLM key（状态栏未配置警示消费）。 */
  get hasModelApiKey(): boolean {
    return this.hasApiKey;
  }

  get selection(): ModelSetReq | undefined {
    return this.modelSelection;
  }

  /** activate 后台预热：key 状态 + 模型清单，完成后广播 capabilities。 */
  async bootstrapModelCatalog(): Promise<void> {
    await this.refreshModelKeyFlag();
    const models = listConfiguredModels(this.ctx.modelsPath);
    const selected = pickSelectedModel(
      models,
      this.modelSelection ?? readLastModel(this.ctx.agentDir)
    );
    if (selected) this.modelSelection = { ...this.modelSelection, ...selected };
    this.ctx.broadcast('capabilities/snapshot', this.ctx.chat.chatCapabilitiesPayload());
  }

  async refreshModelKeyFlag(): Promise<void> {
    const before = this.hasApiKey;
    try {
      const key = await this.ctx.secrets.getLlmApiKey(this.modelSelection?.provider);
      this.hasApiKey = typeof key === 'string' && key.length > 0;
    } catch {
      this.hasApiKey = false;
    }
    if (this.hasApiKey !== before) this.ctx.fireStatusChanged();
  }

  /** 聊天选择器 / hydrate 共用的模型清单（读 models.json，不含凭证）。 */
  chatModelsExtra(): Partial<HydrateEvt> {
    const models = listConfiguredModels(this.ctx.modelsPath);
    const selected = pickSelectedModel(models, this.modelSelection);
    const usage = this.ctx.chat.usageOf(this.ctx.store.activeSessionId);
    return {
      models,
      ...(selected !== undefined
        ? { model: selected.model, modelProvider: selected.provider }
        : {}),
      hasApiKey: this.hasApiKey,
      onboarded: models.length > 0,
      locale: vscode.env.language,
      ...(usage !== undefined ? { usage } : {})
    };
  }

  /** runtime 创建期的模型偏好（models.json ∩ 当前选择）。 */
  resolveRuntimeModelPref(): { provider?: string; id?: string } | undefined {
    const models = listConfiguredModels(this.ctx.modelsPath);
    const selected = pickSelectedModel(models, this.modelSelection);
    if (!selected) return undefined;
    if (!this.modelSelection) this.modelSelection = selected;
    return { provider: selected.provider, id: selected.model };
  }

  async setModel(req: ModelSetReq): Promise<{ ok: boolean }> {
    const ctx = this.ctx;
    this.modelSelection = req;
    void patchAgentSettings(ctx.agentDir, {
      lastModel: { provider: req.provider, model: req.model }
    }).catch((err) => ctx.log(`[models] 持久化 lastModel 失败: ${describeError(err)}`));
    void this.refreshModelKeyFlag();
    // 真 runtime 的模型在创建期绑定：各席位空闲时释放实例，下次 prompt
    // 按新模型重建并经 resumeSessionFile 续接同一会话（P0-C 不失忆）。
    ctx.chat.scheduleRebuildAll(`切换模型 ${req.provider}/${req.model}`);
    ctx.broadcast('capabilities/snapshot', ctx.chat.chatCapabilitiesPayload());
    return { ok: true };
  }

  async modelsFormState(): Promise<Record<string, unknown>> {
    const full = await readFullModelsConfig({
      modelsPath: this.ctx.modelsPath,
      agentDir: this.ctx.agentDir,
      secrets: this.ctx.secrets
    });
    return {
      ...full.currentForm,
      providerGroups: full.providers,
      modelList: full.models,
      defaultModel: full.defaultModel
    };
  }

  async deleteModel(payload: { providerId: string; modelId: string }): Promise<{ ok: boolean; error?: string; state?: Record<string, unknown> }> {
    const result = await deleteModelEntry(
      { modelsPath: this.ctx.modelsPath, agentDir: this.ctx.agentDir, secrets: this.ctx.secrets },
      payload.providerId,
      payload.modelId
    );
    if (!result.ok) {
      return result;
    }
    await this.refreshModelKeyFlag();
    this.ctx.broadcast('capabilities/snapshot', this.ctx.chat.chatCapabilitiesPayload());
    this.ctx.broadcast('hydrate', this.ctx.chat.snapshot());
    return { ok: true, state: await this.modelsFormState() };
  }

  async deleteProvider(payload: { providerId: string }): Promise<{ ok: boolean; error?: string; state?: Record<string, unknown> }> {
    const result = await deleteProviderEntry(
      { modelsPath: this.ctx.modelsPath, agentDir: this.ctx.agentDir, secrets: this.ctx.secrets },
      payload.providerId
    );
    if (!result.ok) {
      return result;
    }
    await this.refreshModelKeyFlag();
    this.ctx.broadcast('capabilities/snapshot', this.ctx.chat.chatCapabilitiesPayload());
    this.ctx.broadcast('hydrate', this.ctx.chat.snapshot());
    return { ok: true, state: await this.modelsFormState() };
  }

  async saveModelsFromSettings(payload: unknown): Promise<{
    ok: boolean;
    error?: string;
    state?: Record<string, unknown>;
  }> {
    const ctx = this.ctx;
    const outcome = await saveModelsForm(
      { modelsPath: ctx.modelsPath, agentDir: ctx.agentDir, secrets: ctx.secrets },
      isPlainRecord(payload) ? payload : {}
    );
    if (outcome.error !== undefined) {
      return { ok: false, error: outcome.error };
    }
    if (outcome.applied) {
      try {
        await this.setModel(outcome.applied);
      } catch (err) {
        ctx.log(`[models] setModel 同步失败: ${describeError(err)}`);
      }
    }
    await this.refreshModelKeyFlag();
    ctx.broadcast('capabilities/snapshot', ctx.chat.chatCapabilitiesPayload());
    ctx.broadcast('hydrate', ctx.chat.snapshot());
    // 保存后立刻重建活动会话 runtime，避免聊天仍走「未配置模型」的 Fallback。
    void ctx.chat.ensureActiveRuntime().catch((err) =>
      ctx.log(`[runtime] 保存模型后重建失败: ${describeError(err)}`)
    );
    return { ok: true, state: await this.modelsFormState() };
  }

  /**
   * models/test（P0-B「保存并测试」）：GET /models，404/405 退 1-token
   * chat completion。key 取 payload（表单未存态）或 SecretStorage 按 provider；
   * 错误信息已在 modelsProbe 分类脱敏，key 绝不落日志。
   */
  async testModel(req: ModelsTestReq): Promise<ModelsTestRes> {
    const baseUrl = typeof req?.baseUrl === 'string' ? req.baseUrl.trim() : '';
    if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };
    const apiKey =
      typeof req.apiKey === 'string' && req.apiKey.length > 0
        ? req.apiKey
        : await this.ctx.secrets.getLlmApiKey(req.provider).catch(() => undefined);
    const result = await probeOpenAiCompatible({
      baseUrl,
      ...(typeof req.modelId === 'string' ? { modelId: req.modelId } : {}),
      ...(apiKey !== undefined ? { apiKey } : {})
    });
    this.ctx.log(
      `[models] 连通性测试 ${result.ok ? '通过' : '失败'}` +
        (result.latencyMs !== undefined ? `（${result.latencyMs}ms）` : '') +
        (result.error !== undefined ? `：${result.error}` : '')
    );
    return {
      ...result,
      modelId: req.modelId,
      provider: req.provider
    };
  }

  /** models/fetch（P1-1）：GET /models 拉模型目录，供设置页下拉选择。 */
  async fetchModels(req: ModelsFetchReq): Promise<ModelsFetchRes> {
    const baseUrl = typeof req?.baseUrl === 'string' ? req.baseUrl.trim() : '';
    if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };
    const apiKey =
      typeof req.apiKey === 'string' && req.apiKey.length > 0
        ? req.apiKey
        : await this.ctx.secrets.getLlmApiKey(req.provider).catch(() => undefined);
    return fetchModelCatalog({ baseUrl, ...(apiKey !== undefined ? { apiKey } : {}) });
  }

  /**
   * Models 面板 OAuth 页入口：优先活动会话 runtime.loginOAuth（已创建且
   * 支持时），否则 host 直驱 pi ModelRuntime.login（src/host/oauthLogin.ts）。
   * 结果消息绝不含 token。
   */
  async loginOAuth(providerId: string): Promise<{ ok: boolean; message: string }> {
    const ctx = this.ctx;
    const trimmed = typeof providerId === 'string' ? providerId.trim() : '';
    if (trimmed.length === 0) return { ok: false, message: '请先填写 provider id。' };
    const runtime = ctx.chat.runtimeFor(ctx.store.activeSessionId);
    if (runtime?.loginOAuth) {
      try {
        await runtime.loginOAuth(trimmed);
        return { ok: true, message: `OAuth 登录完成（${trimmed}），凭证已写入 auth.json。` };
      } catch (err) {
        ctx.log(`[oauth] runtime.loginOAuth 失败: ${describeError(err)}，改走 host 直驱`);
      }
    }
    return loginOAuthViaPi({ providerId: trimmed, agentDir: ctx.agentDir, log: (m) => ctx.log(m) });
  }

  /** 思考等级：会话内 model/set → agentDir settings.json → 配置默认（medium）。 */
  async resolveThinkingLevel(config: vscode.WorkspaceConfiguration): Promise<ThinkingLevel> {
    if (this.modelSelection?.thinkingLevel) return this.modelSelection.thinkingLevel;
    const fromSettings = normalizeThinkingLevel(
      (await readAgentSettings(this.ctx.agentDir)).thinkingLevel
    );
    if (fromSettings) return fromSettings;
    return (
      normalizeThinkingLevel(config.get<string>('models.defaultThinkingLevel', 'medium')) ??
      'medium'
    );
  }

  /** settings/openJson 的 models/auth 分支（ConfigService 复用）。 */
  async openModelsFile(): Promise<void> {
    await openModelsJson({ modelsPath: this.ctx.modelsPath, output: this.ctx.outputChannel });
  }

  async openAuthFile(): Promise<void> {
    await openAuthJson(this.ctx.agentDir);
  }
}
