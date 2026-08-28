/**
 * settings webview 单测（docs/09 §8 组件测降级路径 + docs/11 P0-B/P1-1/P1-9/P1-12）。
 *
 * vitest 没有 vue SFC 编译插件（不改 package.json），所以不 mount .vue 组件；
 * 测组件抽出的纯 TS helper（src/webview-settings/helpers.ts + i18n.ts）与
 * host 侧纯函数（src/host/modelsView.ts / secrets.ts，均无顶层 vscode import）：
 * - 页签清单（Roo 式竖排导航的数据源）与 tab 归一
 * - 配置绑定（atOpsAgent.* 全键覆盖，含 P1-9 只读免审名单）、diff 与单键载荷
 * - 密钥打码 / ***还原（mcp.json 往返红线：明文凭证绝不经过 webview）
 * - mcp.json 解析（servers / mcpServers；卡片数据；AT Series hub.js 跳过）
 * - Provider 预设（P0-B 向导：预填 baseUrl / api / compat）
 * - models/save 载荷（reasoning 字段；apiKey 留空 = 保持现有 key，绝不回显）
 * - P0-B 缺 key 禁止报「已保存」（modelsKeyMissing / keyMissingWarning）
 * - host saveModelsForm：写 reasoning、按 providerId upsert、per-provider 占位符、
 *   roleModels 落 settings.json
 * - secrets：per-provider 键 atOpsAgent.apiKey.<id>，旧键回退 + 一次性迁移
 * - settings/hydrate 快照归一（host settingsSnapshot 真实形状）
 * - models/* 家族探测后的打开文件路由（避免双开）
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODELS_TEMPLATE,
  keyMissingWarning,
  readModelsFormState,
  saveModelsForm
} from '../src/host/modelsView';
import {
  LLM_API_KEY_SECRET,
  OpsSecrets,
  apiKeyPlaceholder,
  providerApiKeySecret
} from '../src/host/secrets';
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  CUSTOM_PROVIDER_ID,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PRESETS,
  REDACTED,
  SETTINGS_TABS,
  applyProviderPreset,
  buildConfigPatch,
  buildConfigPatchRequests,
  buildModelsFetchReq,
  buildModelsSavePayload,
  buildModelsTestReq,
  emptyModelsForm,
  modelsKeyMissing,
  normalizeConfig,
  normalizeFetchedModels,
  normalizeModelsState,
  normalizeSettingsSnapshot,
  normalizeSessions,
  normalizeTabId,
  openAuthFileReq,
  openModelsFileReq,
  parseMcpConfig,
  presetIdForProvider,
  redactMcpText,
  redactSecretsDeep,
  restoreRedactedSecrets,
  toStringList
} from '../src/webview-settings/helpers';
import { normalizeLocale, setLocale, t } from '../src/webview-settings/i18n';

beforeEach(() => {
  setLocale('zh-CN');
});

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'settings-ui-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** vscode SecretStorage 的内存替身（OpsSecrets 只用 get/store/delete）。 */
function makeSecrets(): { secrets: OpsSecrets; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    get: async (key: string) => map.get(key),
    store: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    onDidChange: () => ({ dispose(): void {} })
  };
  return {
    secrets: new OpsSecrets(storage as unknown as ConstructorParameters<typeof OpsSecrets>[0]),
    map
  };
}

describe('页签清单（SettingsApp 左侧竖排导航数据源）', () => {
  it('五个页签，顺序 = 常规/模型/能力插件/MCP/会话（无技能页签）', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      'general',
      'models',
      'capabilities',
      'mcp',
      'sessions'
    ]);
    expect(SETTINGS_TABS.map((tab) => tab.id)).not.toContain('skills');
  });

  it('每个页签在 zh-CN 与 en 都有非空标签', () => {
    for (const tab of SETTINGS_TABS) {
      setLocale('zh-CN');
      const zh = t(tab.labelKey);
      setLocale('en');
      const en = t(tab.labelKey);
      expect(zh.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
    }
    setLocale('zh-CN');
    expect(t('navGeneral')).toBe('常规');
    setLocale('en');
    expect(t('navGeneral')).toBe('General');
  });

  it('normalizeTabId：未知 / 缺失一律归 general；历史 skills 页签也归 general', () => {
    expect(normalizeTabId('mcp')).toBe('mcp');
    expect(normalizeTabId('models')).toBe('models');
    expect(normalizeTabId('skills')).toBe('general');
    expect(normalizeTabId('garbage')).toBe('general');
    expect(normalizeTabId(undefined)).toBe('general');
  });
});

