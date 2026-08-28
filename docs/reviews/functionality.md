# at-opsAgent 基础功能法证审计报告

审计对象：`/workspace`（at-ops-agent v0.1.0，VS Code 扩展）
审计方式：全量源码走读 + 依赖包（pi SDK 0.84.3）API 核对 + 可运行冒烟复现（mock OpenAI 服务器 + 真实 `createOpsRuntime`）
环境事实：`npm install` 成功、`npm run compile` 成功、`npm run typecheck` 成功、`npm test` 301/301 全绿——**但产物 bundle 在运行期必然坏死（见 §3 根因 #1，已用可复现实验证明）**。

---

## 1. 端到端链路追踪（配置 LLM → 发消息 → 流式回复）

### 1.1 配置阶段（设置页保存模型 + API key）

| 步骤 | 文件:符号 | 说明 |
|---|---|---|
| 1 | `src/webview-settings/components/ModelsTab.vue` → `store.saveModels()` | 表单（baseUrl / modelId / apiKey / thinkingLevel / compat）点「保存」 |
| 2 | `src/webview-settings/store.ts:saveModels` → `helpers.ts:buildModelsSavePayload` | 组 `models/save` req（apiKey 为空整键省略=保持现有 key），发送后本地立即清空 apiKey |
| 3 | `src/host/settingsView.ts:onMessage` | req 信封（v:1）路由到 `HostController.handleRequest` |
| 4 | `src/host/hostController.ts:handleRequest('models/save')` → `saveModelsFromSettings` | 调 `saveModelsForm` |
| 5 | `src/host/modelsView.ts:saveModelsForm` | 写 `~/.at-series/agent/models.json`（0600）：upsert 第一个 provider（缺省 id `internal-gateway`，`api: openai-completions`），**apiKey 字段永远写占位符 `${secret:atOpsAgent.llmApiKey}`**；真 key 走 `OpsSecrets.setLlmApiKey`（`src/host/secrets.ts`，VS Code SecretStorage）；thinkingLevel 合并写 `settings.json`（`src/host/agentSettings.ts:patchAgentSettings`） |
| 6 | `hostController.saveModelsFromSettings` 后半 | `setModel(applied)`（持久化 lastModel、丢弃现有 runtime）→ 广播 `capabilities/snapshot` + `hydrate` → `void this.ensureRuntime()` 预热重建 |

结论：**配置写盘链路本身是通的、且安全设计到位**（key 只进 SecretStorage、文件只留占位符、0600 权限）。

### 1.2 发消息阶段

| 步骤 | 文件:符号 | 说明 |
|---|---|---|
| 1 | `src/webview-chat/components/Composer.vue:send` → `store.sendPrompt` | `store-helpers.ts:buildPromptPayload` 组 `chat/prompt`（流式中=steer / 刚结束一轮=followUp） |
| 2 | `src/host/chatView.ts:onMessage` | 路由 `HostController.handleRequest` |
| 3 | `src/host/hostController.ts:handlePrompt` | append user item → 广播 `transcript/append` → `ensureRuntime()` → `advancePlaybookForPrompt()` → `runtime.prompt(text)` |
| 4 | `src/host/hostController.ts:createRuntime` | `modules.ts:loadRuntimeModule` 动态 import `src/runtime` → `createOpsRuntime(handlers, { model: resolveRuntimeModelPref(), getApiKey: () => secrets.getLlmApiKey(), thinkingLevel, … })` |
| 5 | `src/runtime/index.ts:createPiRuntime` | 动态 `import('@earendil-works/pi-coding-agent')` → `ModelRuntime.create({ authPath, modelsPath, modelsStorePath })` → **`setRuntimeApiKey(provider, key)` 把 SecretStorage 的 key 注入 pi 凭证层覆盖占位符** → `resolveModel`（`getModel(provider,id)`，找不到再 `getAvailable()` 兜底）→ `createAgentSession({ noTools:'builtin', customTools, thinkingLevel, … })` |

### 1.3 流式回复阶段

