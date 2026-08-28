/**
 * Models 配置页（atOpsAgent.openModels 打开的 WebviewPanel）。
 *
 * 简单 HTML 表单（无 Vue）配置一个 OpenAI 兼容 provider：
 * baseUrl / 模型 id / thinking 开关。API key 只进 VS Code SecretStorage
 * （atOpsAgent.llmApiKey）——models.json 永远保留 ${secret:…} 占位符，
 * 不落明文、不回显、不进日志。高级编辑走「打开 models.json」次级动作。
 *
 * CSP 与 nonce 模式对齐 src/host/webviewHtml.ts；脚本内联（无 dist 依赖）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LLM_API_KEY_SECRET, type OpsSecrets } from './secrets';
import { getNonce } from './webviewHtml';

export interface ModelsPanelDeps {
  modelsPath: string;
  secrets: OpsSecrets;
  output: vscode.OutputChannel;
  /** 保存成功后刷新 Models 树等。 */
  refreshTrees: () => void;
}

const DEFAULT_PROVIDER_ID = 'internal-gateway';
const DEFAULT_API = 'openai-completions';
const SECRET_PLACEHOLDER = `\${secret:${LLM_API_KEY_SECRET}}`;

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
}

interface SavePayload {
  baseUrl?: unknown;
  modelId?: unknown;
  modelName?: unknown;
  thinking?: unknown;
  apiKey?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const error = await saveModels(deps, payload);
    if (error) {
      void panel.webview.postMessage({ type: 'error', payload: error });
      return;
    }
    deps.refreshTrees();
    deps.output.appendLine(`[models] 已保存 ${deps.modelsPath}（apiKey 走 SecretStorage）`);
    await postState(panel, deps, 'saved');
    return;
  }
  if (type === 'openFile') {
    await openModelsJson(deps);
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
    modelsPath: deps.modelsPath
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
  return state;
}

/**
 * 保存：upsert 第一个 provider（其余 provider / 字段原样保留），
 * apiKey 字段永远写占位符；用户填了 key 才更新 SecretStorage。
 * 返回错误消息（成功返回 undefined）。
 */
async function saveModels(deps: ModelsPanelDeps, payload: SavePayload): Promise<string | undefined> {
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
  const modelName = typeof payload.modelName === 'string' ? payload.modelName.trim() : '';
  const thinking = payload.thinking === true;
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (baseUrl.length === 0 || modelId.length === 0) {
    return 'Base URL 与模型 ID 不能为空。';
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

  const provider: Record<string, unknown> = {
    ...existing,
    baseUrl,
    api: typeof existing.api === 'string' ? existing.api : DEFAULT_API,
    apiKey: SECRET_PLACEHOLDER,
    models
  };

  try {
    await fs.mkdir(path.dirname(deps.modelsPath), { recursive: true });
    await fs.writeFile(
      deps.modelsPath,
      `${JSON.stringify({ ...root, providers: { ...providers, [providerId]: provider } }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    if (apiKey.length > 0) {
      await deps.secrets.setLlmApiKey(apiKey);
    }
  } catch (err) {
    return `保存失败: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
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
    .desc { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 16px; }
    label { display: block; margin: 12px 0 4px; font-size: 12px; }
    input[type="text"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
    }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .checkbox { display: flex; align-items: center; gap: 6px; margin: 14px 0; font-size: 12px; }
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
    #keyState { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    #status { margin-top: 12px; font-size: 12px; min-height: 16px; }
    #status.ok { color: var(--vscode-testing-iconPassed, #73c991); }
    #status.err { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h1>模型配置（OpenAI 兼容）</h1>
  <p class="desc" id="pathHint">配置写入 ~/.at-series/agent/models.json；API key 只存 VS Code SecretStorage，文件中保留占位符。</p>
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
  <label for="apiKey">API Key</label>
  <input type="password" id="apiKey" autocomplete="off" placeholder="留空 = 保持现有 key" />
  <div id="keyState"></div>
  <div class="actions">
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
    function render(state) {
      el('baseUrl').value = state.baseUrl;
      el('modelId').value = state.modelId;
      el('modelName').value = state.modelName;
      el('thinking').checked = state.thinking;
      el('apiKey').value = '';
      el('keyState').textContent = state.hasKey
        ? 'API key 已保存于 SecretStorage（' + state.providerId + '）'
        : '尚未保存 API key';
      el('pathHint').textContent = '配置写入 ' + state.modelsPath +
        '；API key 只存 VS Code SecretStorage，文件中保留占位符。';
    }
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') render(msg.payload);
      if (msg.type === 'saved') { render(msg.payload); setStatus('已保存', true); }
      if (msg.type === 'error') setStatus(msg.payload, false);
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
          apiKey: el('apiKey').value
        }
      });
    });
    el('openFile').addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