describe('常规配置：绑定键覆盖、归一化与 patch 载荷', () => {
  it('CONFIG_FIELDS 覆盖全部 atOpsAgent.* 键（含 P1-9 只读免审名单）', () => {
    expect(CONFIG_FIELDS.map((field) => field.key).sort()).toEqual(
      [
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
        'streaming.batchMs'
      ].sort()
    );
  });

  it('GeneralTab 标签是人话，不再是裸配置键（P1-12 键名去键名化）', () => {
    setLocale('zh-CN');
    for (const field of CONFIG_FIELDS) {
      const label = t(field.labelKey as Parameters<typeof t>[0]);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain(field.key);
    }
  });

  it('normalizeConfig：空载荷回默认值；坏枚举回退；maxParallel 钳到 1–4', () => {
    expect(normalizeConfig({})).toEqual(CONFIG_DEFAULTS);
    const config = normalizeConfig({
      'discovery.mode': 'nonsense',
      'subagent.maxParallel': 9,
      'streaming.batchMs': '80'
    });
    expect(config['discovery.mode']).toBe('auto');
    expect(config['subagent.maxParallel']).toBe(4);
    expect(config['streaming.batchMs']).toBe(80);
  });

  it('normalizeConfig：接受 atOpsAgent. 前缀键与嵌套形状', () => {
    expect(normalizeConfig({ 'atOpsAgent.discovery.mode': 'always' })['discovery.mode']).toBe(
      'always'
    );
    const nested = normalizeConfig({
      discovery: { mode: 'off', threshold: 30 },
      approval: { sessionRequiredFor: 'never', sessionReadAllowlist: ['db_query'] }
    });
    expect(nested['discovery.mode']).toBe('off');
    expect(nested['discovery.threshold']).toBe(30);
    expect(nested['approval.sessionRequiredFor']).toBe('never');
    expect(nested['approval.sessionReadAllowlist']).toEqual(['db_query']);
  });

  it('sessionReadAllowlist：数组按元素收、字符串按逗号切、脏值丢弃', () => {
    expect(toStringList([' db_query ', '', 'log_search', 3 as unknown as string])).toEqual([
      'db_query',
      'log_search'
    ]);
    expect(toStringList('db_query, log_search,\nmetrics_read')).toEqual([
      'db_query',
      'log_search',
      'metrics_read'
    ]);
    expect(toStringList(undefined)).toEqual([]);
  });

  it('buildConfigPatch：无改动 → null；只含改动键；数组按值比较', () => {
    const saved = { ...CONFIG_DEFAULTS };
    expect(buildConfigPatch(saved, { ...saved })).toBeNull();
    // 数组内容相同但引用不同：不算改动
    expect(
      buildConfigPatch(saved, { ...saved, 'approval.sessionReadAllowlist': [] })
    ).toBeNull();
    const edited = {
      ...saved,
      'discovery.mode': 'always' as const,
      'approval.sessionReadAllowlist': ['db_query']
    };
    expect(buildConfigPatch(saved, edited)).toEqual({
      'discovery.mode': 'always',
      'approval.sessionReadAllowlist': ['db_query']
    });
  });

  it('buildConfigPatchRequests：host 契约单键 {key,value}，改几键发几条', () => {
    const saved = { ...CONFIG_DEFAULTS };
    expect(buildConfigPatchRequests(saved, { ...saved })).toEqual([]);
    const edited = {
      ...saved,
      'workspaceShell.enabled': true,
      'approval.sessionReadAllowlist': ['db_query', 'log_search']
    };
    const requests = buildConfigPatchRequests(saved, edited);
    expect(requests).toHaveLength(2);
    expect(requests).toContainEqual({ key: 'workspaceShell.enabled', value: true });
    expect(requests).toContainEqual({
      key: 'approval.sessionReadAllowlist',
      value: ['db_query', 'log_search']
    });
  });
});