| 步骤 | 文件:符号 | 说明 |
|---|---|---|
| 1 | `src/runtime/index.ts:subscribeSessionEvents` | pi `AgentSessionEvent`：`message_update.text_delta/thinking_delta` → `OpsRuntimeEvent`；`tool_execution_start/end` → `tool_start/tool_end`；`agent_end` → `idle` |
| 2 | `src/host/hostController.ts:onRuntimeEvent` | `text_delta` → store 追加 + 广播 `transcript/append`/`transcript/patch{appendText}`；`idle` → finalize + `turn/end` |
| 3 | `src/host/chatView.ts` + `src/host/streamBatcher.ts` | 仅 `transcript/patch`/`thinking/delta` 参与 40ms 合批，其余先冲刷保序；res 前 flush |
| 4 | `src/webview-chat/store.ts:handleEvent('transcript/patch')` → `patchItem` | appendText 拼接、`streaming:false` 收尾 → `ChatTranscript.vue` 渲染 |

### 1.4 冒烟复现结论（法证核心证据）

用真实 `src/runtime/index.ts` + mock OpenAI SSE 服务器 + 表单同款 models.json（占位符 apiKey）实测：

- **ESM 方式运行（等价于 vitest 测试环境）**：完全正常。收到 `text_delta`×3 + `idle`，服务器收到的鉴权头为 `Authorization: Bearer sk-from-secretstorage` —— 证明 SecretStorage → `setRuntimeApiKey` 注入正确、占位符被覆盖。
- **按 `esbuild.extension.mjs` 同款配置打成 CJS bundle 运行（等价于发布产物 `dist/extension.js`）**：`createOpsRuntime` 创建期抛 `The "path" argument must be of type string or an instance of URL. Received undefined`，被 `createOpsRuntime` 的 catch 吞掉后回落 `createFallbackRuntime`，**每条消息永远回复「未配置模型，请在设置中写入 API key…（原因：The "path" argument…）」**。
- 在 `dist/extension.js` 中可直接找到病灶：`m5={},YXt=(0,z$e.fileURLToPath)(m5.url)` —— `m5` 是 esbuild 对 `import.meta` 的空对象 shim，`m5.url === undefined`。
- **修复验证**：给 esbuild 加 `define:{'import.meta.url':'__importMetaUrl'}` + banner 注入 `pathToFileURL(__filename).href` 后，同一 CJS bundle 流式问答完全跑通。

---

## 2. 功能成熟度表

