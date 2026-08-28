/**
 * Models 配置页（atOpsAgent.openModels 打开的 WebviewPanel）。
 *
 * 三个页签（简单 HTML，无 Vue）：
 * - API Key：OpenAI 兼容 provider（baseUrl / 模型 id / thinking 开关）+
 *   thinkingLevel 下拉。API key 只进 VS Code SecretStorage
 *   （atOpsAgent.llmApiKey）——models.json 永远保留 ${secret:…} 占位符，
 *   不落明文、不回显、不进日志。thinkingLevel 持久化到 agentDir/settings.json，
 *   保存时经 controller.setModel（协议已含 thinkingLevel）同步会话。
 * - Compat：thinkingFormat（default/deepseek/qwen/zai）与 supportsDeveloperRole，
 *   写入 models.json providers[id].compat（默认值不落字段，未知 compat 字段保留）。
 * - OAuth：provider id + 「开始登录」。优先 runtime.loginOAuth，缺席时 host
 *   直驱 pi ModelRuntime.login（src/host/oauthLogin.ts）；凭证只进
 *   ~/.at-series/agent/auth.json（0600），绝不进 models.json、绝不写日志。
 *
 * 高级编辑走「打开 models.json」次级动作。
 * CSP 与 nonce 模式对齐 src/host/webviewHtml.ts；脚本内联（无 dist 依赖）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeThinkingLevel, patchAgentSettings, readAgentSettings } from './agentSettings';
import type { ThinkingLevel } from './hostTypes';
import { OAUTH_NOTE, openAuthJson } from './oauthLogin';
import { LLM_API_KEY_SECRET, type OpsSecrets } from './secrets';
import { getNonce } from './webviewHtml';

export interface ModelsPanelDeps {
  modelsPath: string;
  /** ~/.at-series/agent（settings.json / auth.json 落点）。 */
  agentDir: string;
  secrets: OpsSecrets;
  output: vscode.OutputChannel;
  /** 保存成功后刷新 Models 树等。 */
  refreshTrees: () => void;
  /** OAuth 登录（HostController.loginOAuth）；返回消息绝不含 token。 */
  loginOAuth: (providerId: string) => Promise<{ ok: boolean; message: string }>;
  /** 保存后同步会话模型（controller.setModel，含 thinkingLevel）。 */
  applyModelSelection: (req: {
    provider: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
  }) => Promise<unknown>;
}

const DEFAULT_PROVIDER_ID = 'internal-gateway';
const DEFAULT_API = 'openai-completions';
const SECRET_PLACEHOLDER = `\${secret:${LLM_API_KEY_SECRET}}`;

const THINKING_FORMATS = ['deepseek', 'qwen', 'zai'] as const;
type ThinkingFormat = (typeof THINKING_FORMATS)[number];

/** models.json 缺失时「打开 models.json」写入的模板（apiKey 只有占位符）。 */
const MODELS_TEMPLATE = `{
  "providers": {
    "${DEFAULT_PROVIDER_ID}": {
      "baseUrl": "https://llm.example.internal/v1",
      "api": "${DEFAULT_API}",
      "apiKey": "${SECRET_PLACEHOLDER}",
      "headers": {},
      "models": [
        { "id": "qwen3-max", "name": "Qwen3 Max", "thinking": true }
      ]
    }
  }
}
`;

interface ModelsFormState {
  providerId: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
  thinking: boolean;
  /** 只暴露「是否已存 key」，绝不回传 key 本体。 */
  hasKey: boolean;
  modelsPath: string;
  /** compat.thinkingFormat；'default' = 不写该字段。 */
  thinkingFormat: 'default' | ThinkingFormat;
  /** compat.supportsDeveloperRole；默认 true（不写该字段）。 */
  supportsDeveloperRole: boolean;
  /** agentDir/settings.json 的 thinkingLevel。 */
  thinkingLevel: ThinkingLevel;
  authPath: string;
  oauthNote: string;
}