describe('密钥打码与 *** 还原（凭证绝不经 webview 往返）', () => {
  const original = {
    mcpServers: {
      grafana: {
        command: 'npx',
        args: ['-y', 'grafana-mcp'],
        env: { GRAFANA_API_KEY: 'glsa_secret_123', REGION: 'cn-north' },
        headers: { Authorization: 'Bearer abc' }
      }
    }
  };

  it('redactSecretsDeep：命中密钥键名的字符串值 → ***；其余原样', () => {
    const redacted = redactSecretsDeep(original) as typeof original;
    expect(redacted.mcpServers.grafana.env.GRAFANA_API_KEY).toBe(REDACTED);
    expect(redacted.mcpServers.grafana.headers.Authorization).toBe(REDACTED);
    expect(redacted.mcpServers.grafana.env.REGION).toBe('cn-north');
    expect(redacted.mcpServers.grafana.command).toBe('npx');
    expect(redacted.mcpServers.grafana.args).toEqual(['-y', 'grafana-mcp']);
  });

  it('redactMcpText：整段 JSON 打码；坏 JSON 返回 null（绝不透传原文）', () => {
    const text = redactMcpText(JSON.stringify(original));
    expect(text).toContain(REDACTED);
    expect(text).not.toContain('glsa_secret_123');
    expect(redactMcpText('{ not json')).toBeNull();
  });

  it('restoreRedactedSecrets：保持 *** = 维持原值；新值覆盖；无原值保留 ***', () => {
    const edited = {
      mcpServers: {
        grafana: {
          command: 'npx',
          args: ['-y', 'grafana-mcp'],
          env: { GRAFANA_API_KEY: REDACTED, REGION: 'cn-south' },
          headers: { Authorization: 'Bearer new-token' }
        },
        fresh: { env: { API_TOKEN: REDACTED } }
      }
    };
    const restored = restoreRedactedSecrets(edited, original) as typeof edited;
    // 空 password 语义：保持 *** 的键取回旧凭证
    expect(restored.mcpServers.grafana.env.GRAFANA_API_KEY).toBe('glsa_secret_123');
    // 用户显式改写的值覆盖旧值
    expect(restored.mcpServers.grafana.headers.Authorization).toBe('Bearer new-token');
    expect(restored.mcpServers.grafana.env.REGION).toBe('cn-south');
    // 新增条目没有旧值：保留 ***（host 侧兜底）
    expect(restored.mcpServers.fresh.env.API_TOKEN).toBe(REDACTED);
  });
});

describe('mcp.json 解析（servers / mcpServers；卡片数据；AT Series hub 跳过）', () => {
  it('mcpServers map 形状：列出 server 名与卡片摘要', () => {
    const result = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', 'server-filesystem', '/data'] },
          jira: { url: 'https://jira.example/mcp' }
        }
      })
    );
    expect(result.ok).toBe(true);
    expect(result.serverNames.sort()).toEqual(['filesystem', 'jira']);
    expect(result.skippedAtSeries).toEqual([]);
    expect(result.servers).toEqual([
      { name: 'filesystem', summary: 'npx -y server-filesystem /data', skipped: false },
      { name: 'jira', summary: 'https://jira.example/mcp', skipped: false }
    ]);
  });

  it('servers 数组形状：按 name 字段列出', () => {
    const result = parseMcpConfig(
      JSON.stringify({ servers: [{ name: 'filesystem', command: 'npx' }] })
    );
    expect(result.ok).toBe(true);
    expect(result.serverNames).toEqual(['filesystem']);
    expect(result.servers[0]).toEqual({ name: 'filesystem', summary: 'npx', skipped: false });
  });

  it('AT Series hub 条目：按名字或 hub.js 路径（含 Windows 反斜杠）识别为跳过', () => {
    const result = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          'AT Series': { command: 'node', args: ['/home/dev/.at-series/mcp/hub.js'] },
          legacy: { command: 'node', args: ['C:\\Users\\dev\\.at-series\\mcp\\hub.js'] },
          filesystem: { command: 'npx' }
        }
      })
    );
    expect(result.ok).toBe(true);
    expect(result.skippedAtSeries.sort()).toEqual(['AT Series', 'legacy']);
    expect(result.servers.filter((s) => s.skipped).map((s) => s.name).sort()).toEqual([
      'AT Series',
      'legacy'
    ]);
  });

  it('空文本合法（0 server）；坏 JSON 报错误', () => {
    expect(parseMcpConfig('  ').ok).toBe(true);
    expect(parseMcpConfig('  ').serverNames).toEqual([]);
    const bad = parseMcpConfig('{ oops');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    expect(bad.servers).toEqual([]);
  });
});