| 功能 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| 编译/类型/单测 | WORKING | `npm run compile`、`typecheck`、`vitest` 301/301 全绿 | 无任何针对 CJS 产物 bundle 的冒烟测试——致命 bug 对测试体系不可见（vitest 走 ESM） |
| 模型配置表单（设置页 Models 页签） | WORKING | `ModelsTab.vue` + `store.ts:saveModels` + `modelsView.ts:saveModelsForm`；写盘/回读/占位符/0600 都正确 | 只能管理「第一个 provider」（`saveModelsForm` 取 `Object.keys(providers)[0]`）；无「拉取模型列表」能力，model id 全靠手填 |
| API key 保存（SecretStorage vs 明文） | WORKING | `secrets.ts:OpsSecrets`（仅 SecretStorage）；`modelsView.ts:SECRET_PLACEHOLDER` 落盘只有占位符；`helpers.ts:normalizeModelsState` 强制 apiKey 永不回显 | 单一全局 key（`atOpsAgent.llmApiKey`）——多 provider 各自 key 不支持；`secrets.ts:resolvePlaceholder` 是死代码（无人调用） |
| models.json 读写一致性 | WORKING | 写：`modelsView.ts:saveModelsForm`；读：`modelsCatalog.ts:listConfiguredModels`（chat 选择器与 hydrate 共用同一解析）；lastModel 存 `settings.json`（`readLastModel`/`pickSelectedModel`） | 模型条目写 `thinking` 字段，但 pi 的 schema 是 `reasoning`（见 pi `docs/models.md` Model Configuration 表）→「支持思考」勾选是 **no-op**（STUB） |
| runtime 接入 pi SDK（模型/凭证传递） | 源码 WORKING / **产物 BROKEN** | `runtime/index.ts:createPiRuntime`：`ModelRuntime.create` + `setRuntimeApiKey`（含「实际选中 provider ≠ 首选 provider」二次注入）+ `resolveModel` + `createAgentSession`，API 面与 pi 0.84.3 dist 完全吻合；ESM 冒烟全通 | CJS bundle 中 pi 的 `import.meta.url` 变 undefined → 创建期必炸 → 永远 FallbackRuntime（§3 根因 #1） |
| 流式事件到 webview | WORKING | `subscribeSessionEvents` → `onRuntimeEvent` → `StreamBatcher`（保序合批）→ `store.patchItem`；ESM 冒烟验证 delta 逐段到达 | 同上，产物态整条链路根本走不到 |
| Chat 模型选择器与设置同步 | WORKING | 双向：`model/set` → `setModel`（持久化 + disposeRuntime + 广播 snapshot）；`models/save` → 广播 `capabilities/snapshot`+`hydrate`；`ModelSelector.vue` 乐观更新后被快照覆盖 | 首帧 hydrate 有竞态（见下行） |
| Chat webview 初始 hydrate | PARTIAL | `chatView.ts:resolveWebviewView` 设完 html **立即** `postHydrate()` 推送；`webview-chat/store.ts:attach` 只挂监听，**从不主动拉 `hydrate`、且完全忽略 `dir:'res'`** | 脚本尚未加载时首帧可能丢失（无 ready 握手）→ 选择器可能显示「去设置添加」直到下一次广播；mock-host 启动即发 hydrate，掩盖了这个竞态 |
| 会话管理（新建/列表/切换） | PARTIAL | host：`sessionStore.ts`（内存包保存/恢复、审批令牌跨会话作废）WORKING；设置页 Sessions 页签发 `{id}` WORKING | **chat 历史抽屉切换 BROKEN**：`webview-chat/store.ts:switchSession` 发 `{sessionId}`，host `handleRequest('session/switch')` 只读 `payload.id`（`protocol/host-protocol.ts:SessionSwitchReq`）→ 永远 `{ok:false}` 且 UI 无提示；会话不落盘（重启全丢，仅 pi 侧 JSONL 有主会话记录） |
| 中止（abort） | WORKING | `Composer.vue` 停止按钮 / `atOpsAgent.abort` 命令 → `chat/abort` → `hostController.abort`（级联子代理）→ `runtime.abort` → `session.abort()` → `agent_end` → `idle` → streaming 收尾 | — |
| 审批闭环 | PARTIAL | 有 playbook run 时完整：`gateToolCall` → `requestSessionApproval` → orchestrator 9 要素简报 → `ApprovalBar` → `applyApproval`（HMAC 令牌只存 host 内存）；命令面板兜底 `commands.ts:respondToApproval` | **无 playbook run 时死路**：`hostController.requestSessionApproval` 要求 `this.activeRun`，普通对话中 write/exec 工具被拦只回一句文本拒绝、永不产生审批卡片 → 模型无法推进；chat store 不处理 `approval/resolve` evt（他处批准后卡片残留） |
| 模型选择器空态/错误呈现 | PARTIAL | 空清单显示「去设置添加模型」（`ModelSelector.vue`）；prompt 期错误回一条 `模型调用失败：…` 文本（`runtime/index.ts:prompt` catch） | 创建期失败一律被包装成「未配置模型，请在设置中写入 API key（原因：…）」（`createFallbackRuntime`）——**用户已配置时此文案严重误导**（正是产品负责人看到的现象）；无 fetch-models 因此也无对应错误面 |
| OpenAI-compatible 接入 | WORKING（源码层） | 表单默认 `api:'openai-completions'` + 自定义 baseUrl；pi 原生支持 | — |
| Anthropic / OpenRouter / Ollama / 自定义 baseURL | PARTIAL | pi 均支持（`anthropic-messages` 等 API 类型、任意 baseUrl；OpenRouter/Ollama 走 openai-completions）；`listConfiguredModels` 可解析任意 provider | UI 无入口：表单只能编辑一个 openai-completions provider，其余全靠手改 models.json（「打开 models.json」模板也只有单 provider）；Ollama 无 key 场景会把占位符当 Bearer 发出（Ollama 无所谓，真网关会 401） |
| OAuth 登录 | PARTIAL（源码）/ 产物 BROKEN | `oauthLogin.ts:loginOAuthViaPi`：pi `ModelRuntime.login` + VS Code InputBox/QuickPick/openExternal 交互、auth.json 0600、token 不落日志——实现完整 | 同根因 #1：产物态 `import('@earendil-works/pi-coding-agent')` 必炸 → **打包后 OAuth 100% 失败**；`RuntimeLike.loginOAuth` 真 runtime 从未实现（`runtime/index.ts` 返回对象无此方法），「优先 runtime」分支是死分支；OAuth provider 输入框默认回填 `internal-gateway`（非 OAuth provider，必失败） |
| Playbook 启动 | WORKING | `atOpsAgent.pickPlaybook` 命令 + `/playbook` picker + `ops_start_playbook`（`runtime/playbook-tools.ts`）→ `startPlaybook` → 阶段驱动 + L4 注入；`skills/playbooks/` 8 条真实 yaml；真编排器 `orchestrator/index.ts:createOrchestrator` 存在且被测试覆盖 | 产物态下模型不可用，链路只能走到阶段展示，问答部分同样死于根因 #1 |
| MCP / hub 接入 | WORKING | 真模块 `hub-host/index.ts:createAtSeriesHubHost`（481 行处导出）+ 兜底 `fallback/fallbackHub.ts`（真实读 `~/.at-series/bridges` 并可 invoke，非空壳）；mcp.json 编辑器（脱敏/回填/0600）`hostController.readMcpRedacted/saveMcp`；外部 MCP 代理工具 `mcp-client/external.ts:createExternalMcpProxyTools` 已在 runtime 装配 | — |
| `src/host/fallback/**` 是真链路还是 stub？ | 按设计是兜底 | `fallbackHub` 真实可用（只读 hub）；`fallbackRuntime`/`fallbackOrchestrator` 是显式降级 stub，仅在并行模块缺失时启用 | 问题在于：**根因 #1 让 pi 内部的 `createFallbackRuntime` 在产物态变成了 100% 命中的「主链路」** |
| 死代码 | — | `modelsView.ts:showModelsPanel`（整套三页签 HTML 面板无人调用，命令已改走设置页）；`src/host/trees/*` 5 个 TreeView 无人 import；`secrets.ts:resolvePlaceholder` | 清理或接线 |

