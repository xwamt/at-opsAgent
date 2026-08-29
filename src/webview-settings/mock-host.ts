/**
 * 本地直接打开 html 调试用 mock host（没有 acquireVsCodeApi 时启用）。
 * 回放 settings/hydrate 快照与各类保存回执；与真实 host 相同走 evt + res 信封。
 */
import type { Envelope } from '../protocol/host-protocol';
import { REDACTED, redactMcpText } from './helpers';

function emit(dir: 'evt' | 'res', type: string, payload: unknown, id = ''): void {
  const envelope: Envelope = { v: 1, id, dir, type, payload, ts: Date.now() };
  window.dispatchEvent(new MessageEvent('message', { data: envelope }));
}

const MOCK_MODELS_STATE = {
  providerId: 'internal-gateway',
  baseUrl: 'https://llm.example.internal/v1',
  api: 'openai-completions',
  modelId: 'qwen3-max',
  modelName: 'Qwen3 Max',
  reasoning: true,
  hasKey: true,
  modelsPath: '~/.at-series/agent/models.json',
  authPath: '~/.at-series/agent/auth.json',
  oauthNote:
    'OAuth 由 pi ModelRuntime.login 驱动，凭证写入 ~/.at-series/agent/auth.json (0600)，不进 models.json',
  thinkingFormat: 'qwen',
  supportsDeveloperRole: true,
  thinkingLevel: 'medium',
  roleModels: {
    investigator: { provider: 'internal-gateway', model: 'qwen-turbo' }
  }
};

/** models/fetch 模拟目录（真实 host 走 GET {baseUrl}/models）。 */
const MOCK_MODEL_CATALOG = ['qwen3-max', 'qwen3-coder', 'qwen-plus', 'qwen-turbo', 'deepseek-v3'];

const MOCK_MCP_TEXT = `${JSON.stringify(
  {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
        env: { API_TOKEN: REDACTED }
      },
      'AT Series': {
        command: 'node',
        args: ['/home/dev/.at-series/mcp/hub.js']
      }
    }
  },
  null,
  2
)}\n`;

let mockSessions = [
  { id: 'sess-demo-current', title: '网关 5xx 突增', updatedAt: Date.now() - 60_000, active: true },
  { id: 'sess-old-1', title: '磁盘告警巡检', updatedAt: Date.now() - 3_600_000, active: false }
];

function snapshot(): Record<string, unknown> {
  return {
    locale: 'zh-CN',
    config: {
      'discovery.mode': 'auto',
      'discovery.threshold': 20,
      'plugins.autoEnableNew': true,
      'policy.floor': 'write-exec',
      'approval.sessionRequiredFor': 'write-exec',
      'approval.dedupePluginModal': false,
      'approval.timeoutMs': 900000,
      'models.defaultThinkingLevel': 'medium',
      'models.toolCallPromptFallback': true,
      'workspaceShell.enabled': false,
      'subagent.maxParallel': 3,
      'streaming.batchMs': 40,
      'ui.showThinking': true
    },
    models: MOCK_MODELS_STATE,
    providers: [
      { pluginId: 'at.grafana', displayName: 'AT Grafana', healthy: true, toolCount: 9, bridgeCount: 1 },
      { pluginId: 'at.terminal', displayName: 'AT Terminal', healthy: true, toolCount: 6, bridgeCount: 2 },
      { pluginId: 'at.jenkins', displayName: 'AT Jenkins', healthy: false, toolCount: 5, bridgeCount: 1 }
    ],
    mcp: { path: '~/.cursor/mcp.json', text: MOCK_MCP_TEXT },
    // 内置技能不下发 UI（与真实 host settingsSnapshot 一致：skills 恒为空）。
    skills: [],
    sessions: mockSessions
  };
}

export function installSettingsMockHost(): void {
  (window as unknown as Record<string, unknown>).__opsMockPostMessage = (raw: unknown) => {
    const msg = raw as Partial<Envelope>;
    const id = typeof msg.id === 'string' ? msg.id : '';
    console.info('[ops-settings-mock] req', msg.type, msg.payload);
    switch (msg.type) {
      case 'settings/hydrate':
        emit('res', 'settings/hydrate', snapshot(), id);
        break;
      case 'models/state':
        emit('res', 'models/state', MOCK_MODELS_STATE, id);
        break;
      case 'settings/patchConfig':
        window.setTimeout(() => emit('res', 'settings/patchConfig', { ok: true }, id), 200);
        break;
      case 'models/save':
        window.setTimeout(
          () => emit('res', 'models/save', { ok: true, state: MOCK_MODELS_STATE }, id),
          200
        );
        break;
      case 'models/test':
        // 「保存并测试」链路：模拟 1-token 探测成功（E-host 路由到 probeModel）。
        window.setTimeout(
          () => emit('res', 'models/test', { ok: true, latencyMs: 842 }, id),
          400
        );
        break;
      case 'models/fetch':
        // 「拉取模型列表」：模拟 GET {baseUrl}/models 成功。
        window.setTimeout(
          () => emit('res', 'models/fetch', { ok: true, models: MOCK_MODEL_CATALOG }, id),
          400
        );
        break;
      case 'models/oauth':
        window.setTimeout(
          () =>
            emit(
              'res',
              'models/oauth',
              { ok: false, message: 'mock host：OAuth 需要真实 VS Code 环境' },
              id
            ),
          400
        );
        break;
      case 'capabilities/refresh':
        emit('res', 'capabilities/refresh', { providers: (snapshot().providers as unknown[]) }, id);
        break;
      case 'mcp/get':
        emit('res', 'mcp/get', { path: '~/.at-series/agent/mcp.json', exists: true, text: MOCK_MCP_TEXT }, id);
        break;
      case 'mcp/save': {
        const text = String((msg.payload as { text?: string } | undefined)?.text ?? '');
        emit('res', 'mcp/save', { ok: true, text: redactMcpText(text) ?? text }, id);
        break;
      }
      case 'session/list':
        emit('res', 'session/list', { sessions: mockSessions }, id);
        break;
      case 'session/new': {
        const sessionId = `sess-${Date.now().toString(36)}`;
        mockSessions = [
          { id: sessionId, title: '新会话', updatedAt: Date.now(), active: true },
          ...mockSessions.map((s) => ({ ...s, active: false }))
        ];
        emit('res', 'session/new', { ok: true, sessionId }, id);
        break;
      }
      case 'session/switch': {
        const target = (msg.payload as { id?: string } | undefined)?.id;
        mockSessions = mockSessions.map((s) => ({ ...s, active: s.id === target }));
        emit('res', 'session/switch', { ok: true }, id);
        break;
      }
      default:
        break;
    }
  };
}