describe('Provider 预设（P0-B / P1-1：预填 baseUrl / api / compat）', () => {
  it('六个预设：internal-gateway / openai / anthropic / deepseek / qwen / 自定义', () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      'internal-gateway',
      'openai',
      'anthropic',
      'deepseek',
      'qwen',
      CUSTOM_PROVIDER_ID
    ]);
    for (const preset of PROVIDER_PRESETS) {
      setLocale('zh-CN');
      expect(t(preset.labelKey).length).toBeGreaterThan(0);
      setLocale('en');
      expect(t(preset.labelKey).length).toBeGreaterThan(0);
    }
  });

  it('applyProviderPreset：deepseek 预填 baseUrl / api / thinkingFormat 与常见模型', () => {
    const form = applyProviderPreset(emptyModelsForm(), 'deepseek');
    expect(form.providerId).toBe('deepseek');
    expect(form.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(form.api).toBe('openai-completions');
    expect(form.thinkingFormat).toBe('deepseek');
    expect(form.modelId).toBe('deepseek-chat');
  });

  it('applyProviderPreset：anthropic 走 anthropic-messages 且标记 OAuth 可用', () => {
    const form = applyProviderPreset(emptyModelsForm(), 'anthropic');
    expect(form.api).toBe('anthropic-messages');
    expect(PROVIDER_PRESETS.find((p) => p.id === 'anthropic')?.oauth).toBe(true);
  });

  it('applyProviderPreset：不覆盖用户已输入的模型 id；自定义保留手输 baseUrl', () => {
    let form = emptyModelsForm();
    form.modelId = 'my-model';
    form = applyProviderPreset(form, 'qwen');
    expect(form.modelId).toBe('my-model');
    form.baseUrl = 'https://my-gateway.corp/v1';
    form = applyProviderPreset(form, CUSTOM_PROVIDER_ID);
    expect(form.baseUrl).toBe('https://my-gateway.corp/v1');
    expect(form.providerId).toBe(CUSTOM_PROVIDER_ID);
  });

  it('presetIdForProvider：未知 providerId 归到自定义（下拉不至于空选）', () => {
    expect(presetIdForProvider('openai')).toBe('openai');
    expect(presetIdForProvider('my-corp-gw')).toBe(CUSTOM_PROVIDER_ID);
  });

  it('OAuth 常见 provider 下拉：含 anthropic，不含 internal-gateway；默认非 internal-gateway', () => {
    expect(OAUTH_PROVIDER_IDS).toContain('anthropic');
    expect(OAUTH_PROVIDER_IDS).not.toContain('internal-gateway');
    expect(emptyModelsForm().oauthProvider).toBe(OAUTH_PROVIDER_IDS[0]);
  });
});