---

## 3. 「连配置 LLM 问答都无法完成」的根因（按可能性排序）

### #1（确定，100% 复现）：ESM-only 的 pi SDK 被打进 CJS bundle，`import.meta.url` 变 undefined → runtime 创建必炸 → 永远回落「未配置模型」

- `esbuild.extension.mjs`：`format:'cjs'`、`bundle:true`、仅 `external:['vscode']` → `@earendil-works/pi-coding-agent`（`"type":"module"`，内部大量 `fileURLToPath(import.meta.url)`，如其 `dist/utils/shell.js`、`dist/config.js`）被整包内联进 `dist/extension.js`（6.6MB，含 `ModelRuntime`）。
- esbuild 对 CJS 输出把 `import.meta` 降级为空对象且**不报 warning**（实测 `logLevel:'warning'` 零告警）——产物中可见 `m5={},YXt=(0,z$e.fileURLToPath)(m5.url)`。
- 运行期链条：`hostController.handlePrompt` → `ensureRuntime` → `runtime/index.ts:createOpsRuntime` → `await import('@earendil-works/pi-coding-agent')`（bundle 内的懒加载 `__esm` 工厂）→ 模块求值期 `fileURLToPath(undefined)` 抛 `ERR_INVALID_ARG_TYPE` → 被 `createOpsRuntime` 的 try/catch 捕获 → `createFallbackRuntime(handlers, reason)` → 每条 prompt 固定回复 `FALLBACK_NOTICE`「未配置模型，请在设置中写入 API key…（原因：The "path" argument must be of type string or an instance of URL. Received undefined）」。
- **这解释了全部症状**：用户把 baseUrl/key 配得再对，聊天永远说「未配置模型」；OAuth 登录（`oauthLogin.ts:loginOAuthViaPi` 同样动态 import pi）也 100% 失败。
- **为什么测试全绿**：vitest 以 ESM 直跑 `src/`，从不经过 esbuild CJS 产物；`test/runtime.test.ts` 里「createOpsRuntime 安全回退」的用例反而把这个致命回退当成了「预期行为」。
- 修复已预验证：`define:{'import.meta.url':'__importMetaUrl'}` + banner 注入后同款 CJS bundle 全链路跑通（含 SecretStorage key 注入、SSE 流式）。

### #2（高概率叠加）：chat webview 首帧 hydrate 竞态，无 ready 握手

