# 04 — piagent 技术栈分析：at-opsAgent 应如何「基于 piagent」构建 VS Code 运维 Agent

> 调研对象：
> - `/tmp/research/pi`（earendil-works/pi，即原 badlogic/pi-mono，官方 pi coding agent 单仓，v0.84.3）
> - `/tmp/research/pi-agent-studio`（JohnnyZ93/pi-agent-studio v1.3.6，upstream 为 pithings/pi-vscode，功能最全的 VS Code 封装）
> - `/tmp/research/vspi`（LightningBerk/vspi，轻量 RPC sidebar 封装）
>
> 结论先行：**推荐路线 D 的变体——「pi SDK in-process 嵌入为主 + 有选择地移植（vendoring）pi-agent-studio 的成熟模块」**，不整仓 fork Studio。详见 §3。

---

## 0. 关键事实速查（先纠正一个前提）

| 事实 | 证据 |
|---|---|
| `@mariozechner/*` 与 `@earendil-works/*` **不是分叉关系，而是官方改名** | npm 上 `@mariozechner/pi-coding-agent` 停在 0.73.1，2026-05-07 起标记 deprecated：`"please use @earendil-works/pi-coding-agent instead going forward"`；`@earendil-works/pi-coding-agent` 同日创建，现为 0.84.3、持续发版（最近 2026-08-24）。作者同为 Mario Zechner（Earendil Works 是其公司主体），仓库从 `badlogic/pi-mono` 迁至 `github.com/earendil-works/pi` |
| pi-agent-studio 用的是**当前官方包**（`^0.84.0`），不是分叉 | `pi-agent-studio/package.json` dependencies |
| vspi 用的是**已弃用的旧 scope**（`@mariozechner/pi-coding-agent`），处于落后状态 | `vspi/README.md` 安装说明 |
| 三个仓库全部 **MIT 许可** | `pi/LICENSE`（Mario Zechner）、`pi-agent-studio/LICENSE`（Johnny Zhao）、`vspi/LICENSE` 均为 MIT；npm 各包 license 字段 MIT |
| pi-agent-studio 本身也是 fork（upstream = `pithings/pi-vscode`），是社区个人项目而非官方产品 | `git remote -v` |

因此「基于 piagent 构建」在工程上应理解为：**基于 `@earendil-works/pi-*` 官方 npm 包构建，并参考/移植 pi-agent-studio 的 VS Code 集成经验**。

---

## 1. pi-mono 运行时分析

### 1.1 包结构与分层

```
@earendil-works/pi-ai          （packages/ai）    统一多 provider LLM 流式 API + 模型目录 + 凭证/OAuth
@earendil-works/pi-agent-core  （packages/agent） Agent loop + 工具调用 + 状态管理（不含任何 UI/持久化）
@earendil-works/pi-coding-agent（packages/coding-agent）CLI + SDK：AgentSession、SessionManager、
                                                  SettingsManager、ModelRuntime、ResourceLoader、
                                                  extensions/skills/prompts、TUI/print/RPC 三种模式
@earendil-works/pi-tui         终端 UI 库（差分渲染）——对 VS Code 场景基本无用
@earendil-works/pi-telemetry   厂商中立遥测契约
```

所有包同版本号 lockstep 发布（当前 0.84.x），Node ≥ 22.19.0，`type: module`，直接依赖 pin 精确版本、发布 npm-shrinkwrap（供应链强化，见 pi 根 README「Supply-chain hardening」）。

### 1.2 Agent loop（packages/agent）

核心在 `packages/agent/src/agent-loop.ts` + `types.ts`，约 800 行、零 UI 依赖，是**可单独复用的最小内核**：

- **入口**：`agentLoop(prompts, context, config, signal, streamFn)` 与 `agentLoopContinue(...)`（重试/续跑），返回 `EventStream<AgentEvent, AgentMessage[]>`。
- **事件模型**（`AgentEvent`）：`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`。一个 turn = 一次 LLM 响应 + 其全部工具调用。
- **工具**（`AgentTool`）：typebox schema（`parameters: TSchema`）+ `execute(toolCallId, params, signal, onUpdate)`，支持流式部分结果（`onUpdate`）、`executionMode: "sequential" | "parallel"`（默认 parallel，单工具可覆盖）、`terminate` 提前终止提示。
- **拦截钩子**（`AgentLoopConfig`）——运维权限门的天然挂点：
  - `beforeToolCall(ctx, signal) → { block, reason, terminate }`：阻断工具执行（pi-agent-studio 的危险命令审批就建在此机制的上层封装 `tool_call` 事件上）；
  - `afterToolCall`：改写工具结果（content/details/isError/usage）；
  - `transformContext` / `convertToLlm`：LLM 调用前的上下文改写（compaction、注入外部上下文）；
  - `getSteeringMessages` / `getFollowUpMessages`：mid-run 转向与排队（`QueueMode: all | one-at-a-time`）；
  - `shouldStopAfterTurn` / `prepareNextTurn`：逐 turn 停止/换模型换上下文；
  - `getApiKey(provider)`：每次 LLM 调用动态取 key（适配短时 OAuth token）。
- **自定义消息**：`AgentMessage = Message | CustomAgentMessages[...]`，通过 declaration merging 扩展应用级消息类型（运维场景可加 `alertContext`、`runbookStep` 等角色）。