describe('models 表单：保存载荷与状态归一（key 永不回显；thinking→reasoning）', () => {
  it('baseUrl / modelId 必填', () => {
    const form = emptyModelsForm();
    expect(buildModelsSavePayload(form)).toEqual({ ok: false, error: 'required' });
    form.baseUrl = 'https://llm.example/v1';
    expect(buildModelsSavePayload(form).ok).toBe(false);
  });

  it('载荷字段名是 reasoning（不再发 thinking）；apiKey 留空 = 整键省略；不泄漏 hasKey/路径', () => {
    const form = emptyModelsForm();
    form.providerId = 'qwen';
    form.baseUrl = ' https://llm.example/v1 ';
    form.api = 'openai-completions';
    form.modelId = ' qwen3-max ';
    form.modelName = 'Qwen3 Max';
    form.reasoning = true;
    form.thinkingLevel = 'high';
    form.thinkingFormat = 'qwen';
    form.supportsDeveloperRole = false;
    form.hasKey = true;
    form.modelsPath = '/secret/models.json';

    const kept = buildModelsSavePayload(form);
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.payload).toEqual({
        providerId: 'qwen',
        baseUrl: 'https://llm.example/v1',
        api: 'openai-completions',
        modelId: 'qwen3-max',
        modelName: 'Qwen3 Max',
        reasoning: true,
        thinkingLevel: 'high',
        thinkingFormat: 'qwen',
        supportsDeveloperRole: false,
        roleModels: {}
      });
      expect('thinking' in kept.payload).toBe(false);
      expect('apiKey' in kept.payload).toBe(false);
      expect('hasKey' in kept.payload).toBe(false);
      expect('modelsPath' in kept.payload).toBe(false);
    }

    form.apiKey = '  sk-new-key  ';
    const withKey = buildModelsSavePayload(form);
    expect(withKey.ok && withKey.payload.apiKey).toBe('sk-new-key');
  });

  it('roleModels：只带 model 非空的角色；provider 留空回落当前 providerId', () => {
    const form = emptyModelsForm();
    form.providerId = 'internal-gateway';
    form.baseUrl = 'https://llm.example/v1';
    form.modelId = 'qwen3-max';
    form.roleModels.investigator.model = 'qwen-turbo';
    form.roleModels.writer = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
    const result = buildModelsSavePayload(form);
    expect(result.ok && result.payload.roleModels).toEqual({
      investigator: { provider: 'internal-gateway', model: 'qwen-turbo' },
      writer: { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    });
  });

  it('normalizeModelsState：即使 host 误发 apiKey 也强制置空；reasoning 兼容旧 thinking', () => {
    const state = normalizeModelsState({
      providerId: 'internal-gateway',
      baseUrl: 'https://llm/v1',
      modelId: 'qwen3-max',
      hasKey: true,
      apiKey: 'should-never-appear',
      thinking: true,
      thinkingFormat: 'nonsense',
      thinkingLevel: 'max',
      roleModels: { investigator: { provider: 'gw', model: 'cheap' }, bogus: { model: 'x' } }
    });
    expect(state.apiKey).toBe('');
    expect(state.hasKey).toBe(true);
    expect(state.reasoning).toBe(true);
    expect(state.thinkingFormat).toBe('default');
    expect(state.thinkingLevel).toBe('max');
    expect(state.roleModels.investigator).toEqual({ provider: 'gw', model: 'cheap' });
    expect(state.roleModels.writer).toEqual({ provider: '', model: '' });
    // OAuth 下拉默认常见 provider，而不是 internal-gateway
    expect(state.oauthProvider).toBe(OAUTH_PROVIDER_IDS[0]);
  });

  it('normalizeModelsState：previous 里用户已输入的 OAuth 选择不被覆盖', () => {
    const previous = emptyModelsForm();
    previous.oauthProvider = 'custom';
    previous.oauthProviderCustom = 'my-provider';
    const state = normalizeModelsState({ providerId: 'internal-gateway' }, previous);
    expect(state.oauthProvider).toBe('custom');
    expect(state.oauthProviderCustom).toBe('my-provider');
  });

  it('P0-B 缺 key 预检：无已存 key 且没填 → true；OAuth 预设豁免', () => {
    const form = emptyModelsForm();
    form.providerId = 'openai';
    expect(modelsKeyMissing(form)).toBe(true);
    form.apiKey = 'sk-x';
    expect(modelsKeyMissing(form)).toBe(false);
    form.apiKey = '';
    form.hasKey = true;
    expect(modelsKeyMissing(form)).toBe(false);
    const oauthForm = emptyModelsForm();
    oauthForm.providerId = 'anthropic';
    expect(modelsKeyMissing(oauthForm)).toBe(false);
  });

  it('首跑 placeholder 不得出现「留空 = 保持现有 key」暗示', () => {
    setLocale('zh-CN');
    expect(t('mApiKeyPlaceholderFirstRun')).not.toContain('保持现有');
    expect(t('mApiKeyPlaceholderFirstRun')).not.toContain('留空');
    setLocale('en');
    expect(t('mApiKeyPlaceholderFirstRun').toLowerCase()).not.toContain('keep');
  });

  it('models/test 与 models/fetch 载荷（E-host 契约：ModelsTestReq / ModelsFetchReq）', () => {
    const form = emptyModelsForm();
    form.providerId = 'deepseek';
    form.baseUrl = ' https://api.deepseek.com/v1 ';
    form.modelId = ' deepseek-chat ';
    expect(buildModelsTestReq(form)).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-chat',
      provider: 'deepseek'
    });
    expect(buildModelsFetchReq(form)).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      provider: 'deepseek'
    });
  });

  it('normalizeFetchedModels：接受 {models:[…]} 与字符串/对象混合，去重去空白', () => {
    expect(
      normalizeFetchedModels({ ok: true, models: [' qwen3-max ', 'qwen3-max', { id: 'qwen-plus' }, {}] })
    ).toEqual(['qwen3-max', 'qwen-plus']);
    expect(normalizeFetchedModels(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeFetchedModels({})).toEqual([]);
  });
});