- `chatView.ts:resolveWebviewView` 在 `webview.html = …` 之后**同步** `postHydrate()`；此刻 `chat.js` 尚未加载、监听未挂上，消息可能被丢弃（VS Code 不为未就绪页面排队）。
- `webview-chat/store.ts:attach` 只 `addEventListener`，**不主动发 `hydrate` req**，且 `dir:'res'` 一律忽略（host 的 `handleRequest('hydrate')` 有实现但 chat 侧无人消费）。
- 后果：慢加载时选择器空、transcript 空，直到某次 `capabilities/snapshot` 广播（依赖 hub 目录变化）才恢复——用户观感是「配置了也没模型可选」。`mock-host.ts` 启动即回放 hydrate，开发态看不见这个问题。

### #3（中低，特定操作序列）：未存 key 时占位符被当真 Bearer 发出，报错文案误导

- 用户跳过表单、直接手编 models.json（模板 apiKey 就是 `${secret:…}`）且从未在表单里存过 key：pi 的取值解析（`pi-coding-agent/dist/core/resolve-config-value.js`，`ENV_VAR_NAME_RE` 不匹配含 `:`/`.` 的名字）把占位符**按字面量**处理 → 网关收到 `Bearer ${secret:atOpsAgent.llmApiKey}` → 401 → 聊天里只有一句「模型调用失败：…」。
- `hostController.hasApiKey` 只在启动和 `models/save` 后刷新，UI 不会拦截这种半配置状态。

### #4（低，体验性而非阻断）：其余接线错误

- chat 历史切会话 `{sessionId}` vs `{id}` 不匹配（BROKEN，静默失败）；
- `thinking` 字段对 pi 无效（应为 `reasoning`）→ 思考开关 no-op；
- 无 playbook run 时审批链路死路（write/exec 工具永远被文本拒绝）。

---

## 4. 整改建议

### P0（必须让最小问答跑通）

1. **修 esbuild CJS 产物的 `import.meta` 病灶**（根因 #1）
   - 改 `esbuild.extension.mjs`：
     ```js
     define: { 'import.meta.url': '__importMetaUrl' },
     banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" }
     ```
     （本审计已用同款配置验证 CJS bundle 全链路流式跑通。）
   - 备选方案：`external: ['@earendil-works/*']` + 打包时携带 node_modules（去掉 `--no-dependencies`）——体积大、慢，不推荐。
   - **验收标准**：`npm run package` 出的 VSIX 安装到干净 VS Code → 设置页填 OpenAI-compatible baseUrl/model/key → 聊天发「你好」→ 流式回复逐字出现；Output Channel 出现 `[runtime] createOpsRuntime 完成` 而非 fallback 日志。

2. **加产物冒烟测试，堵住「测试全绿产物全坏」的盲区**
   - 新增 `test/bundle-smoke`（或 npm script）：用 `esbuild.extension.mjs` 同款配置把一个引 `createOpsRuntime` 的 harness 打成 CJS，起本地 mock OpenAI SSE 服务器，断言收到 `text_delta` 且鉴权头 = 注入 key（本审计的 `/tmp/audit/harness.ts` + `mock-server.mjs` 可直接改造）。
   - **验收标准**：把 define/banner 修复撤掉时该测试必红；CI 必跑。

3. **chat webview ready 握手**（根因 #2）
   - 改 `src/webview-chat/store.ts:attach`：挂完监听后 `this.post('hydrate', {})`，并在消息处理里接受 `dir:'res' && type:'hydrate'` 走 `applyHydrate`（host 的 `handleRequest('hydrate')` 已就绪，零 host 改动）；或 host 侧等 webview 首条消息再 push。
   - **验收标准**：人为给 chat.js 加 500ms 延迟加载，打开视图仍能渲染会话与模型清单。

4. **修 chat 历史切会话协议不匹配**
   - `src/webview-chat/store.ts:switchSession` 改发 `{ id }`；或 `hostController.handleRequest('session/switch')` 同时接受 `id`/`sessionId`。
   - **验收标准**：历史抽屉点旧会话，transcript 正确切换。

5. **纠正误导性错误文案**
   - `src/runtime/index.ts:createFallbackRuntime`：仅当失败原因确属「无凭证/无可用模型」时说「未配置模型」；其他创建期异常直说「模型运行时初始化失败：<原因>」，并附「查看 Output → AT Ops Agent」指引。
   - **验收标准**：故意打坏 bundle/断网时，聊天提示不再让用户去改配置。

### P1（配置体验补齐）