interface SavePayload {
  baseUrl?: unknown;
  modelId?: unknown;
  modelName?: unknown;
  thinking?: unknown;
  apiKey?: unknown;
  thinkingFormat?: unknown;
  supportsDeveloperRole?: unknown;
  thinkingLevel?: unknown;
}

interface SaveOutcome {
  error?: string;
  applied?: { provider: string; model: string; thinkingLevel: ThinkingLevel };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeThinkingFormat(value: unknown): 'default' | ThinkingFormat {
  return typeof value === 'string' && (THINKING_FORMATS as readonly string[]).includes(value)
    ? (value as ThinkingFormat)
    : 'default';
}

let currentPanel: vscode.WebviewPanel | undefined;

/** 打开（或聚焦）Models 配置页；单例。 */
export function showModelsPanel(deps: ModelsPanelDeps): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'atOpsAgent.modelsPanel',
    'Models',
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] }
  );
  currentPanel = panel;
  panel.webview.html = buildModelsHtml();

  const messageSub = panel.webview.onDidReceiveMessage((message: unknown) => {
    void handleMessage(panel, deps, message).catch((err) => {
      deps.output.appendLine(
        `[models] 面板消息处理失败: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  });
  panel.onDidDispose(() => {
    messageSub.dispose();
    currentPanel = undefined;
  });
}

async function handleMessage(
  panel: vscode.WebviewPanel,
  deps: ModelsPanelDeps,
  message: unknown
): Promise<void> {
  const type = isRecord(message) ? message.type : undefined;
  if (type === 'ready') {
    await postState(panel, deps, 'init');
    return;
  }
  if (type === 'save') {
    const payload = isRecord(message) && isRecord(message.payload) ? message.payload : {};
    const outcome = await saveModels(deps, payload);
    if (outcome.error !== undefined) {
      void panel.webview.postMessage({ type: 'error', payload: outcome.error });
      return;
    }
    deps.refreshTrees();
    deps.output.appendLine(`[models] 已保存 ${deps.modelsPath}（apiKey 走 SecretStorage）`);
    if (outcome.applied) {
      // 同步会话模型 + thinkingLevel（runtime 下次 prompt 按新配置重建）。
      try {
        await deps.applyModelSelection(outcome.applied);
      } catch (err) {
        deps.output.appendLine(
          `[models] setModel 同步失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    await postState(panel, deps, 'saved');
    return;
  }
  if (type === 'openFile') {
    await openModelsJson(deps);
    return;
  }
  if (type === 'oauthLogin') {
    const providerId =
      isRecord(message) && typeof message.providerId === 'string' ? message.providerId : '';
    const result = await deps.loginOAuth(providerId);
    void panel.webview.postMessage({ type: 'oauthStatus', payload: result });
    return;
  }
  if (type === 'openAuthFile') {
    await openAuthJson(deps.agentDir);
  }
}

async function postState(
  panel: vscode.WebviewPanel,
  deps: ModelsPanelDeps,
  type: 'init' | 'saved'
): Promise<void> {
  void panel.webview.postMessage({ type, payload: await readFormState(deps) });
}

/** 读第一个 provider 的现值预填表单；文件缺失/坏 JSON → 空表单。 */
async function readFormState(deps: ModelsPanelDeps): Promise<ModelsFormState> {
  const state: ModelsFormState = {
    providerId: DEFAULT_PROVIDER_ID,
    baseUrl: '',
    modelId: '',
    modelName: '',
    thinking: false,
    hasKey: typeof (await deps.secrets.getLlmApiKey()) === 'string',
    modelsPath: deps.modelsPath,
    thinkingFormat: 'default',
    supportsDeveloperRole: true,
    thinkingLevel:
      normalizeThinkingLevel((await readAgentSettings(deps.agentDir)).thinkingLevel) ?? 'medium',
    authPath: path.join(deps.agentDir, 'auth.json'),
    oauthNote: OAUTH_NOTE
  };
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(deps.modelsPath, 'utf8'));
  } catch {
    return state;
  }
  const providers = isRecord(raw) && isRecord(raw.providers) ? raw.providers : undefined;
  if (!providers) return state;
  const providerId = Object.keys(providers)[0];
  const provider = providerId !== undefined ? providers[providerId] : undefined;
  if (providerId === undefined || !isRecord(provider)) return state;
  state.providerId = providerId;
  if (typeof provider.baseUrl === 'string') state.baseUrl = provider.baseUrl;
  const model = Array.isArray(provider.models) ? provider.models.find(isRecord) : undefined;
  if (model) {
    if (typeof model.id === 'string') state.modelId = model.id;
    if (typeof model.name === 'string') state.modelName = model.name;
    state.thinking = model.thinking === true;
  }
  if (isRecord(provider.compat)) {
    state.thinkingFormat = normalizeThinkingFormat(provider.compat.thinkingFormat);
    state.supportsDeveloperRole = provider.compat.supportsDeveloperRole !== false;
  }
  return state;
}

/**
 * 保存：upsert 第一个 provider（其余 provider / 字段原样保留），
 * apiKey 字段永远写占位符；用户填了 key 才更新 SecretStorage。
 * compat 只管理 thinkingFormat / supportsDeveloperRole 两个键（默认值删除、
 * 未知键保留）；thinkingLevel 合并写 agentDir/settings.json。
 */
async function saveModels(deps: ModelsPanelDeps, payload: SavePayload): Promise<SaveOutcome> {
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
  const modelName = typeof payload.modelName === 'string' ? payload.modelName.trim() : '';
  const thinking = payload.thinking === true;
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const thinkingFormat = normalizeThinkingFormat(payload.thinkingFormat);
  const supportsDeveloperRole = payload.supportsDeveloperRole !== false;
  const thinkingLevel = normalizeThinkingLevel(payload.thinkingLevel) ?? 'medium';
  if (baseUrl.length === 0 || modelId.length === 0) {
    return { error: 'Base URL 与模型 ID 不能为空。' };
  }

  let root: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await fs.readFile(deps.modelsPath, 'utf8'));
    if (isRecord(raw)) root = raw;
  } catch {
    // 文件不存在或坏 JSON：从空配置开始（坏文件由「打开 models.json」人工处理）。
  }
  const providers = isRecord(root.providers) ? { ...root.providers } : {};
  const providerId = Object.keys(providers)[0] ?? DEFAULT_PROVIDER_ID;
  const existing = isRecord(providers[providerId]) ? (providers[providerId] as Record<string, unknown>) : {};

  const models = (Array.isArray(existing.models) ? existing.models : []).filter(isRecord);
  const entry: Record<string, unknown> = { id: modelId, thinking };
  if (modelName.length > 0) entry.name = modelName;
  const idx = models.findIndex((m) => m.id === modelId);
  if (idx >= 0) models[idx] = { ...models[idx], ...entry };
  else models.push(entry);

  const compat = isRecord(existing.compat) ? { ...existing.compat } : {};
  if (thinkingFormat === 'default') delete compat.thinkingFormat;
  else compat.thinkingFormat = thinkingFormat;
  if (supportsDeveloperRole) delete compat.supportsDeveloperRole;
  else compat.supportsDeveloperRole = false;

  const provider: Record<string, unknown> = {
    ...existing,
    baseUrl,
    api: typeof existing.api === 'string' ? existing.api : DEFAULT_API,
    apiKey: SECRET_PLACEHOLDER,
    models
  };
  if (Object.keys(compat).length > 0) provider.compat = compat;
  else delete provider.compat;

  try {
    await fs.mkdir(path.dirname(deps.modelsPath), { recursive: true });
    await fs.writeFile(
      deps.modelsPath,
      `${JSON.stringify({ ...root, providers: { ...providers, [providerId]: provider } }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await patchAgentSettings(deps.agentDir, { thinkingLevel });
    if (apiKey.length > 0) {
      await deps.secrets.setLlmApiKey(apiKey);
    }
  } catch (err) {
    return { error: `保存失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { applied: { provider: providerId, model: modelId, thinkingLevel } };
}

/** 次级动作：确保 models.json 存在（缺失写模板）并在编辑器打开。 */
export async function openModelsJson(deps: Pick<ModelsPanelDeps, 'modelsPath' | 'output'>): Promise<void> {
  const { modelsPath, output } = deps;
  try {
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    try {
      await fs.access(modelsPath);
    } catch {
      await fs.writeFile(modelsPath, MODELS_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
      output.appendLine(`[models] 已创建模板 ${modelsPath}（apiKey 使用 SecretStorage 占位符）`);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelsPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    void vscode.window.showErrorMessage(
      `打开 models.json 失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function buildModelsHtml(): string {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Models</title>
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      max-width: 560px;
      padding: 16px 24px;
    }
    h1 { font-size: 16px; margin: 0 0 4px; }
    .desc { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 12px; }
    .tabs { display: flex; gap: 2px; margin: 12px 0 16px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
    .tabs button {
      padding: 5px 14px;
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 0;
    }
    .tabs button.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    label { display: block; margin: 12px 0 4px; font-size: 12px; }
    input[type="text"], input[type="password"], select {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
    }
    select { color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); }
    input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .checkbox { display: flex; align-items: center; gap: 6px; margin: 14px 0; font-size: 12px; }
    .checkbox label { margin: 0; }
    .actions { display: flex; gap: 8px; margin-top: 18px; }
    button {
      padding: 5px 14px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button[disabled] { opacity: 0.6; cursor: default; }
    #keyState { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    #status { margin-top: 12px; font-size: 12px; min-height: 16px; }
    #status.ok { color: var(--vscode-testing-iconPassed, #73c991); }
    #status.err { color: var(--vscode-errorForeground); }
    .note {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background, transparent);
      border-left: 3px solid var(--vscode-focusBorder);
      padding: 8px 10px;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <h1>模型配置</h1>
  <p class="desc" id="pathHint">配置写入 ~/.at-series/agent/models.json；API key 只存 VS Code SecretStorage，文件中保留占位符。</p>

  <div class="tabs">
    <button type="button" class="active" data-tab="api">API Key</button>
    <button type="button" data-tab="compat">Compat</button>
    <button type="button" data-tab="oauth">OAuth</button>
  </div>

  <div class="tab-panel active" id="tab-api">
    <label for="baseUrl">Base URL</label>
    <input type="text" id="baseUrl" placeholder="https://llm.example.internal/v1" />
    <label for="modelId">模型 ID</label>
    <input type="text" id="modelId" placeholder="qwen3-max" />
    <label for="modelName">显示名（可选）</label>
    <input type="text" id="modelName" placeholder="Qwen3 Max" />
    <div class="checkbox">
      <input type="checkbox" id="thinking" />
      <label for="thinking">支持思考（thinking）</label>
    </div>
    <label for="thinkingLevel">思考等级（thinkingLevel，持久化到 settings.json）</label>
    <select id="thinkingLevel">
      <option value="off">off</option>
      <option value="minimal">minimal</option>
      <option value="low">low</option>
      <option value="medium">medium（默认）</option>
      <option value="high">high</option>
      <option value="xhigh">xhigh</option>
      <option value="max">max</option>
    </select>
    <label for="apiKey">API Key</label>
    <input type="password" id="apiKey" autocomplete="off" placeholder="留空 = 保持现有 key" />
    <div id="keyState"></div>
  </div>

  <div class="tab-panel" id="tab-compat">
    <label for="thinkingFormat">thinkingFormat（思考字段兼容格式）</label>
    <select id="thinkingFormat">
      <option value="default">default（不写入，走 pi-ai 默认）</option>
      <option value="deepseek">deepseek</option>
      <option value="qwen">qwen</option>
      <option value="zai">zai</option>
    </select>
    <div class="checkbox">
      <input type="checkbox" id="supportsDeveloperRole" />
      <label for="supportsDeveloperRole">支持 developer role 消息（取消勾选写 false）</label>
    </div>
    <p class="desc" id="compatHint">保存后写入 models.json providers[…].compat；默认值不落字段，已有的其他 compat 字段原样保留。</p>
  </div>

  <div class="tab-panel" id="tab-oauth">
    <label for="oauthProvider">Provider ID</label>
    <input type="text" id="oauthProvider" placeholder="anthropic" />
    <div class="actions">
      <button id="oauthLogin">开始登录</button>
      <button id="openAuthFile" class="secondary">打开 auth.json</button>
    </div>
    <p class="note" id="oauthNote"></p>
  </div>

  <div class="actions" id="saveActions">
    <button id="save">保存</button>
    <button id="openFile" class="secondary">打开 models.json</button>
  </div>
  <div id="status"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = (id) => document.getElementById(id);
    function setStatus(text, ok) {
      const status = el('status');
      status.textContent = text;
      status.className = ok ? 'ok' : 'err';
    }
    // 页签切换：OAuth 页隐藏「保存」（登录动作即时生效，无表单可存）。
    const tabButtons = Array.from(document.querySelectorAll('.tabs button'));
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
        ['api', 'compat', 'oauth'].forEach((name) => {
          el('tab-' + name).classList.toggle('active', btn.dataset.tab === name);
        });
        el('saveActions').style.display = btn.dataset.tab === 'oauth' ? 'none' : 'flex';
      });
    });
    function render(state) {
      el('baseUrl').value = state.baseUrl;
      el('modelId').value = state.modelId;
      el('modelName').value = state.modelName;
      el('thinking').checked = state.thinking;
      el('thinkingLevel').value = state.thinkingLevel;
      el('apiKey').value = '';
      el('thinkingFormat').value = state.thinkingFormat;
      el('supportsDeveloperRole').checked = state.supportsDeveloperRole;
      if (!el('oauthProvider').value) el('oauthProvider').value = state.providerId;
      el('oauthNote').textContent = state.oauthNote + '。auth.json 路径：' + state.authPath;
      el('keyState').textContent = state.hasKey
        ? 'API key 已保存于 SecretStorage（' + state.providerId + '）'
        : '尚未保存 API key';
      el('pathHint').textContent = '配置写入 ' + state.modelsPath +
        '；API key 只存 VS Code SecretStorage，文件中保留占位符。';
      el('compatHint').textContent = '保存后写入 models.json providers[' + state.providerId +
        '].compat；默认值不落字段，已有的其他 compat 字段原样保留。';
    }
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') render(msg.payload);
      if (msg.type === 'saved') { render(msg.payload); setStatus('已保存', true); }
      if (msg.type === 'error') setStatus(msg.payload, false);
      if (msg.type === 'oauthStatus') {
        el('oauthLogin').disabled = false;
        setStatus(msg.payload.message, msg.payload.ok);
      }
    });
    el('save').addEventListener('click', () => {
      setStatus('', true);
      vscode.postMessage({
        type: 'save',
        payload: {
          baseUrl: el('baseUrl').value,
          modelId: el('modelId').value,
          modelName: el('modelName').value,
          thinking: el('thinking').checked,
          apiKey: el('apiKey').value,
          thinkingLevel: el('thinkingLevel').value,
          thinkingFormat: el('thinkingFormat').value,
          supportsDeveloperRole: el('supportsDeveloperRole').checked
        }
      });
    });
    el('openFile').addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));
    el('oauthLogin').addEventListener('click', () => {
      el('oauthLogin').disabled = true;
      setStatus('OAuth 登录进行中…（浏览器 / 输入框交互见 VS Code 提示）', true);
      vscode.postMessage({ type: 'oauthLogin', providerId: el('oauthProvider').value.trim() });
    });
    el('openAuthFile').addEventListener('click', () => vscode.postMessage({ type: 'openAuthFile' }));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
