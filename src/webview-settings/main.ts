/**
 * settings webview 入口（esbuild → dist/webview/settings.js）。
 * 启动模式与 src/webview-chat/main.ts 一致：ensure-css → pinia → attach → mount。
 *
 * ── host 接线契约（src/host/settingsView.ts + HostController.handleRequest；
 *    envelope 均为 v:1；req 由 host 以同 type 的 res 回执） ──
 *
 * webview → host（dir:'req'）——host 已实现：
 * - settings/hydrate     {}                    → res = settingsSnapshot()：
 *     { config: Record<atOpsAgent 键, 值>, modelsPath, agentDir,
 *       capabilities: { providers: [{ pluginId, displayName, healthy,
 *                                     toolNames|toolCount, bridgeCount }] },
 *       skills: []（内置技能是 Agent 内部资源，恒为空、不进 UI）,
 *       sessions: [{ id, title, createdAt }],
 *       mcp: { path, exists, text（已脱敏 ***）, error? }, pendingApprovals }
 * - hydrate              {}                    chat 快照兜底（吸收 sessions/providers/locale）
 * - settings/patchConfig { key, value }        单键写 atOpsAgent.* 用户级配置（白名单校验）；
 *                                              改 N 个键发 N 个 req
 * - settings/openJson    { kind: 'vscode'|'models'|'auth'|'mcp' }
 * - mcp/get              {}                    → res { path, exists, text, error? }
 * - mcp/save             { text }              打码稿全文；*** 占位由 host 从现有文件回填
 *                                              （可复用本目录 helpers.restoreRedactedSecrets），
 *                                              AT Series hub.js 条目由 filterMcpServers 跳过
 * - session/list {} / session/new {} / session/switch { id }
 *
 * webview → host——预留（host 未实现时回 {ok:false,error}，本侧降级处理）：
 * - models/state {} / models/save {...} / models/oauth { providerId } /
 *   models/openFile {} / models/openAuth {}    modelsView.ts 三页签的 UX 同款；
 *                                              收到过合法 models/state 才启用该家族，
 *                                              否则打开文件走 settings/openJson 兜底。
 *                                              models/save 载荷 = { baseUrl, modelId,
 *                                              modelName, thinking, thinkingLevel,
 *                                              thinkingFormat, supportsDeveloperRole,
 *                                              apiKey?（缺省=保持现有 key，绝不回显）}
 * - capabilities/refresh {}                    重扫能力插件（本侧同时重发 settings/hydrate）
 * - diagnose             {}                    hub 诊断（同 atOpsAgent.diagnoseHub）
 *
 * host → webview（dir:'evt'）：
 * - settings/hydrate                           打开面板时的全量快照（同 res 载荷）
 * - settings/tab { tab }                       聚焦指定页签（openModels → 'models'）
 * - 兼容扩展：settings/config { config } / models/state | models/saved |
 *   models/error | models/oauthStatus / capabilities/snapshot { providers } /
 *   mcp/state { path, text } / sessions/state { sessions }
 *
 * 红线：API key / OAuth token 绝不下行、绝不回显、绝不写日志；
 * mcp.json 凭证经 webview 往返时永远是 *** 占位。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '../webview-chat/ops-tokens.css';
import { ensureStylesheet } from '../webview-chat/ensure-css';
import { isMockHost } from '../webview-chat/vscode-api';
import SettingsApp from './components/SettingsApp.vue';
import { installSettingsMockHost } from './mock-host';
import { useSettingsStore } from './store';

function boot(): void {
  ensureStylesheet();
  let el = document.getElementById('app');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
  }
  const pinia = createPinia();
  const app = createApp(SettingsApp);
  app.use(pinia);
  const store = useSettingsStore(pinia);
  if (isMockHost()) {
    installSettingsMockHost();
  }
  store.attach();
  app.mount(el);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