describe('host saveModelsForm / secrets（P1-1 多 provider；reasoning；per-provider 键）', () => {
  it('saveModelsForm：写 reasoning 字段（读旧 thinking 归一），apiKey 永远是 per-provider 占位符', async () => {
    const dir = makeTempDir();
    const modelsPath = join(dir, 'models.json');
    const { secrets, map } = makeSecrets();

    const outcome = await saveModelsForm(
      { modelsPath, agentDir: dir, secrets },
      {
        providerId: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        api: 'openai-completions',
        modelId: 'qwen3-max',
        reasoning: true,
        apiKey: 'sk-qwen-secret',
        thinkingLevel: 'high'
      }
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.warning).toBeUndefined();
    expect(outcome.applied).toEqual({ provider: 'qwen', model: 'qwen3-max', thinkingLevel: 'high' });

    const raw = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { apiKey: string; models: Array<Record<string, unknown>> }>;
    };
    expect(raw.providers.qwen.apiKey).toBe('${secret:atOpsAgent.apiKey.qwen}');
    expect(raw.providers.qwen.models[0]).toEqual({ id: 'qwen3-max', reasoning: true });
    expect('thinking' in raw.providers.qwen.models[0]).toBe(false);
    // key 进 SecretStorage per-provider 键，文件里绝无明文
    expect(map.get('atOpsAgent.apiKey.qwen')).toBe('sk-qwen-secret');
    expect(await readFile(modelsPath, 'utf8')).not.toContain('sk-qwen-secret');
  });

  it('saveModelsForm：更新已有条目时删除旧 thinking 键；读端 readModelsFormState 兼容旧文件', async () => {
    const dir = makeTempDir();
    const modelsPath = join(dir, 'models.json');
    const { secrets } = makeSecrets();
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: 'https://old/v1',
            apiKey: '${secret:atOpsAgent.llmApiKey}',
            models: [{ id: 'm1', thinking: true }]
          }
        }
      }),
      'utf8'
    );
    // 读端：旧 thinking 归一到 reasoning
    const before = await readModelsFormState({ modelsPath, agentDir: dir, secrets });
    expect(before.reasoning).toBe(true);

    await saveModelsForm(
      { modelsPath, agentDir: dir, secrets },
      { providerId: 'gw', baseUrl: 'https://old/v1', modelId: 'm1', reasoning: true, apiKey: 'k' }
    );
    const raw = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(raw.providers.gw.models[0].reasoning).toBe(true);
    expect('thinking' in raw.providers.gw.models[0]).toBe(false);
  });

  it('saveModelsForm：providerId 指定的 provider 被 upsert，不再恒取第一个', async () => {
    const dir = makeTempDir();
    const modelsPath = join(dir, 'models.json');
    const { secrets } = makeSecrets();
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: { first: { baseUrl: 'https://first/v1', models: [{ id: 'f1' }] } }
      }),
      'utf8'
    );
    const outcome = await saveModelsForm(
      { modelsPath, agentDir: dir, secrets },
      { providerId: 'second', baseUrl: 'https://second/v1', modelId: 's1', apiKey: 'k2' }
    );
    expect(outcome.applied?.provider).toBe('second');
    const raw = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { baseUrl: string }>;
    };
    // 第一个 provider 原样保留，第二个新增
    expect(raw.providers.first.baseUrl).toBe('https://first/v1');
    expect(raw.providers.second.baseUrl).toBe('https://second/v1');
  });

  it('P0-B keyMissingWarning：无已存 key 且没填 → 警告；saveModelsForm 带出 warning', async () => {
    expect(keyMissingWarning(false, '')).toBeTruthy();
    expect(keyMissingWarning(false, 'sk-x')).toBeUndefined();
    expect(keyMissingWarning(true, '')).toBeUndefined();

    const dir = makeTempDir();
    const { secrets } = makeSecrets();
    const outcome = await saveModelsForm(
      { modelsPath: join(dir, 'models.json'), agentDir: dir, secrets },
      { providerId: 'gw', baseUrl: 'https://gw/v1', modelId: 'm1' }
    );
    expect(outcome.applied).toBeTruthy();
    expect(outcome.warning).toBeTruthy();
  });

  it('roleModels 合并写 agentDir/settings.json（只收合法角色与完整条目）', async () => {
    const dir = makeTempDir();
    const { secrets } = makeSecrets();
    await saveModelsForm(
      { modelsPath: join(dir, 'models.json'), agentDir: dir, secrets },
      {
        providerId: 'gw',
        baseUrl: 'https://gw/v1',
        modelId: 'm1',
        apiKey: 'k',
        roleModels: {
          investigator: { provider: 'gw', model: 'cheap-model' },
          writer: { provider: '', model: 'ignored-no-provider' },
          bogusRole: { provider: 'gw', model: 'x' }
        }
      }
    );
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      roleModels: Record<string, unknown>;
      thinkingLevel: string;
    };
    expect(settings.roleModels).toEqual({
      investigator: { provider: 'gw', model: 'cheap-model' }
    });
    expect(settings.thinkingLevel).toBe('medium');
  });

  it('secrets：getLlmApiKey(providerId) 旧键回退并一次性迁移；占位符 helper 形状正确', async () => {
    const { secrets, map } = makeSecrets();
    map.set(LLM_API_KEY_SECRET, 'legacy-key');
    // 新键为空 → 回退旧键并迁移
    expect(await secrets.getLlmApiKey('gw')).toBe('legacy-key');
    expect(map.get(providerApiKeySecret('gw'))).toBe('legacy-key');
    // per-provider 键优先于旧键
    map.set(providerApiKeySecret('gw'), 'scoped-key');
    expect(await secrets.getLlmApiKey('gw')).toBe('scoped-key');
    // 无参：旧行为（读旧键）
    expect(await secrets.getLlmApiKey()).toBe('legacy-key');
    // 占位符
    expect(apiKeyPlaceholder('gw')).toBe('${secret:atOpsAgent.apiKey.gw}');
    expect(apiKeyPlaceholder()).toBe(`\${secret:${LLM_API_KEY_SECRET}}`);
    // resolvePlaceholder 对 per-provider 占位符走同一回退
    expect(await secrets.resolvePlaceholder('${secret:atOpsAgent.apiKey.other}')).toBe(
      'legacy-key'
    );
  });

  it('MODELS_TEMPLATE：使用 reasoning 字段与 per-provider 占位符（不再是 thinking / 旧键）', () => {
    expect(MODELS_TEMPLATE).toContain('"reasoning": true');
    expect(MODELS_TEMPLATE).not.toContain('"thinking"');
    expect(MODELS_TEMPLATE).toContain('${secret:atOpsAgent.apiKey.internal-gateway}');
  });

  it('readModelsFormState：per-provider hasKey（旧键迁移后也为 true）；roleModels 回读', async () => {
    const dir = makeTempDir();
    const modelsPath = join(dir, 'models.json');
    const { secrets, map } = makeSecrets();
    map.set(LLM_API_KEY_SECRET, 'legacy-key');
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: { gw: { baseUrl: 'https://gw/v1', models: [{ id: 'm1', reasoning: true }] } }
      }),
      'utf8'
    );
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ roleModels: { verifier: { provider: 'gw', model: 'strong' } } }),
      'utf8'
    );
    const state = await readModelsFormState({ modelsPath, agentDir: dir, secrets });
    expect(state.providerId).toBe('gw');
    expect(state.reasoning).toBe(true);
    expect(state.hasKey).toBe(true);
    expect(state.roleModels.verifier).toEqual({ provider: 'gw', model: 'strong' });
  });
});