6. `src/host/modelsView.ts:saveModelsForm` / `MODELS_TEMPLATE`：模型条目 `thinking` → `reasoning`（pi schema），表单读取端 `readModelsFormState` 同步；兼容读旧字段。验收：勾选思考 + thinkingLevel=high 时请求携带对应 reasoning 参数。
7. 无 playbook run 的会话审批：`hostController.requestSessionApproval` 在 `activeRun` 缺席时自动开一个隐式 run（或允许 orchestrator 无 run 出简报），保证普通对话里 write/exec 也能弹 `ApprovalBar`。验收：不启动 playbook 直接让模型调 exec 工具，能出现审批卡且批准后重试放行。
8. 多 provider key：SecretStorage 键改为 `atOpsAgent.llmApiKey.<providerId>`（保留旧键迁移读取），`createPiRuntime` 按 provider 取 key。验收：两个 provider 各自 key 互不串用。
9. Models 页签加「测试连接 / 拉取模型列表」：GET `{baseUrl}/models` 显示可选 id 与失败原因（401/超时/DNS 分类），错误直接显示在 `store.status.models`。验收：错 key 时 2 秒内看到 401 明示。
10. chat store 处理 `approval/resolve` 与 `turn/end`（清 pendingApproval / 兜底收尾 streaming）。

### P2（清理与加固）

11. 删除死代码：`modelsView.ts:showModelsPanel` 整段 HTML 面板、`src/host/trees/*`、`secrets.ts:resolvePlaceholder`（或真正用它做占位符解析兜底）。
12. OAuth 页：provider 输入改为 pi 已注册 provider 下拉（`getRegisteredProviderIds`），默认值不要回填 `internal-gateway`；登录成功后刷新 `hasApiKey`/auth 状态展示。
13. 会话持久化：`SessionStore` 快照落盘 `agentDir/sessions-ui.json`（pi 侧 JSONL 已存在，可做只读回放）。
14. `esbuild.extension.mjs` 提 `logLevel:'warning'` 并 `metafile:true`，CI 里对 bundle 尺寸与 `import.meta` 出现次数做守门。
15. 表单支持多 provider / API 类型下拉（openai-completions / anthropic-messages / google-generative-ai），覆盖 Anthropic、OpenRouter、Ollama 模板一键填充。

---

## 5. 最小可行验收清单（安装后 2 分钟内用 OpenAI-compatible key 完成一轮对话）

前置：P0 #1、#3、#4 完成后的 VSIX。

1. **[30s] 安装启动**：安装 VSIX → 打开活动栏「AT Ops Agent」→ 聊天视图渲染出欢迎态与 composer（验证 hydrate 握手）；状态栏出现 `$(shield) AT Ops`。
2. **[40s] 配置模型**：composer 里模型选择器显示「去设置添加模型」→ 点齿轮（`atOpsAgent.openSettings`）→ Models 页签 → 填 `Base URL`（如 `https://api.openai.com/v1` 或内网网关）、`模型 ID`（如 `gpt-4o-mini`）、`API Key` → 保存 → 状态行显示「已保存」，keyState 变「API key 已保存于 SecretStorage」。
   - 抽查：`cat ~/.at-series/agent/models.json` 中 apiKey 必须是 `${secret:atOpsAgent.llmApiKey}` 占位符、文件权限 0600。
3. **[30s] 首轮问答**：回聊天视图 → 模型选择器已自动出现刚配的模型（验证 `models/save` → 广播同步）→ 发「用一句话介绍你自己」→ **回复逐字流式出现**，结束后停止按钮消失、可追问（按钮变「追问」）。
4. **[10s] 中止**：再发一条长任务提示词 → 流式中点「⏹ 停止」→ 输出立即停住、UI 回到可输入态。
5. **[10s] 切换模型**：选择器换另一个模型（或 provider）→ 再发一条消息 → Output Channel 出现「切换模型 …，重建会话」且回复正常（验证 `model/set` → disposeRuntime → 重建）。
6. **失败路径抽查**：把 key 改错重存 → 发消息 → 聊天内 2 秒级出现明确的「模型调用失败：…401…」而非「未配置模型」。

任一步不满足即打回；第 3 步是产品负责人所报问题的直接回归项。

---

### 附：审计中使用的复现材料
- mock SSE 服务器 + harness：`/tmp/audit/mock-server.mjs`、`/tmp/audit/harness.ts`（CJS 版复现故障、ESM 版与加 define/banner 的 CJS 版证明链路正确）。
- 病灶定位：`rg "fileURLToPath" dist/extension.js` 可见 `m5={},…fileURLToPath(m5.url)`。