### 1.3 LLM provider 抽象（packages/ai）

- **统一流式接口**：`StreamFn(model, context, options) → AssistantMessageEventStream`；事件为 `start / text_* / thinking_* / toolcall_* / done / error`。失败契约明确：不 throw，错误编码进流内（`stopReason: "error" | "aborted"` + `errorMessage`）。
- **内置 API 类型**（`Api`）：`anthropic-messages`、`openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`mistral-conversations`、`google-generative-ai`、`google-vertex`、`bedrock-converse-stream`。
- **自定义模型三条路**（对私有化运维环境极其重要）：
  1. **`~/.pi/agent/models.json`**（声明式，见 `docs/models.md`）：`providers.<id>.{baseUrl, api, apiKey, headers, authHeader, compat, models[]}`；`apiKey`/`headers` 值支持 `$ENV`、`${ENV}`、`!command`（执行命令取值）；`compat` 覆盖大量兼容项（`supportsDeveloperRole`、`maxTokensField`、`thinkingFormat: qwen/deepseek/zai/...`、`cacheControlFormat: anthropic`、`thinkingLevelMap` 等）——对接国产/内网 OpenAI 兼容网关基本零代码。
  2. **扩展 `pi.registerProvider()`**（`docs/custom-provider.md`）：可只覆盖 baseUrl/headers（走企业代理），可注册全新 provider + OAuth（`login/refreshToken/getApiKey` 三件套，凭证持久化到 `auth.json`），可提供完全自定义 `streamSimple` 流实现。
  3. **SDK `ModelRuntime`**：`ModelRuntime.create({ authPath, modelsPath, credentials })`，凭证解析优先级 = runtime override → auth.json（API key/OAuth）→ 环境变量 → models.json fallback；支持 `InMemoryCredentialStore` 注入（**at-opsAgent 可以把凭证托管到 VS Code SecretStorage，实现零明文落盘**）。
- **thinking**：统一 `ThinkingLevel`（off→max 七级）+ 每模型 `thinkingLevelMap`、`thinkingBudgets` 设置。

### 1.4 Extension / Skill / Prompt template / Agent 定义机制

- **Extensions**（`docs/extensions.md`，TS 模块经 jiti 免编译加载）：`export default (pi: ExtensionAPI) => {...}`。能力面极大：
  - 事件：完整生命周期（`session_start/shutdown/before_switch/before_fork/before_compact`、`input`、`before_agent_start`、`context`、`before_provider_headers/request`、`after_provider_response`、`tool_call`（可 block）、`tool_result`（可改写）、`model_select`、`project_trust`…）；
  - 注册面：`registerTool / registerCommand / registerShortcut / registerFlag / registerProvider / registerMessageRenderer / registerEntryRenderer / registerMarkdownTransformer`；
  - 运行时控制：`setActiveTools/getAllTools`（0.83+，动态启停工具、重建 system prompt）、`sendMessage/sendUserMessage`、`appendEntry`（会话内持久化扩展状态）、`setModel/setThinkingLevel`、`ctx.compact()`；
  - UI 抽象：`ctx.ui.select/confirm/input/editor/notify/setStatus/setWidget/setTitle` —— 在 TUI 与 RPC 两种模式下同一 API（RPC 模式经 `extension_ui_request/response` 子协议转发给宿主，这正是 Studio webview 审批弹窗的通道）。
  - 发现位置：`~/.pi/agent/extensions/`、`.pi/extensions/`、settings `packages`（npm/git 分发）、CLI `-e/--extension`（可重复）。
- **Skills**（`docs/skills.md`）：实现 [Agent Skills 标准](https://agentskills.io)。`SKILL.md` + YAML frontmatter（`name/description/allowed-tools/disable-model-invocation`），渐进披露（system prompt 只含描述，命中后 agent 自行 `read` 全文），自动注册 `/skill:name` 命令。可直接复用 `~/.claude/skills` 等其他 harness 的技能目录。**运维知识库（runbook）用 skills 承载是官方姿势。**
- **Prompt templates**（`docs/prompt-templates.md`）：`prompts/*.md`，文件名即 `/命令`，支持 `$1/$@/${1:-default}/${@:N:L}` 参数展开。
- **Agent（subagent）定义**：**官方无此概念**。pi-agent-studio 的 subagent 扩展自定义了 `agents/*.md` 格式（frontmatter：`name/description/tools/model` + 正文为 system prompt，见 `bridge/subagent/agents.ts` 的 `AgentConfig`），三级发现：内置 `bridge/agents/` → 用户 `~/.pi/agent/agents/` → 项目 `.pi/agents/`。

### 1.5 MCP：官方故意不内置 —— 对「嵌入 Hub」是机会还是障碍？

官方立场：pi 核心零 MCP，依赖靠扩展生态（Studio 的 `pi-mcp` 就是完整参考实现）。对 at-opsAgent 要把 **AT Hub 内嵌为工具源**而言，这是**明确的机会而非障碍**：

- 机会 1：**没有「先绕开内置 MCP 客户端」的负担**。工具注册面（`pi.registerTool` / SDK `customTools`）是一等公民，Hub 以 `ToolProvider` 身份直接进入 agent loop，和内置 `read/bash` 完全同级，无需 stdio/HTTP 中转、无序列化开销、无子进程生命周期管理。
- 机会 2：Studio 的 `pi-mcp` 证明了**上下文工程可以做在工具层**：`mcp_tool_search`/`mcp_tool_call` 双代理工具 + `directTools` 白名单直通 + 元数据磁盘缓存 + 空闲断连（`idle.ts`）+ `setActiveTools` 动态摘除未用工具省 token。这些模式对「Hub 内几十上百个运维工具」同样适用——**不必把所有 Hub 工具一次性塞进 system prompt**。
- 唯一的「障碍」：若 at-opsAgent 还想同时接**第三方外部 MCP server**（非 Hub），需要自带 MCP 客户端（`@modelcontextprotocol/sdk`）——但 Studio 的 `pi-mcp/src/`（connection/tools/prompts/idle/metadata-cache，共 12 个文件）就是现成的可移植实现。

### 1.6 Sub-agent：官方不内置，扩展怎么做

Studio 的 `bridge/subagent/index.ts`：每次调用 **spawn 一个独立 `pi` 子进程（JSON 模式）**，隔离上下文窗口；支持单任务与并行任务（上限 8 任务/4 并发），逐任务输出上限 50KB，汇总 usage/cost 后以工具结果返回主 agent。agent 画像来自 §1.4 的 `agents/*.md`。要点：**子代理即「递归 pi 进程」**，无共享状态，天然崩溃隔离；代价是每个子代理冷启动一个 Node 进程。SDK 文档也认可另一形态：用 `createAgentSession()` 在**同进程内**起子会话（`SessionManager.inMemory()`），适合轻量并行探查。

### 1.7 SDK（in-process）vs CLI RPC（`pi --mode rpc`）对比

| 维度 | SDK（`createAgentSession` / `createAgentSessionRuntime`） | RPC（`pi --mode rpc`，JSONL over stdio） |
|---|---|---|
| API 表面 | 全量：`prompt/steer/followUp/abort/compact/navigateTree/fork/switchSession/importFromJsonl`、直接读写 `agent.state`、注入 `customTools/resourceLoader/settingsManager/modelRuntime` | 命令集见 `docs/rpc.md`：prompt/steer/follow_up/abort/bash/get_state/get_messages/get_entries(增量游标)/get_tree/set_model/compact/fork/clone/switch_session/set_session_name/get_commands 等；**没有** get_available_models 之外的模型 CRUD、没有 skills/extensions 管理命令 |
| 事件流 | `session.subscribe(AgentSessionEvent)`，类型化、含对象引用 | 同构 JSON 事件（`message_update` 只有 delta，需客户端自行组装 partial；`agent_settled` 表示彻底静止），严格 LF 分帧（不可用 Node readline） |
| 扩展 UI | 直接实现 `ctx.ui` 后端 | `extension_ui_request/response` 子协议（select/confirm/input/editor 阻塞；notify/setStatus/setWidget/setTitle 单向），`ctx.ui.custom()` 等 TUI 专属能力不可用 |
| 类型安全 | 完整 TS 类型 | 需自己 vendor RPC 类型（Studio 把类型抄进 `src/chat/chat-types.ts`） |
| 隔离性 | 与扩展宿主同进程：agent 崩溃/内存暴涨影响 VS Code 扩展宿主 | 进程隔离，崩了只影响一个 panel |
| 性能/资源 | 单进程；SDK 打包体积大（pi-ai 拖 anthropic/openai/google/bedrock SDK） | 每 panel 一个 Node 进程（Studio 实测可接受）；复用全局安装的 pi 二进制 |
| 依赖部署 | npm 依赖随扩展打包，**用户无需安装 pi CLI** | 要求用户全局安装 pi，且存在版本漂移（Studio 需专门探测 pi 路径、做 onboarding 卡片、处理 0.83/0.84 API 差异） |
| 定制深度 | 可换 system prompt、ResourceLoader、CredentialStore、in-memory settings、任意 ToolProvider | 只能经 `--extension/-e` 注入扩展文件 + 环境变量传参（Studio 的做法：8 个 bundled extension + `PI_VSCODE_*` env） |

官方建议（`docs/sdk.md` 末尾）：同为 Node/TS、要类型安全和直接状态访问 → SDK；跨语言/要进程隔离 → RPC。

### 1.8 Session 持久化格式（`docs/session-format.md`）

- JSONL，一行一个 entry；v3 格式为**树结构**（`id`/`parentId`，8 位 hex），支持就地分支（`/tree`）、fork、clone、label。
- Entry 类型：`session`(header) / `message` / `model_change` / `thinking_level_change` / `compaction`（新版含 `retainedTail` 自包含检查点）/ `branch_summary` / `custom`（扩展状态，不进上下文）/ `custom_message`（扩展注入、进上下文）/ `label` / `session_info`。
- 存储：`~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`，`SessionManager` 提供全套树 API（`buildContextEntries/buildSessionContext/branch/fork/...`），并有 `SessionManager.inMemory()`。
- **对运维场景的含义**：会话文件天然就是**审计日志**（含每次工具调用、参数、结果、成本），格式公开可解析；`custom` entry 可存放审批记录/工单号等运维元数据。

### 1.9 Settings（`docs/settings.md`）

`~/.pi/agent/settings.json`（全局）+ `.pi/settings.json`（项目，深合并覆盖）。SDK 侧 `SettingsManager.create()/inMemory()/applyOverrides()`。关键项：`defaultProvider/defaultModel/defaultThinkingLevel`、`compaction.*`、`retry.*`（含 provider 级超时）、`packages/extensions/skills/prompts` 资源路径、`defaultProjectTrust`（**非交互模式默认不信任项目本地扩展**——安全默认值好）、`httpProxy`、`enabledModels`。

---

## 2. pi-agent-studio 扩展架构（最重要）

### 2.1 总体：三件套 + 双进程模型

```
VS Code 扩展宿主 (src/extension.ts → dist/extension.cjs ~24KB 主入口 + 懒加载 chunks)
 ├─ 本地 HTTP bridge (src/bridge/*)：localhost + 每会话 token；
 │    经 PI_VSCODE_BRIDGE_URL/TOKEN/TERMINAL_ID 环境变量注入 pi 进程
 ├─ UI 三形态：
 │    ① terminal TUI：VS Code 终端直接 spawn pi（shellPath=piPath，无 shell 层）
 │    ② webview chat panel：每个 panel 一个 `pi --mode rpc` 子进程（JSONL）
 │    ③ sidebar chat（WebviewView）：每窗口一个后台 RPC 会话，隐藏不杀进程、重挂载全量 re-hydrate
 └─ 8 个 bundled pi extensions（经重复 `--extension` 注入，路径在 src/constants.ts）：
      pi-vscode-bridge.js（vscode_get_diagnostics 工具 + TUI footer 状态）
      todo.ts / questionnaire.ts / btw.ts
      subagent/index.ts（子进程递归 pi，见 §1.6）
      permission-gate.ts（危险命令审批）
      rewind-code.ts（文件级 sha256 快照回滚）
      mcp/index.js（pi-mcp 子包打包产物，MCP SDK 内联）
```

**双轨依赖**是它最独特的架构决策：chat/TUI 走**外部全局安装的 pi CLI**（RPC/终端），而 Settings 面板与 Git commit 生成走**扩展自带打包的 pi SDK**（`^0.84.0`）。带来的问题它自己也承认：全局 CLI 与内嵌 SDK 版本漂移（AGENTS.md 记载 `setActiveTools` “runtime API since 0.83, in the type defs since 0.84”这类兼容注记）、需要 `_resolve.ts` 五级探测 pi 二进制路径、Windows `.cmd/.ps1` shim 特判、缺 pi 时的 onboarding 卡片。**这是 at-opsAgent 不该继承的复杂度**（见 §3）。

### 2.2 三种 UI 如何接 pi

- **Terminal TUI**（默认）：`src/terminal.ts` + `src/pi.ts`，`createTerminal({ shellPath: piPath, shellArgs })` 直接以 pi 为 shell 进程。会话恢复：bundled bridge 在 `session_start` 时回报 `{terminalId → sessionFile}`，存 `workspaceState`，激活时用 `--session <file>` 重启。
- **Webview panel**：`src/chat/chat-panel.ts` → `createChatSession()`（`chat-session.ts`，**核心控制器**）→ `rpc-client.ts` spawn `pi --mode rpc`。`ChatHost` 抽象（`postMessage/onDidReceiveMessage/onDidDispose`）使同一 session 控制器可挂 panel 或 sidebar；`session.attach(host)` 支持 webview 重建后 re-hydrate 全量状态。
- **Sidebar chat**：同一 UI 复用为 WebviewView（`retainContextWhenHidden: true`），先展示 starter 页、点击才 spawn 进程（懒启动、模块级单例去重）。

### 2.3 webview 技术栈与消息协议

- **无框架**：`pi-chat/` 与 `pi-settings/` 是两个独立 Vite 子项目（vanilla TS，singlefile 构建 → 产物 HTML 以 `?raw` 内联进扩展），mermaid + KaTeX 渲染、`@lobehub/icons` 提取模型图标、手工维护的 codicon 子集。
- **协议**：webview ↔ 扩展宿主是自定义 postMessage 消息集（`chat-session.ts` 大 switch：prompt/abort/setModel/setThinking/fork/revert/dialogResponse/mcpOpen/mcpAction/setPermission/rewind\*…）；扩展宿主 ↔ pi 是 RPC JSONL。**pi 扩展 UI 请求被翻译为 webview 组件**：`select/confirm/input/editor → dialog`、`setWidget → todo/rewind 卡片`、`notify → toast`（`__mcp_status__` 前缀的 notify 被截获转为 MCP 抽屉数据——一个用 notify 通道夹带结构化状态的 hack）。
- 构建链：rolldown（扩展宿主，代码分裂 + 懒加载保证激活 ~24KB）、oxlint/oxfmt、tsgo（TS Native Preview）。

### 2.4 自定义 LLM：models.json / OAuth / API key

全部**直接读写 pi 的配置文件**（`~/.pi/agent/models.json`、`auth.json`），不搞私有格式：
- `src/models/models-config.ts`：Providers CRUD（含 per-model api/baseUrl 覆盖、compat 字段、cost 分层、thinkingLevelMap、header 的 env/command 占位符）；
- `src/models/oauth-flow.ts`：调 SDK `ModelRuntime` + `registerBunOAuthFlows`（`@earendil-works/pi-ai/bun-oauth`）驱动 provider 自有 OAuth 流，`onAuth/onPrompt/onManualCodeInput` 共享 memoized 手动输入 promise；**凭证由 `AuthStorage.login()` 自己落盘，宿主绝不代写**（AGENTS.md 明确此坑）；
- `src/models/auth-config.ts`：API key 状态列举/增删（`ModelRuntime/ModelRegistry`）。

### 2.5 自定义 MCP（pi-mcp 子包，≈12 个模块）

- 配置：`~/.pi/agent/mcp.json`（user）+ `.pi/mcp.json`（project，同名整体覆盖），`ServerEntry = {command,args,env,cwd | url,headers,bearerToken, disabled, directTools}`（`src/mcp/mcp-config.ts`）。
- 连接：`connection.ts` stdio 或 StreamableHTTP→SSE 降级；`session_start` 非阻塞并发连接；`session_shutdown` 全部断开。
- 工具暴露双模式：`directTools` 白名单注册为 `mcp__<server>__<tool>` 直通工具（inputSchema 经 `Type.Unsafe` 包装）；其余走 `mcp_tool_search`（关键词排名 `search-ranking.ts`）+ `mcp_tool_call` 两个代理工具，**避免工具定义撑爆 system prompt**。
- 生命周期优化：`metadata-cache.ts` 磁盘缓存元数据（断连后 search 仍可用）、`idle.ts` 空闲 N 分钟断连、`/mcp` 命令 + 聊天工具栏抽屉做运行时 start/stop/reconnect、stop 时经 `pi.setActiveTools()` 摘除工具省 token、`registeredToolNames` 精确记账避免前缀猜测。
- prompts：MCP prompt → `/mcp__<server>__<prompt>` 斜杠命令，结果经 `sendUserMessage` 注入。

### 2.6 Skills / Agents / Prompt templates 的 Settings UI

`pi-settings/` 七个 tab（懒加载 `tabLoad → buildTabData → tabData`）：Models（三子 tab）/ Agents / Prompt Templates / Skills / MCP Servers / Commit Message / Settings（system prompt Append→`APPEND_SYSTEM.md`、Override→`SYSTEM.md` + 内联 settings.json 编辑器）。列举用 SDK `DefaultResourceLoader`（带 `noX` 开关按 tab 过滤），写入是直接文件 I/O（`skills-config.ts/prompts-config.ts/agents-config.ts`，`parseFrontmatter` 来自 SDK 导出）。

### 2.7 权限门（dangerous command approval）

`bridge/permission-gate.ts`（≈95 行）：`pi.on("tool_call")` 拦 `bash`，命中 `PI_VSCODE_PERMISSION` 环境变量注入的正则集（默认 40+ 条：rm -rf/sudo/dd/drop table/kill -9/curl|sh/git push -f…，模式约定「选项 flag 必须锚定空白 `\s+-xxx`」防止 `chat-panel` 这类词内误报）→ `ctx.ui.select("Allow"/"Block")`；无 UI 时直接 block。模式 `AskForApproval | FullAccess`，`/permission` 会话内切换。TUI 与 webview 共用同一份扩展代码（webview 侧经 extension-UI 子协议弹 dialog）。**结构上非常简单，说明 pi 的 `tool_call` 钩子承载审批门是充分的；at-opsAgent 只需换规则源（如按工具/环境/资产分级审批）**。

### 2.8 进程模型：性能与崩溃隔离

- 每个 webview panel 一个 `pi --mode rpc` 子进程；sidebar 每窗口一个。panel 关闭即杀进程（Windows `taskkill /T /F`）。
- 隔离收益真实：RPC 子进程 OOM/崩溃不影响扩展宿主，`onExit` 处理器可提示重启；`rpcTrace` 输出通道可观测全部 JSONL 流量。
- 成本：N 个 panel = N 个 Node 进程 + N 份模型目录/扩展加载；启动时 8 个 `--extension` 都要 jiti 编译。Studio 用「懒启动 + 会话复用 + 激活 24KB 主包」缓解，实际体验可接受。

### 2.9 模块复用性评估（为运维场景）

| 模块 | 复用建议 |
|---|---|
| `pi-mcp/src/*`（MCP 客户端 + search/call 代理 + idle + 缓存） | **可直接移植**（vendoring，MIT）。若 at-opsAgent 需接第三方 MCP server 这是现成实现；仅接内嵌 Hub 则不需要 |
| `bridge/permission-gate.ts` 模式 | **借鉴重写**：钩子接法照抄，规则引擎按运维分级审批重做 |
| `bridge/subagent/*`（agents.md 格式 + 并行调度） | **借鉴**：`AgentConfig` frontmatter 格式值得沿用；执行器建议改为 SDK in-process 子会话而非子进程 pi |
| `src/models/*`（models.json/auth/OAuth 配置层） | **可直接移植**：纯 SDK 调用 + 文件 I/O，与 UI 解耦 |
| `src/chat/rpc-client.ts` + `chat-types.ts` | 仅当选 RPC 路线才需要；SDK 路线不用 |
| `src/chat/chat-session.ts`（会话控制器 + ChatHost 抽象） | **模式借鉴**：host 抽象、re-hydrate、dialog 转发协议设计好；但它绑定 RPC 命令集，SDK 路线需重写 |
| `pi-chat/`（聊天 webview UI） | **必须为运维重写**：它是通用 coding chat（diff/rewind/todo 中心），运维需要告警上下文卡片、拓扑/指标嵌入、审批流 UI、变更单关联等完全不同的信息架构。可保留 mermaid/KaTeX/流式渲染等底层件 |
| `pi-settings/`（设置面板） | **部分复用**：Models/OAuth/API Keys 三个 tab 几乎原样可用；MCP tab 改为 Hub 连接配置；Skills/Prompts tab 可保留 |
| `src/bridge/*`（VS Code HTTP bridge：diagnostics/symbols/definitions/...） | 运维 agent 对 LSP 数据需求低，**大部分不需要**；保留 diagnostics + 通知即可。若走 SDK in-process，bridge 整个可以删（同进程直接调 `vscode` API，无需 HTTP+token） |
| `rewind-code.ts` / `todo.ts` / `btw.ts` / `questionnaire.ts` | rewind 对运维意义不大（改的是目标系统不是本地文件）；todo/questionnaire 可选保留 |
| i18n 三层机制、`_resolve.ts` pi 路径探测、onboarding | SDK 路线下 `_resolve.ts`/onboarding **整个不需要**（不依赖外部 CLI）；i18n 机制可借鉴 |

---

## 2A. vspi 对照（简要）

`LightningBerk/vspi`：单 sidebar webview + 每会话 `pi --mode rpc` 子进程（esbuild 双目标，marked+DOMPurify 渲染），亮点是 IDE 反馈环（编辑后自动收集新增 diagnostics 喂回 pi、diff 预览 accept/revert、活动文件上下文注入）。但它仍指向已弃用的 `@mariozechner/*` 包、无 settings/models UI、无 MCP、无 subagent。价值：验证了「最小 RPC 封装」约几千行可行；其 diagnostics-feedback-loop 思路值得吸收进运维场景（执行动作后自动采集验证信号回喂）。

---

## 3. 路线对比与推荐

### 候选路线

**A. Fork pi-agent-studio**，改 MCP 为嵌入 AT Hub、换运维 UI/skills
- ✅ 起步最快：settings/models/OAuth/权限门/会话管理全都有。
- ❌ 继承双轨依赖（外部 pi CLI + 内嵌 SDK）与全部伴生复杂度：二进制探测、版本漂移、onboarding、Windows shim；而 at-opsAgent 的目标用户（运维工程师）比开发者更不能接受「先全局装 pi CLI」的前置条件。
- ❌ Studio 是个人项目（fork of pithings/pi-vscode），迭代激进（AGENTS.md 显示大量内部约定），长期跟踪 upstream 合并成本高；其 pi-chat UI 与运维信息架构差异大，「换 UI」实际等于重写它体量最大的部分。
- ❌ 品牌/发布面（publisher、marketplace 元数据、l10n、图标字体流水线）都要剥离。

**B. 只用 pi SDK（`@earendil-works/pi-ai` + `pi-agent-core` + `pi-coding-agent` 的 SDK 面）自建 VS Code 扩展，Hub 作为 ToolProvider**
- ✅ 单进程、单依赖轨：`npm install` 即完整运行时，用户零前置安装；Hub 工具经 `customTools`/`pi.registerTool` 一等注入，无 IPC。
- ✅ SDK 表面覆盖全部需求（§1.7 左列）：自定义 system prompt（ResourceLoader override）、内存/自定义路径的 settings 与凭证、会话树持久化、compaction、steering。
- ✅ 崩溃隔离可用「重活下沉 subagent 子进程」补足（关键运维长任务再 spawn，交互主链路留在进程内）。
- ❌ settings UI、OAuth 流、权限门、chat 渲染都要自己写——但 §2.9 表明其中一半可从 Studio 直接搬。

**C. 自研 Agent loop，只借鉴 provider/session 思想**
- ❌ 明确不推荐。pi-agent-core 的 loop（steering/followUp 队列、并行工具执行、before/after 钩子、错误编码进流的契约、7 级 thinking、跨 provider handoff 测试矩阵）是数年打磨的成果；pi-ai 的 compat 矩阵（qwen/deepseek/zai/vLLM/llama.cpp 的 thinking 格式差异等）重写等于重踩全部坑。MIT + npm 稳定发布，无自研理由。

**D. 混合：Studio 的 settings/LLM 配置 + 自研运维 UI + in-process Hub**
- 即 B 的实施策略化版本：以 B 为骨架，把 Studio 中与 UI 弱耦合、与 pi 配置文件强对齐的模块（models/auth/OAuth 配置层、settings 面板的 Models 三 tab、permission-gate 钩子模式、subagent 的 agents.md 格式、必要时 pi-mcp）**按文件移植（vendoring）**，运维主 UI 全新开发。

### ✅ 推荐：路线 D（= B 骨架 + 选择性移植 Studio 模块）

**架构图（目标态）：**

```
at-opsAgent (VS Code extension, 单进程 in-process)
├─ 运行时：@earendil-works/pi-coding-agent SDK
│    createAgentSession({
│      customTools: [ ...HubToolProvider.tools() ],   ← AT Hub 内嵌，一等工具
│      resourceLoader: OpsResourceLoader,             ← 运维 system prompt / runbook skills / 运维 prompt 模板
│      settingsManager: SettingsManager.create(...),
│      modelRuntime: ModelRuntime.create({ credentials: VscodeSecretCredentialStore }),
│      sessionManager: SessionManager.create(cwd)     ← JSONL 会话树 = 审计日志
│    })
├─ 权限门：pi.on("tool_call") → 运维分级审批（借鉴 permission-gate 钩子模式，规则引擎重写）
├─ Sub-agent：agents/*.md 画像（沿用 Studio frontmatter 格式）+ SDK in-process 子会话执行器；
│             长任务/高危任务可选 spawn 隔离子进程
├─ UI：自研运维 webview（告警上下文、审批卡片、执行时间线）；
│      Settings 面板 Models/OAuth/API-Keys tab 从 pi-settings 移植
└─ （可选）第三方 MCP：vendoring pi-mcp 的 connection/tools/idle/metadata-cache
```

**不该 fork Studio 的理由（汇总）：**
1. 双轨依赖（外部 CLI + 内嵌 SDK）对运维用户是净负担，而这恰是 Studio 代码中最难剥离的横切关注点（terminal.ts/pi.ts/_resolve.ts/upgrade.ts/onboarding/会话恢复全绕它转）。
2. 其体量最大的资产 pi-chat UI 正是运维场景必须重写的部分；剩余可复用模块以「搬文件」方式获取比背整个 fork 便宜得多。
3. 个人项目 + 激进迭代 + 已是二级 fork，upstream 追踪成本与治理风险不匹配企业产品诉求。
4. Studio 的 MCP 桥、bridge HTTP 层、TUI 支持都是为「通用 coding agent 宿主」服务的；at-opsAgent 的 Hub 是 in-process 的，整个 HTTP bridge + env-token 注入机制可以归零。

**依赖许可证风险：** 全链 MIT（pi 各包、Studio、vspi、`@modelcontextprotocol/sdk` 亦为 MIT）。义务仅为保留版权与许可声明：vendoring Studio 文件时在文件头/NOTICE 保留 `Copyright (c) 2025 Johnny Zhao (MIT)`，打包 pi SDK 时随 vsix 附带其 LICENSE。无 copyleft 传染、无商用限制。需要注意的是 pi-ai 会拉入 `@anthropic-ai/sdk`、`openai`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`（均 MIT/Apache-2.0），vsix 体积会明显增大——用 bundler externalize + tree-shake，必要时把 bedrock 分包（pi-ai 已有 `./bedrock-provider` 独立导出）。

**版本锁定策略：**
- pi 全家桶 lockstep 同版本（0.84.x），**必须三包同号精确锁定**（`0.84.3`，不用 `^`），跟随 pi 自身「直接依赖 pin 精确版本」的纪律；升级作为整体事务（三包一起升 + 跑回归）。
- pi 0.x 阶段 minor 会破坏 API（实证：`message_update` 移除 cumulative message 字段、`hookMessage`→`custom` 会话 v3 迁移、`setActiveTools` 0.83 运行时/0.84 类型的错位）。建议：锁定 + 每 2~4 个 minor 评估一次升级，重点盯 `packages/coding-agent/CHANGELOG.md` 的 session-format 与 ExtensionAPI 条目。
- 会话格式向后兼容有官方保证（v1/v2 自动迁移到 v3），审计日志可长期持有。
- 若未来需要脱离 upstream 节奏，SDK 面（§4 清单）足够窄，可整体 vendoring `packages/agent` + 关键 `coding-agent/src/core` 文件作为最后手段——MIT 允许。

---

## 4. 可复用接口清单

### 4.1 建议直接 npm 依赖（精确锁版，三包同号）

| 包 | 用途 | 关键导出 |
|---|---|---|
| `@earendil-works/pi-coding-agent`（0.84.3） | 主 SDK | `createAgentSession` / `createAgentSessionRuntime` / `AgentSession` / `SessionManager` / `SettingsManager` / `ModelRuntime` / `DefaultResourceLoader` / `defineTool` / `createCodingTools`、`createReadOnlyTools`、单工具工厂 `createBashTool` 等 / `parseFrontmatter` / `getAgentDir` / 类型 `ExtensionAPI`、`Skill`、`PromptTemplate`、`ToolDefinition` |
| `@earendil-works/pi-agent-core`（0.84.3） | 低层 loop（若需绕过 AgentSession 自组 pipeline）| `agentLoop` / `agentLoopContinue` / `AgentTool` / `AgentEvent` / `AgentLoopConfig`（beforeToolCall/afterToolCall/transformContext/getSteeringMessages…）|
| `@earendil-works/pi-ai`（0.84.3） | provider 层 | `getModel` / `streamSimple` / `Model`、`Context`、`Message` 类型 / `InMemoryCredentialStore`（自定义 CredentialStore 接口对接 VS Code SecretStorage）/ `createProvider`、`openAICompletionsApi` / `/oauth`、`/bun-oauth` 子导出 |
| `typebox`（1.3.7，跟 pi 锁同版） | Hub 工具 schema | `Type.Object/String/...`、`Type.Unsafe`（包装 Hub/MCP 的 JSON Schema） |
| （可选）`@modelcontextprotocol/sdk` | 仅当支持第三方外部 MCP server | Client + stdio/StreamableHTTP transport（Studio 的打包方式：内联进产物，externalize `@earendil-works/*` 与 typebox） |

**不建议依赖**：`@earendil-works/pi-tui`（纯终端渲染）、`pi-client`/`pi-protocol`/`pi-server`（pi 自身 C/S 拆分用，文档未承诺稳定）、pi CLI 二进制（SDK 路线下不需要用户安装）。

### 4.2 需要 vendoring 的协议/格式（对齐 pi 生态但不引运行时依赖）

| 协议/格式 | 来源 | 用途 |
|---|---|---|
| 会话 JSONL v3 entry 格式（树、compaction retainedTail、custom/custom_message） | `pi/packages/coding-agent/docs/session-format.md` | 审计导出/外部分析器解析会话；SDK 内已实现读写，vendoring 的是**格式知识**（写解析器时对照） |
| `models.json` / `auth.json` / `settings.json` / `mcp.json` schema | `docs/models.md`、`docs/settings.md`、Studio `src/mcp/mcp-config.ts` 的 `ServerEntry` | 与用户既有 pi 配置互操作（可选：at-opsAgent 也可改用独立 `agentDir` 完全自管） |
| Agent Skills 标准（SKILL.md frontmatter） | `docs/skills.md` / agentskills.io | 运维 runbook 技能库格式，兼容 Claude Code/Codex 技能目录 |
| Prompt template 参数展开语法（`$1/$@/${1:-d}/${@:N:L}`） | `docs/prompt-templates.md` | 运维快捷指令 |
| subagent `agents/*.md` frontmatter（name/description/tools/model + body=system prompt） | Studio `bridge/subagent/agents.ts` | 运维子代理画像（值班分析员/变更执行员/巡检员…） |
| （仅 RPC 备选路线）RPC 命令/事件/extension-UI 子协议类型 | `docs/rpc.md` + Studio `src/chat/chat-types.ts` | 若未来要进程隔离形态，类型需自己 vendor |
| Studio 可搬模块源码（MIT，保留版权头）：`src/models/{models-config,auth-config,oauth-flow}.ts`、`bridge/permission-gate.ts`（模式）、`pi-mcp/src/*`（可选）、`pi-settings` Models 三 tab | pi-agent-studio | 见 §2.9 |

### 4.3 必须重写（运维场景专属）

1. **聊天/工作台 webview**：告警上下文卡片、资产/拓扑引用、执行计划预览、审批流 UI、操作时间线与回执——信息架构与 coding chat 完全不同（技术底座可沿用 Vite + vanilla TS + 流式渲染 + mermaid/KaTeX 的做法）。
2. **权限/审批引擎**：从「正则匹配 bash 命令」升级为「按 Hub 工具元数据（读/写/破坏性）、目标环境（prod/staging）、资产标签分级审批 + 审批记录写入会话 custom entry」；钩子仍用 `tool_call`/`beforeToolCall`。
3. **HubToolProvider**：AT Hub 能力 → `AgentTool[]` 适配层（schema 经 typebox `Type.Unsafe` 包装、`onUpdate` 透传长任务进度、`executionMode: "sequential"` 标注互斥操作），并借鉴 pi-mcp 的 search/call 代理 + `setActiveTools` 动态裁剪应对大工具集。
4. **运维 system prompt / ResourceLoader**：`systemPromptOverride` + runbook skills 目录 + 运维 prompt 模板集；`agentsFilesOverride` 注入环境上下文（当前集群、变更窗口等）。
5. **子代理执行器**：agents.md 画像加载沿用 Studio 格式，执行改为 SDK in-process 子会话（`SessionManager.inMemory()` + 限定 `tools`），高危/长任务可选子进程隔离。

---

## 附：本文引用的关键路径索引

- pi-mono：`packages/agent/src/{agent-loop.ts,types.ts}`；`packages/ai/src/{types.ts,models.ts,oauth.ts,api/*}`；`packages/coding-agent/docs/{sdk.md,rpc.md,sessions.md,session-format.md,settings.md,extensions.md,skills.md,prompt-templates.md,models.md,custom-provider.md,packages.md}`
- pi-agent-studio：`AGENTS.md`（架构总纲）；`src/extension.ts`、`src/pi.ts`、`src/terminal.ts`、`src/_resolve.ts`；`src/chat/{chat-session.ts,rpc-client.ts,chat-types.ts}`；`src/models/{models-config,auth-config,oauth-flow}.ts`；`src/mcp/mcp-config.ts`；`bridge/{permission-gate.ts,subagent/index.ts,subagent/agents.ts,rewind-code.ts}`；`pi-mcp/src/{index,connection,tools,proxy-tools,idle,metadata-cache}.ts`；`pi-settings/src/tabs/*`
- vspi：`README.md`、`docs/CODEMAP.md`
- npm 验证：`@mariozechner/pi-coding-agent`（deprecated → earendil-works）、`@earendil-works/{pi-coding-agent,pi-ai,pi-agent-core,pi-tui}` 均 0.84.3 / MIT