describe('settings/hydrate 快照归一（host settingsSnapshot 真实形状）', () => {
  it('config + capabilities.providers(toolNames) + skills(label/skillFile) + sessions(createdAt)', () => {
    const snapshot = normalizeSettingsSnapshot({
      config: { 'discovery.mode': 'always', 'subagent.maxParallel': 2 },
      modelsPath: '/home/dev/.at-series/agent/models.json',
      agentDir: '/home/dev/.at-series/agent',
      capabilities: {
        providers: [
          {
            pluginId: 'at.grafana',
            displayName: 'AT Grafana',
            healthy: true,
            toolNames: ['q1', 'q2', 'q3'],
            bridgeCount: 1
          },
          { pluginId: 'at.jenkins', healthy: false, toolCount: 5, bridgeCount: 2 }
        ]
      },
      skills: [{ label: 'ops-agent-core', description: '核心', skillFile: '/ext/skills/SKILL.md' }],
      sessions: [{ id: 's1', title: '会话 1', createdAt: 1700000000000 }],
      mcp: { path: '/home/dev/.at-series/agent/mcp.json', exists: true, text: '{\n  "servers": {}\n}\n' },
      pendingApprovals: 0
    });
    expect(snapshot.config['discovery.mode']).toBe('always');
    expect(snapshot.config['subagent.maxParallel']).toBe(2);
    expect(snapshot.modelsPath).toContain('models.json');
    expect(snapshot.providers).toEqual([
      { pluginId: 'at.grafana', displayName: 'AT Grafana', healthy: true, toolCount: 3, bridgeCount: 1 },
      { pluginId: 'at.jenkins', displayName: 'at.jenkins', healthy: false, toolCount: 5, bridgeCount: 2 }
    ]);
    expect(snapshot.skills).toEqual([
      { name: 'ops-agent-core', description: '核心', path: '/ext/skills/SKILL.md' }
    ]);
    expect(snapshot.sessions).toEqual([
      { id: 's1', title: '会话 1', updatedAt: 1700000000000, active: false }
    ]);
    expect(snapshot.models).toBeNull();
  });

  it('chat hydrate 兜底：sessionId 标记当前会话', () => {
    const snapshot = normalizeSettingsSnapshot({
      sessionId: 's2',
      sessions: [
        { id: 's1', title: 'A', createdAt: 1 },
        { id: 's2', title: 'B', createdAt: 2 }
      ]
    });
    expect(snapshot.sessions.find((s) => s.id === 's2')?.active).toBe(true);
    expect(snapshot.sessions.find((s) => s.id === 's1')?.active).toBe(false);
  });

  it('mcp 文本防御性再打码：host 忘了脱敏也不会把明文渲染进 textarea', () => {
    const snapshot = normalizeSettingsSnapshot({
      config: {},
      mcp: {
        path: '/x/mcp.json',
        exists: true,
        text: JSON.stringify({ servers: { s: { env: { API_TOKEN: 'leaked' } } } })
      }
    });
    expect(snapshot.mcp.text).toContain(REDACTED);
    expect(snapshot.mcp.text).not.toContain('leaked');
  });

  it('normalizeSessions 直接调用：active 显式标记优先', () => {
    const rows = normalizeSessions(
      [{ id: 's1', title: 'A', active: true }, { id: 's2', title: 'B' }],
      's2'
    );
    expect(rows[0]?.active).toBe(true);
    expect(rows[1]?.active).toBe(true);
  });
});

