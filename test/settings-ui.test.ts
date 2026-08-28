/**
 * settings webview 单测（docs/09 §8 组件测降级路径）。
 *
 * vitest 没有 vue SFC 编译插件（不改 package.json），所以不 mount .vue 组件；
 * 测组件抽出的纯 TS helper（src/webview-settings/helpers.ts + i18n.ts）：
 * - 页签清单（Roo 式竖排导航的数据源）与 tab 归一
 * - 配置绑定（atOpsAgent.* 十键全覆盖）、diff 与 settings/patchConfig 单键载荷
 * - 密钥打码 / ***还原（mcp.json 往返红线：明文凭证绝不经过 webview）
 * - mcp.json 解析（servers / mcpServers；AT Series hub.js 跳过提示）
 * - models/save 载荷（apiKey 留空 = 保持现有 key，绝不回显）
 * - settings/hydrate 快照归一（host settingsSnapshot 真实形状）
 * - models/* 家族探测后的打开文件路由（避免双开）
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_DEFAULTS,
  CONFIG_FIELDS,
  REDACTED,
  SETTINGS_TABS,
  buildConfigPatch,
  buildConfigPatchRequests,
  buildModelsSavePayload,
  emptyModelsForm,
  normalizeConfig,
  normalizeModelsState,
  normalizeSettingsSnapshot,
  normalizeSessions,
  normalizeTabId,
  openAuthFileReq,
  openModelsFileReq,
  parseMcpConfig,
  redactMcpText,
  redactSecretsDeep,
  restoreRedactedSecrets
} from '../src/webview-settings/helpers';
import { normalizeLocale, setLocale, t } from '../src/webview-settings/i18n';

beforeEach(() => {
  setLocale('zh-CN');
});

describe('页签清单（SettingsApp 左侧竖排导航数据源）', () => {
  it('六个页签，顺序 = 常规/模型/能力插件/MCP/技能/会话', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      'general',
      'models',
      'capabilities',
      'mcp',
      'skills',
      'sessions'
    ]);
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

  it('normalizeTabId：未知 / 缺失一律归 general', () => {
    expect(normalizeTabId('mcp')).toBe('mcp');
    expect(normalizeTabId('models')).toBe('models');
    expect(normalizeTabId('garbage')).toBe('general');
    expect(normalizeTabId(undefined)).toBe('general');
  });
});

describe('常规配置：绑定键覆盖、归一化与 patch 载荷', () => {
  it('CONFIG_FIELDS 覆盖需求列出的全部 10 个 atOpsAgent.* 键', () => {
    expect(CONFIG_FIELDS.map((field) => field.key).sort()).toEqual(
      [
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
      ].sort()
    );
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
      approval: { sessionRequiredFor: 'never' }
    });
    expect(nested['discovery.mode']).toBe('off');
    expect(nested['discovery.threshold']).toBe(30);
    expect(nested['approval.sessionRequiredFor']).toBe('never');
  });

  it('buildConfigPatch：无改动 → null；只含改动键', () => {
    const saved = { ...CONFIG_DEFAULTS };
    expect(buildConfigPatch(saved, { ...saved })).toBeNull();
    const edited = { ...saved, 'discovery.mode': 'always' as const, 'streaming.batchMs': 100 };
    expect(buildConfigPatch(saved, edited)).toEqual({
      'discovery.mode': 'always',
      'streaming.batchMs': 100
    });
  });

  it('buildConfigPatchRequests：host 契约单键 {key,value}，改几键发几条', () => {
    const saved = { ...CONFIG_DEFAULTS };
    expect(buildConfigPatchRequests(saved, { ...saved })).toEqual([]);
    const edited = {
      ...saved,
      'workspaceShell.enabled': true,
      'models.defaultThinkingLevel': 'high' as const
    };
    const requests = buildConfigPatchRequests(saved, edited);
    expect(requests).toHaveLength(2);
    expect(requests).toContainEqual({ key: 'workspaceShell.enabled', value: true });
    expect(requests).toContainEqual({ key: 'models.defaultThinkingLevel', value: 'high' });
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

describe('mcp.json 解析（servers / mcpServers；AT Series hub 跳过）', () => {
  it('mcpServers map 形状：列出 server 名', () => {
    const result = parseMcpConfig(
      JSON.stringify({ mcpServers: { filesystem: { command: 'npx' }, jira: { url: 'https://x' } } })
    );
    expect(result.ok).toBe(true);
    expect(result.serverNames.sort()).toEqual(['filesystem', 'jira']);
    expect(result.skippedAtSeries).toEqual([]);
  });

  it('servers 数组形状：按 name 字段列出', () => {
    const result = parseMcpConfig(
      JSON.stringify({ servers: [{ name: 'filesystem', command: 'npx' }] })
    );
    expect(result.ok).toBe(true);
    expect(result.serverNames).toEqual(['filesystem']);
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
  });

  it('空文本合法（0 server）；坏 JSON 报错误', () => {
    expect(parseMcpConfig('  ').ok).toBe(true);
    expect(parseMcpConfig('  ').serverNames).toEqual([]);
    const bad = parseMcpConfig('{ oops');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});

describe('models 表单：保存载荷与状态归一（key 永不回显）', () => {
  it('baseUrl / modelId 必填', () => {
    const form = emptyModelsForm();
    expect(buildModelsSavePayload(form)).toEqual({ ok: false, error: 'required' });
    form.baseUrl = 'https://llm.example/v1';
    expect(buildModelsSavePayload(form).ok).toBe(false);
  });

  it('apiKey 留空 = 整键省略（保持现有 key）；填了才上行；不泄漏 hasKey/路径', () => {
    const form = emptyModelsForm();
    form.baseUrl = ' https://llm.example/v1 ';
    form.modelId = ' qwen3-max ';
    form.modelName = 'Qwen3 Max';
    form.thinking = true;
    form.thinkingLevel = 'high';
    form.thinkingFormat = 'qwen';
    form.supportsDeveloperRole = false;
    form.hasKey = true;
    form.modelsPath = '/secret/models.json';

    const kept = buildModelsSavePayload(form);
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.payload).toEqual({
        baseUrl: 'https://llm.example/v1',
        modelId: 'qwen3-max',
        modelName: 'Qwen3 Max',
        thinking: true,
        thinkingLevel: 'high',
        thinkingFormat: 'qwen',
        supportsDeveloperRole: false
      });
      expect('apiKey' in kept.payload).toBe(false);
      expect('hasKey' in kept.payload).toBe(false);
      expect('modelsPath' in kept.payload).toBe(false);
    }

    form.apiKey = '  sk-new-key  ';
    const withKey = buildModelsSavePayload(form);
    expect(withKey.ok && withKey.payload.apiKey).toBe('sk-new-key');
  });

  it('normalizeModelsState：即使 host 误发 apiKey 也强制置空；默认值与枚举回退', () => {
    const state = normalizeModelsState({
      providerId: 'internal-gateway',
      baseUrl: 'https://llm/v1',
      modelId: 'qwen3-max',
      hasKey: true,
      apiKey: 'should-never-appear',
      thinkingFormat: 'nonsense',
      thinkingLevel: 'max'
    });
    expect(state.apiKey).toBe('');
    expect(state.hasKey).toBe(true);
    expect(state.thinkingFormat).toBe('default');
    expect(state.thinkingLevel).toBe('max');
    expect(state.oauthProvider).toBe('internal-gateway');
  });

  it('normalizeModelsState：previous 里用户已输入的 oauthProvider 不被覆盖', () => {
    const previous = emptyModelsForm();
    previous.oauthProvider = 'anthropic';
    const state = normalizeModelsState({ providerId: 'internal-gateway' }, previous);
    expect(state.oauthProvider).toBe('anthropic');
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
});