describe('打开文件路由：models/* 家族探测（避免双开）', () => {
  it('host 支持 models/*：走 models/openFile / models/openAuth', () => {
    expect(openModelsFileReq(true)).toEqual({ type: 'models/openFile', payload: {} });
    expect(openAuthFileReq(true)).toEqual({ type: 'models/openAuth', payload: {} });
  });

  it('host 未实现：退回 settings/openJson kind models|auth', () => {
    expect(openModelsFileReq(false)).toEqual({
      type: 'settings/openJson',
      payload: { kind: 'models' }
    });
    expect(openAuthFileReq(false)).toEqual({
      type: 'settings/openJson',
      payload: { kind: 'auth' }
    });
  });
});

describe('settings i18n（本地包，独立于 chat i18n）', () => {
  it('normalizeLocale：zh*/en* 归一，其它 null', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr')).toBeNull();
  });

  it('setLocale 切换取词；OAuth 红线文案两种语言都提到 auth.json 与 0600', () => {
    expect(t('save')).toBe('保存');
    expect(t('mOauthNote')).toContain('auth.json');
    expect(t('mOauthNote')).toContain('0600');
    expect(t('mOauthNote')).toContain('models.json');
    setLocale('en');
    expect(t('save')).toBe('Save');
    expect(t('mOauthNote')).toContain('auth.json');
    expect(t('mOauthNote')).toContain('0600');
    setLocale('klingon');
    expect(t('save')).toBe('Save');
  });

  it('首跑提示 / 保存并测试 / 高级折叠 / 角色映射的键 zh+en 双语齐全', () => {
    const keys = [
      'mFirstRunHint',
      'modelsSectionConnect',
      'modelsSectionReasoning',
      'mAdvanced',
      'mAdvancedHint',
      'mSaveTest',
      'mFetchModels',
      'mTesting',
      'mTestOk',
      'mTest401',
      'mKeyMissingWarn',
      'mKeySecretNote',
      'mRolesTitle',
      'roleInvestigator',
      'roleExecutor',
      'roleWriter',
      'roleVerifier',
      'mcpServers',
      'mcpEmpty',
      'mcpAdvanced',
      'cfgSessionReadAllowlist',
      'cfgSessionReadAllowlistDesc'
    ] as const;
    for (const key of keys) {
      setLocale('zh-CN');
      const zh = t(key);
      setLocale('en');
      const en = t(key);
      expect(zh.length, key).toBeGreaterThan(0);
      expect(en.length, key).toBeGreaterThan(0);
      expect(zh, key).not.toBe(en);
    }
  });
});
