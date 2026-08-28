# 05 — 外部技术全景调研：at-opsAgent（VS Code 运维 Agent 插件）

> 调研日期：2026-08-28。方法：官方文档 + 开源仓库源码 + 第三方架构分析交叉验证；本地交叉验证材料：`/tmp/research/pi-agent-studio`（含 pi-mcp 代理工具实现）、`/tmp/research/at-series-mcp-hub`（Hub v1/v2 协议）。
> 结论均标注来源 URL；单一来源且未能交叉验证的信息已注明「未交叉验证」。

## 总览：给 at-opsAgent 的十条核心结论

| # | 结论 | 建议 |
|---|------|------|
| 1 | Chat Participant / LM Tools / LM API 都寄生于 Copilot Chat 生态，无法控制 agent mode 系统提示词，且在 Cursor 中不可用 | **不采用**为主 UI；可选做一个薄的 Chat Participant 作为 Copilot 用户的入口 |
| 2 | 自建 WebviewView 侧边栏 + 自定义 LLM 是 Continue / Cline / pi-agent-studio 的共同选择，也是唯一同时兼容 VS Code 与 Cursor 的路线 | **采用** |
| 3 | Agent loop 放扩展进程内（Continue VS Code 模式），但用「类型化消息协议」隔离 core 与宿主（Cline ProtoBus 思想），为将来抽独立进程留后路 | **采用**（协议先行，不上 gRPC codegen） |
| 4 | 进程内嵌入 MCP 用 TS SDK 的 `InMemoryTransport.createLinkedPair()`，对外仍保留 stdio 入口 | **采用** |
| 5 | 大量工具撑爆 context 已是行业共识问题（Cursor 约 40 个工具上限、Claude Code >10K token 自动 defer）；渐进发现（search → get → select/call）是标准答案，AT Hub v2 的 `at_search_tools` 方向正确 | **采用**（坚持渐进发现，默认阈值化） |
| 6 | thinking/reasoning 流式协议各家不同（`reasoning_content` / `reasoning` / `thinking` / Anthropic thinking 块 + signature），必须做归一化适配层 | **采用**（自建 provider 适配层） |
| 7 | 长会话靠分层 compaction：cache 友好的工具结果裁剪 → 全量摘要 → `prompt_too_long` 兜底重试（Claude Code 五层模型） | **采用**（先做两层：工具结果裁剪 + 摘要） |
| 8 | 运维事故并行调查映射为 orchestrator-worker：主 Agent 只编排与综合，日志/指标/变更/主机各一个只读子代理 | **采用**（agents-as-tools 模式，不用 handoff） |
| 9 | 子代理隔离四件套：工具白名单、独立上下文、maxTurns/超时、可取消——Claude Code subagents 已给出成熟字段设计 | **采用**（照此设计我们的子代理 schema） |
| 10 | 扩展 exports API 做插件间通信是官方机制，但仅限同一 extension host、类型要靠独立 npm 类型包；proposed API 不能随市场发布 | **有条件采用**（exports 用于能力插件热注册握手；不依赖 proposed API） |

---

## 1. VS Code 扩展 Agent 形态

### 1.1 Chat Participant / Language Model Tools / Language Model API

VS Code 官方给扩展作者三条 AI 集成路径（[AI Extensibility Overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)）：

| 路径 | 注册方式 | 触发方式 | 控制权 | 关键限制 |
|------|----------|----------|--------|----------|
| Chat Participant | `vscode.chat.createChatParticipant` + `package.json` 的 `contributes.chatParticipants` | 用户 `@participant` 显式调用 | 端到端控制本轮对话（系统提示、历史格式化、流式响应） | 只活在 Copilot Chat 视图里；agent mode 下不会被自动调用 |
| Language Model Tool | `vscode.lm.registerTool` + `contributes.languageModelTools` | agent mode 由模型自动调用，或用户 `#tool` 引用 | 只控制单个工具的执行 | 无法控制 agent mode 的系统提示词 |
| Language Model API | `request.model` / `vscode.lm.selectChatModels` | 扩展代码内直接调用 | 拿到模型句柄自由使用 | 模型由 Copilot 提供、用户配额计费 |

来源：[Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)、[chat-sample](https://github.com/microsoft/vscode-extension-samples/blob/main/chat-sample/README.md)、[vogella: Extending Copilot in VS Code](https://vogella.com/blog/vscode_copilot_extension/)。

对我们最致命的两点，EclipseSource 2026-03 的分析（[Domain-specific AI Extensions in VS Code](https://eclipsesource.com/blogs/2026/03/19/domain-specific-ai-extensions-vs-code/)）说得很直白：

1. **Agent mode 无系统提示控制权**：扩展作者不能覆盖/追加 Copilot agent mode 的总体系统消息，也不能替用户发布自定义 mode。运维 Agent 需要严格的 persona、审批流与运维规范注入，这条路走不通。
2. **跨编辑器不可用**：这套 API 是 VS Code + Copilot 专属。Cursor 是 VS Code fork，自带 Agent 体系，不提供 Copilot Chat 的 participant/LM API 生态。要「VS Code / Cursor 双兼容」，只能像 Continue 一样自建聊天 UI。

**建议：不采用** Chat Participant / LM Tools 作为主形态。**可选低成本兼容**：后期用一个薄 Chat Participant（`@atops`）把请求转发到我们自己的 agent core，服务 Copilot 重度用户；用 `vscode.lm.registerTool` 把 1-2 个只读运维工具（如「查告警」）暴露给 Copilot agent mode 引流。

### 1.2 WebviewView 侧边栏：最佳实践与性能坑

来源：[Webview API 官方指南](https://code.visualstudio.com/api/extension-guides/webview)（[vscode-docs 源文件](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/webview.md)）。

- **状态恢复**：webview 内容在视图移入后台时会被销毁，最佳实践是**webview 无状态化**——真实会话状态放扩展侧，webview 只渲染；`getState`/`setState` 保存轻量 UI 状态（滚动位置、草稿），官方明确说它比 `retainContextWhenHidden` 开销低得多。
- **`retainContextWhenHidden` 是高内存开销选项**，官方建议仅在状态无法快速保存/恢复时使用；且它是 `WebviewPanel` 的选项，侧边栏 `WebviewView` 被折叠/隐藏后照样可能被销毁并重新 `resolveWebviewView`。交叉验证：pi-agent-studio 的侧边栏聊天实现就是「后台会话活在扩展进程 + 视图 re-resolve 后全量状态再水化」（[pi-agent-studio README](https://github.com/JohnnyZ93/pi-agent-studio)，本地 `/tmp/research/pi-agent-studio/README.md`）。
- **消息大小**：`postMessage` 只支持 JSON 可序列化数据，无官方硬上限，但大 payload 走 RPC 序列化会卡扩展主机；二进制走 `Uint8Array` 曾有参数数量上限 bug，后由 `SerializableObjectWithBuffers` 修复（[microsoft/vscode#137757](https://github.com/microsoft/vscode/issues/137757)）。启示：**流式 token 增量要合批**（见 §6），大文件/日志别整段 post，走分页或落盘后传 URI。
- **CSP 必须配置**：缺失 CSP 会触发 VS Code 内部警告（`$onMissingCsp`，见 [extHostWebview.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostWebview.ts)）。标准姿势：`default-src 'none'` + nonce 脚本白名单 + `asWebviewUri` 加载本地资源。
- **`localResourceRoots`** 限制 webview 可读的本地目录，运维插件涉及敏感文件，必须收紧。

**建议：采用** WebviewView 侧边栏 + 无状态 webview + 扩展侧会话真源；**不采用** `retainContextWhenHidden` 兜底一切的做法。

### 1.3 扩展 exports / proposed API 做插件间通信

- 官方机制：扩展在 `activate()` 返回 API 对象，消费方声明 `extensionDependencies` 后用 `vscode.extensions.getExtension('publisher.name').exports` 获取（[VS Code API — extensions 命名空间](https://code.visualstudio.com/api/references/vscode-api#extensions)）。
- **类型安全靠自己**：`exports` 是弱类型，社区共识是发布独立 npm 类型包（`@at-series/opsagent-api` 之类），消费方 cast（[StackOverflow 讨论](https://stackoverflow.com/questions/62472683/how-to-provide-types-for-vs-code-extension-exported-api)）。
- **限制：exports 不跨 extension host**。远程/Web 场景下不同 host 的扩展拿不到彼此 exports；官方为此留了 proposed API `extensionsAny`（[vscode#145307](https://github.com/microsoft/vscode/issues/145307)、[vscode.proposed.extensionsAny.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.extensionsAny.d.ts)），但 **proposed API 只能在开发/Insiders 使用，不能随 Marketplace 正式发布**。
- 交叉验证：AT Series 现行方案（Bridge 文件注册表 `~/.at-series/bridges/*.json` + 本地 HTTP，Hub 聚合，见本地 `/tmp/research/at-series-mcp-hub/README.md` 与 `docs/protocol/v1.md`）天然绕开了 exports 的同 host 限制，还顺带兼容「能力插件跑在别的宿主 App」的场景。

**建议**：
- **采用** exports 作为**同 host 快速路径**：能力插件 `activate()` 返回 `registerWithHub(hub)` 握手接口，at-opsAgent 主插件充当 host 聚合器，得到进程内零拷贝调用。
- **保留** Bridge 文件注册表 + HTTP 作为**通用路径**（跨 host、跨 IDE、外部 MCP client 复用）。两条路径共用同一套工具契约（Bridge v1）。
- **不采用** proposed API（不可发布），**不采用**自造全局单例（如往 `globalThis` 挂对象——不同扩展是隔离的 module 环境，不可靠）。

### 1.4 SecretStorage、globalState vs 文件系统配置

官方给了五种存储（[Common Capabilities — Data Storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage)）：`workspaceState` / `globalState`（可 `setKeysForSync` 同步）/ `globalStorageUri`（大文件目录）/ `storageUri`（工作区目录）/ `secrets`。

- **凭据一律 `context.secrets`（SecretStorage）**：1.80 起底层从 keytar 换成 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux 系统 keyring），keytar 已归档弃用（[vscode#185677](https://github.com/microsoft/vscode/issues/185677)、[Keytar Migration Plan](https://github.com/microsoft/vscode-discussions/discussions/662)）。注意：secrets **不跨机同步**；且它防的是磁盘明文，不防同一 VS Code 实例里的其他扩展。
- **globalState 是明文存储**，放 API key 属安全事故（交叉验证：[Secure VS Code Extension Development Guide](https://safeguard.sh/resources/blog/vscode-extension-security-development-guide)）。适合放 UI 偏好、已读标记等。
- **文件系统配置**适合「用户要手改/进版本库/跨工具共享」的东西。同类产品实践：Continue 用 `~/.continue/config.yaml`，pi 用 `~/.pi/agent/*.json`（pi-agent-studio 设置面板直接读写这些文件），MCP 生态惯例是 `~/.cursor/mcp.json`、`.cursor/mcp.json`（[Cursor MCP 文档](https://cursor.com/docs/mcp)）。

**建议**：LLM API key / JumpServer 凭据 → SecretStorage；Agent/子代理/技能定义、MCP server 清单 → 文件系统（`~/.at-series/` + 项目级覆盖），便于审阅与团队共享；会话历史 → `globalStorageUri` 下 JSONL（见 §6）；杂项 UI 状态 → `globalState`。

---

## 2. 同类产品架构对比

### 2.1 对比总表

| 产品 | 进程模型 | 工具注册 | MCP 支持 | 自定义模型 | UI |
|------|----------|----------|----------|-----------|-----|
| **Continue** | Core 在 VS Code 扩展**进程内**（`InProcessMessenger`）；JetBrains 下同一 Core 打包成独立 Node 二进制，stdio/TCP JSON 通信 | Core 内置工具 + config.yaml 声明 | 客户端连接外部 MCP server | 40+ provider 抽象层（`ILLM`/`BaseLLM`） | React GUI（webview），Redux |
| **Cline** | Core 与宿主解耦：webview↔core 走 **ProtoBus（gRPC-over-postMessage，protobuf 定义）**；core↔宿主走 **HostBridge**；同一 core 可 standalone/CLI | Core 内置工具集（读写文件/终端/浏览器） | McpHub 连接外部 server + **MCP marketplace** | 多 provider；对弱工具调用模型有 prompt 兜底 | React webview，Plan/Act 双模式 |
| **Roo Code** | 同 Cline（fork），扩展进程内 loop | 内置工具 + 实验性 custom tools；**per-mode 工具白名单 + 文件 glob 限制** | 外部 server；曾因工具过多加「过多 MCP 工具告警」（[PR #10772](https://github.com/RooCodeInc/Roo-Code/blob/main/CHANGELOG.md)）并把 MCP 服务器清单移出系统提示（PR #10895） | 多 provider，**per-mode 模型路由** | React webview，多模式（Code/Architect/Ask/Debug/Orchestrator/自定义） |
| **Copilot Chat**（[开源](https://github.com/microsoft/vscode-copilot-chat)） | 扩展进程内 loop（`toolCallingLoop.ts`），分 platform/extension 两层 + node/web worker 双 runtime | `package.json` 声明 schema + `vscode.LanguageModelTool`/`ICopilotTool` 实现 | VS Code 核心内置 MCP client，工具进 agent mode | 锁定 Copilot 服务端模型 | VS Code 原生 Chat 视图（非 webview） |
| **Cursor** | 闭源；Agent 内置于 fork 的 workbench | 内置工具 + MCP | `mcp.json`（stdio/SSE/Streamable HTTP），**约 40 个活跃工具上限，超出静默丢弃**（[docs](https://cursor.com/docs/mcp)、[第三方验证](https://agenticmarket.dev/blog/mcp-server-connected-agent-ignores-tools)） | 自家模型 + API key 接入 | 原生 UI |
| **Claude Code VS Code 扩展** | **子进程模型**：扩展 spawn 捆绑的 native CLI 二进制，双向 stream-json（Agent SDK 协议）；扩展内跑一个 `ide` MCP server 给 CLI 回连（diff/诊断/notebook） | CLI 内置工具 + subagents | CLI 侧 `claude mcp add`；扩展面板路径曾有 stdio MCP 被环境变量抑制的 bug（[claude-code#86871](https://github.com/anthropics/claude-code/issues/86871)） | 锁定 Anthropic | webview 面板 + 终端两种形态（[形态对比](https://continuumcode.ai/guides/claude-code-vscode/)、[逆向分析](https://github.com/hoveychen/cc-adapter/blob/main/docs/reverse-engineering.md)） |
| **pi-agent-studio**（本地仓库交叉验证） | 双形态：默认 pi CLI 直接跑在集成终端 PTY；webview 聊天时每面板 spawn 一个 `pi --mode rpc` 子进程 | pi 扩展机制（bundled extensions：todo/subagent/rewind-code） | **pi-mcp 代理工具模式**：`mcp_tool_search` / `mcp_tool_call` 两个稳定工具代理全部 server，含元数据磁盘缓存、空闲断连、搜索排序（本地 `/tmp/research/pi-agent-studio/pi-mcp/src/{proxy-tools,metadata-cache,idle,search-ranking}.ts`） | `~/.pi/agent/models.json`：per-model 协议/baseURL/头/思考档位 | 终端 TUI + webview 聊天 + WebviewView 侧边栏三态 |

Continue 架构来源：[DeepWiki: Continue Architecture](https://deepwiki.com/continuedev/continue/2-architecture)、[VsCodeMessenger.ts](https://github.com/continuedev/continue/blob/main/extensions/vscode/src/extension/VsCodeMessenger.ts)、[Core Process Communication](https://deepwiki.com/continuedev/continue/7.2-core-process-communication)。
Cline 架构来源：[DeepWiki: Cline Extension Architecture](https://deepwiki.com/cline/cline/2-extension-architecture)、[PROTOBUS PR #2830](https://github.com/cline/cline/pull/2830)、[HostBridge PR #3747](https://github.com/cline/cline/pull/3747)、[MartianLee 架构分析](https://martianlee.github.io/posts/2026-06-30-cline-architecture)。
Copilot Chat 来源：[CONTRIBUTING.md（Agent mode / Tools 章节）](https://github.com/microsoft/vscode-copilot-chat/blob/main/CONTRIBUTING.md)。
Roo 与 Cline 差异来源：[Pickuma 对比](https://pickuma.com/for-dev/cline-vs-roo-code-open-source-agentic-coding-2026/)、[Roo CHANGELOG](https://github.com/RooCodeInc/Roo-Code/blob/main/CHANGELOG.md)。

### 2.2 进程模型：扩展内 loop vs 子进程 RPC

三种模式的真实取舍（交叉验证自上表各来源）：

1. **扩展进程内 loop（Continue VS Code / Cline / Roo / Copilot Chat）**：零 IPC 开销、直接用 VS Code API、调试简单；代价是 core 崩溃连累扩展主机、CPU 密集操作会卡其他扩展。
2. **子进程 RPC（Claude Code 扩展 / Continue JetBrains / pi webview 模式）**：崩溃隔离、可复用既有 CLI、可独立升级；代价是打包二进制体积、spawn 冷启动（vscode-languageclient 场景实测 fork Node + 重放模块图约 100–300ms，[Stéphane Erard 分析](https://serard.dev/content/blog/ide-dsl/08-extension-host-client.html)）、跨进程流式协议复杂度。
3. **关键共性**：不管进程放哪，头部产品都先立了**类型化协议边界**（Continue 的 `core/protocol/*.ts`、Cline 的 proto 文件、Claude Code 的 stream-json）。进程模型是可以后换的，协议边界不立后面就换不动。

**对我们的启示（只借鉴架构）**：
- at-opsAgent 的核心卖点是「进程内嵌入 AT MCP Hub + 能力插件热注册」，工具调用大量是进程内直达，选**扩展进程内 loop** 收益最大（**采用**）。
- 但 agent core（loop、会话、compaction、子代理调度）与 VS Code API 之间**立 `IHost` 接口 + 类型化消息协议**（借鉴 Cline HostBridge / Continue IDE 抽象），webview 通信用「request_id + 类型化 envelope + 流式事件」模式（借鉴 ProtoBus 思想）。**不采用** protobuf/gRPC codegen——两端都是 TypeScript，共享 `.d.ts` 协议包成本低得多；Cline 上 proto 是为了多语言宿主，我们没这个需求。
- **不采用** Claude Code 式子进程 CLI 包装：我们没有既有 CLI 资产，且热注册要求 Hub 与能力插件同进程。
- Roo 的 **per-mode 工具白名单 + 文件访问 glob + per-mode 模型路由**直接映射到运维子代理隔离设计（§5），**采用**其思想。

---

## 3. MCP 嵌入模式

### 3.1 MCP TypeScript SDK：stdio vs in-process vs Streamable HTTP

官方 SDK（[@modelcontextprotocol/sdk 文档](https://ts.sdk.modelcontextprotocol.io/server)、[DeepWiki 传输对比](https://deepwiki.com/modelcontextprotocol/typescript-sdk/6.2-transport-comparison-and-selection)）：

| 传输 | 类 | 场景 | 状态 |
|------|----|------|------|
| stdio | `StdioServerTransport` / `StdioClientTransport` | 宿主 spawn 子进程（Claude Desktop / IDE 惯例） | 活跃 |
| Streamable HTTP | `StreamableHTTPServerTransport`（含 Web 标准版） | 远程/多客户端/OAuth，POST + SSE 流 | **推荐**（远程） |
| HTTP+SSE | `SSEServerTransport` | 旧协议（2024-11-05） | **弃用** |
| InMemory | `InMemoryTransport.createLinkedPair()` | **同进程** client↔server 直连，官方定位「testing and embedded scenarios」 | 活跃 |

来源另见 [DeepWiki: Stdio and In-Memory Transports](https://deepwiki.com/modelcontextprotocol/typescript-sdk/4.4-stdio-and-in-memory-transports)。

**对 at-opsAgent 的嵌入方案（采用）**：
- 扩展进程内：agent core 的 MCP client ↔ 嵌入式 Hub server 用 `InMemoryTransport.createLinkedPair()` 直连——零序列化进程边界、无 spawn 开销、天然支持热注册后即时 `tools/list_changed` 通知。
- 对外：继续发布 `~/.at-series/mcp/hub.js` stdio 入口给 Cursor/其他 IDE 复用（与 at-series-mcp-hub 现状一致），两个入口共享同一 registry/路由代码。
- **不采用**在扩展里起本地 Streamable HTTP 端口作为主通道：多窗口端口冲突、防火墙提示、凭据暴露面都变大；仅当未来要「浏览器端 webview 直连」再评估。

### 3.2 工具渐进发现 / tool search 业界做法

三方证据链非常一致——**全部工具定义前置注入 context 已被判死刑**：

1. **Anthropic 官方 Tool Search Tool**（[Advanced tool use 工程博客](https://www.anthropic.com/engineering/advanced-tool-use)、[官方文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)）：五个 MCP server 的典型组合（GitHub/Slack/Sentry/Grafana/Splunk）光定义就吃 ~55K token；改成 `defer_loading: true` + 搜索工具（regex 或 BM25 两种变体）后，初始只载 ~500 token 的搜索工具 + 少量常用工具，按需展开 3–5 个相关工具，**token 占用降 85%+**；单请求最多 1 万个 deferred 工具，至少留一个非 deferred。
2. **Claude Code MCP Tool Search**：MCP 工具描述总量超过 **10K token 阈值自动激活** defer + 搜索（[第三方解读](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide)，引用 Anthropic 发布说明；有开发者实测 66K token 会话开销被 MCP 定义吃掉）。
3. **Cursor**：约 **40 个活跃工具硬上限**，超出部分「UI 里可见但 agent 拿不到 schema」静默失效（[Cursor MCP docs](https://cursor.com/docs/mcp) + [EvoMap 实测](https://evomap.ai/blog/cursor-mcp-servers-setup-examples-limits) + [AgenticMarket 实测](https://agenticmarket.dev/blog/mcp-server-connected-agent-ignores-tools)交叉验证）。
4. **pi-mcp-adapter 的 proxy tool 模式**（本地源码验证，`/tmp/research/pi-agent-studio/pi-mcp/src/proxy-tools.ts`）：不管接多少 server，agent 永远只看到 `mcp_tool_search` + `mcp_tool_call`（外加资源工具）两三个稳定代理工具；配套元数据磁盘缓存（server 未连也能搜）、搜索排序、空闲断连。极致省 context，代价是每次真实调用多一跳、schema 对模型可见性最弱。
5. **Roo Code** 的工程补丁佐证同一痛点：工具过多告警（PR #10772）、把 MCP server 清单从系统提示移除（PR #10895）（[CHANGELOG](https://github.com/RooCodeInc/Roo-Code/blob/main/CHANGELOG.md)）。

**与 AT Hub v2 对照**（本地 `/tmp/research/at-series-mcp-hub/docs/protocol/v2.md`）：Hub 的 `at_search_tools` / `at_get_tool` / `at_select_tools` + `AT_SERIES_TOOL_DISCOVERY`（auto，阈值默认 20）+ 选择空闲 TTL，正好落在业界谱系中间——比 pi-mcp 纯代理多了「select 后原生暴露 schema」（模型可见性好），比 Anthropic defer_loading 少了对特定 API 的绑定（模型无关）。**方向正确，采用并坚持**。

**大量 tools 撑爆 context 的缓解清单（采用）**：
- 阈值化渐进暴露（≤20 个全量直出，超过走 discover→select→call），与 Hub v2 保持一致。
- 常用 3–5 个高频工具常驻不 defer（Anthropic 官方建议）。
- 工具描述预算化：搜索结果只给 120 字符预览（Hub v2 已定），完整 schema 用 `at_get_tool` 按需取。
- 若目标模型是 Claude 系且走 Anthropic API，可把 Hub 工具再映射为 `defer_loading`（服务端搜索），两层机制不冲突。
- 工具结果（不仅是定义）也要预算：大输出截断 + 落盘引用（见 §4.3 compaction）。

---

## 4. LLM 接入

### 4.1 各家 API 对运维 Agent 场景的可用性

| 提供方 | 接入协议 | 工具调用 | 思考流 | 运维场景备注 |
|--------|----------|----------|--------|--------------|
| OpenAI | Chat Completions / Responses API | 成熟 | Completions **不返回** reasoning；Responses API 返回（[Mozilla any-llm 分析](https://blog.mozilla.ai/standardized-reasoning-content-a-first-look-at-using-openais-gpt-oss-on-multiple-providers-using-any-llm/)） | 生态最广，兼容端点事实标准 |
| Anthropic | Messages API | 成熟（并行工具、interleaved thinking） | thinking 内容块 + 加密 signature（§4.2） | agentic 长任务表现最好，配套 context editing / tool search 原生能力 |
| 阿里通义 Qwen | DashScope **OpenAI 兼容**端点 | 支持 function calling | `reasoning_content` 字段；`enable_thinking` 需经 `extra_body`（非标准参数）（[阿里云深度思考文档](https://help.aliyun.com/en/model-studio/deep-thinking)） | 国内合规部署方便，长上下文（Qwen3 Max 线支持至 1M，[对比](https://gptproto.com/blog/qwen-3-8-max-vs-qwen-3-7-max)） |
| DeepSeek | **同时提供 OpenAI 兼容与 Anthropic 兼容**两个 base_url（[官方文档](https://api-docs.deepseek.com/guides/reasoning_model)） | 支持；思考模式下工具调用有版本差异，需按模型验证 | `reasoning_content` | 性价比高，适合子代理批量调查类任务 |
| Moonshot Kimi | OpenAI 兼容 | 支持；K2/K3 线 agentic 基准强（[BenchLM 2026-08 榜](https://benchlm.ai/llm-agent-benchmarks)） | 部分型号 thinking 默认关/开不一，经 `extra_body` 控制（阿里云代理供应版见上文档） | 长上下文 + agentic 是卖点 |
| 智谱 GLM | OpenAI 兼容 | GLM-4.5+ 系列原生支持工具调用（vLLM 有专用 `glm45` reasoning parser，[vLLM 文档](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)） | thinking 输出走 reasoning parser | 开源权重线（MIT）适合私有化运维环境自托管 |

运维场景两条硬要求：(a) **函数调用可靠性**——开源权重模型的 tool-call 输出语法各异，依赖 serving 端 parser（vLLM 维护约二十种族群 parser），parser 配错时工具调用会以纯文本形式静默失败（[fastino 开源权重接入指南](https://fastino.ai/blog/how-to-use-open-weight-models)）；Cline 对弱工具调用模型提供 prompt 兜底（同上）。(b) **私有化**——运维数据敏感，GLM/Qwen/DeepSeek 开源权重 + vLLM 自托管是重要选项，接入层必须允许自定义 baseURL + 自定义 header（pi-agent-studio 的 models.json per-model 协议/baseURL/header 覆盖设计可借鉴，本地 README 验证）。

**建议：采用**「OpenAI 兼容为主协议 + Anthropic Messages 为第二协议」的双协议 provider 层，per-model 可覆盖 baseURL/header/协议；**采用** prompt 兜底式工具调用降级开关；**不采用**为每家单独写 SDK 集成（维护面爆炸，Continue 40+ provider 的维护成本是反面教材）。

### 4.2 thinking/reasoning 流式协议差异（必须归一化）

各家在流式 delta 里放思考内容的字段**互不兼容**（[Mozilla any-llm 实测表](https://blog.mozilla.ai/standardized-reasoning-content-a-first-look-at-using-openais-gpt-oss-on-multiple-providers-using-any-llm/)、[vLLM Reasoning Outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)）：

| 来源 | 流式字段 | 备注 |
|------|----------|------|
| DeepSeek / xAI / DashScope(Qwen/GLM/Kimi 代理) | `delta.reasoning_content` | 事实上的国产系标准 |
| vLLM 新版 / Groq | `delta.reasoning`（vLLM 由 `reasoning_content` 更名，旧字段仍兼容） | 客户端读错字段会**静默拿到空值** |
| Ollama | `thinking` | |
| OpenAI 官方 | Completions 不给；Responses API 的 reasoning item | |
| Anthropic | `content_block_delta` 事件流：`thinking_delta` → `signature_delta` → `content_block_stop`；另有 `redacted_thinking` 块 | **多轮工具调用必须原样回传 thinking 块及 signature，否则 400**（[官方 extended thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[AWS Bedrock 版交叉验证](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html)） |

开关参数同样不统一：Qwen `enable_thinking`、DeepSeek `thinking: {type: enabled}` + `reasoning_effort`、部分模型 `thinking=True`，且都要经 OpenAI SDK 的 `extra_body` 传（[阿里云文档](https://help.aliyun.com/en/model-studio/deep-thinking)）。

**建议（采用）**：provider 适配层输出统一内部事件流 `{type: "reasoning_delta" | "text_delta" | "tool_call_delta" | ...}`；内部消息模型为 Anthropic 式内容块数组（表达力最强，能无损降级到 OpenAI 格式）；Anthropic 的 thinking 块 + signature 按「不可变附件」存进会话，回放时原样回传；思维链 UI 单独折叠渲染（运维场景审计需要，但注意 signature/redacted 块不可编辑）。

### 4.3 长上下文与 compaction 策略

Claude Code 的分层设计是目前最完整的公开参考（[Claude Code Context Management 文档镜像](https://www.mintlify.com/saurav-shakya/Claude_Code-_Source_Code/advanced/context-management)，源码交叉验证 [microCompact.ts](https://github.com/claude-code-best/claude-code/blob/main/src/services/compact/microCompact.ts)、[apiMicrocompact.ts](https://github.com/claude-code-best/claude-code/blob/main/src/services/compact/apiMicrocompact.ts)）：

1. **Microcompact**：cache 感知地清掉过期工具结果（保留最近 N 个），刻意不破坏 Anthropic prompt cache 前缀；还有「冷缓存时间触发」变体——距上次请求间隔过长、缓存必失效时才做全量内容清理。
2. **API 原生 context editing**：`context_management.edits` 的 `clear_tool_uses` / `clear_thinking` 策略（Anthropic API 能力，[advanced tool use 博客](https://www.anthropic.com/engineering/advanced-tool-use)同文提及）。
3. **AutoCompact**：接近上限时全量摘要替换历史，插入 compaction 边界标记。
4. **Reactive compaction**：捕获 `prompt_too_long` 错误 → 压缩 → 自动重试，最后防线。
5. **手动 `/compact`**：用户在大任务前主动腾空间。

Roo Code 也以「更激进的 context-compaction」作为长会话卖点（[OpenAIToolsHub 评测](https://www.openaitoolshub.org/en/blog/roo-code-review)，未逐行验证其实现）。

**建议（采用，分两期）**：一期做「工具结果裁剪（保最近 N 条 + 大结果落盘换引用）+ 阈值触发全量摘要 + 摘要边界标记」；二期做 cache 感知（前缀稳定性优先、system+工具定义放最前且不动）与 `prompt_too_long` 兜底重试。运维会话的特殊性：日志/指标原始数据**先落盘、context 里只留路径 + 摘要**，从源头少进 context（对应 Anthropic「tool 结果 50K+ token」的教训）。

---

## 5. 多 Agent / 子代理编排

### 5.1 三种编排形态

| 模式 | 机制 | 适用 | 来源 |
|------|------|------|------|
| **Orchestrator-worker** | 主 agent 分解任务 → 并行 spawn 子代理 → 汇总综合；子代理独立 context，只回传压缩结论 | 广度优先调查、需要最终统一答案 | [Anthropic 多代理研究系统](https://www.anthropic.com/engineering/multi-agent-research-system)（较单 Opus 提升 90.2%，代价约 15× token；并行化把复杂调查时间缩短最多 90%） |
| **Handoff** | 会话所有权转移给专家 agent，由它直接面向用户 | 路由本身即业务（客服分诊类） | [OpenAI Agents SDK — Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)、[Handoffs 指南](https://openai.github.io/openai-agents-js/guides/handoffs/) |
| **Agents as tools（manager 式）** | 主 agent 保持对话控制权，把专家当有界函数调用 | 需要综合多方结果、统一 guardrails | 同上（OpenAI 官方明确的二选一决策表）；swarm 风格（对等移交）已被 Agents SDK 的 handoff 收编 |

Anthropic 工程教训中对我们最有用的三条：给子代理**明确的目标、输出格式、工具指引与任务边界**，否则重复劳动/漏查；**effort scaling 规则**写进提示（简单问题 1 个子代理 3–10 次工具调用，复杂调查才 10+）；并行 spawn 3–5 个子代理 + 子代理内并行工具调用是速度关键（[原文](https://www.anthropic.com/engineering/multi-agent-research-system)）。

### 5.2 运维事故并行调查 → 子代理映射（采用方案）

事故场景天然是「广度优先 + 需要统一结论」，选 **orchestrator-worker + agents-as-tools**（**不采用 handoff**——事故指挥权不能转移，主 Agent 必须对用户负责并汇总）：

```
IncidentCommander（主 Agent，强模型）
 ├─ log-investigator      日志面   工具白名单: at_search_tools + Grafana/Loki 只读
 ├─ metrics-investigator  指标面   工具白名单: Grafana 查询只读
 ├─ change-investigator   变更面   工具白名单: Jenkins 构建历史 / Nacos 配置历史只读
 └─ host-investigator     主机面   工具白名单: JumpServer/Terminal 只读命令集
      （并行执行，结构化 artifact 回传：结论 + 证据引用 + 置信度）
```

- 子代理返回**结构化 artifact**（发现、证据 URI、时间线片段、置信度），主 Agent 只见摘要不见全过程——这是 Claude Code Agent tool 的既定行为（「parent 只收到最终文本结果」，[tools-reference](https://code.claude.com/docs/en/tools-reference.md)）。
- 写操作（重启、回滚、扩容）**永不下放子代理**，收敛在主 Agent + 人工审批门（复用 at-series-command-policy 的危险命令审批思路；pi-agent-studio 的 Dangerous Command Approval 是同构实现，本地 README 验证）。

### 5.3 隔离机制：工具白名单、工作目录、超时、取消

Claude Code subagents 的字段设计可直接作为我们的 schema 蓝本（[官方 sub-agents 文档](https://code.claude.com/docs/en/sub-agents)）：

| 隔离维度 | Claude Code 做法 | at-opsAgent 建议 |
|----------|------------------|------------------|
| 工具 | `tools` 白名单 / `disallowedTools` 黑名单，支持 `mcp__server` 整服务器粒度 | 采用：白名单 + Hub 的 `risk` 注解联动（`risk: write` 工具默认不进子代理） |
| 上下文 | 每个子代理全新 context window，看不到主会话与兄弟 | 采用 |
| 模型 | `model: sonnet/haiku/inherit`，高量低判断任务路由便宜模型 | 采用（调查类子代理用国产高性价比模型） |
| 权限 | `permissionMode`；注意**父会话的宽权限会覆盖子代理配置**（bypassPermissions 等） | 采用并修正：我们的实现中子代理权限只能比父更严，不允许被父放宽穿透 |
| 步数/预算 | `maxTurns` 硬上限 | 采用 + token 预算上限（Anthropic 15× token 教训） |
| 工作目录 | 起始于主会话 cwd，`cd` 不跨调用持久；`isolation: worktree` 给隔离副本 | 运维场景无 git worktree 概念 → 换成「目标环境作用域」：子代理绑定只读的主机组/命名空间/时间范围 |
| 取消 | 会话级 abort | 采用：`AbortSignal` 全链路透传（LLM 请求、MCP `tools/call`、子代理树级联取消），MCP TS SDK 请求支持 per-request timeout 与 cancellation |

并发与重试参数业界常见值：并行子代理 3–6、失败重试 2 次、每子代理独立超时与遥测（[Anthropic 原文](https://www.anthropic.com/engineering/multi-agent-research-system)及其[第三方工程化解读](https://sukruyusufkaya.com/en/blog/anthropic-multi-agent-orchestrator-worker-pattern-2026)；后者为二手来源，参数属经验值而非规范）。

**不采用**：自由 swarm/对等移交（事故场景不可审计）、子代理再 spawn 子代理（深度 >2 的树难以取消和计费，Claude Code 同样限制子代理不能再开 Agent tool）。

---

## 6. 性能与可靠性清单

逐项给出目标值 / 做法 / 依据：

| 项 | 目标/做法 | 依据 |
|----|-----------|------|
| **扩展 activate 时间** | `activationEvents: []`（1.74+ 命令自动激活），侧边栏用 `onView:<viewId>`；禁用 `*` 与非必要 `onStartupFinished`；activate 内只注册不初始化，重活延迟到首次交互。参考目标：UI 贡献 <100ms、复杂集成 <500ms | [官方 activation 事件文档/样例分析](https://deepwiki.com/microsoft/vscode-extension-samples/2.1-extension-lifecycle-and-activation)、[Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)、[Jason Williams 实测](https://jason-williams.co.uk/posts/speeding-up-vscode-extensions-in-2022/)（加载 600 个小文件远慢于 1 个大文件） |
| **打包** | esbuild 单文件 bundle（extension 与 webview 分别出包），`.vscodeignore` 收紧 vsix | 同上（官方 bundling 指南） |
| **Webview 首屏** | 静态 HTML 骨架 + 首屏最小 JS；会话历史懒加载分页；重组件（图表/终端渲染）动态 import；CSP + `asWebviewUri` | [Webview API 指南](https://code.visualstudio.com/api/extension-guides/webview) |
| **流式背压** | LLM token 增量在扩展侧合批（~30–50ms 或按帧 flush）再 `postMessage`；单条消息封顶（大工具结果传引用不传体）；webview 侧虚拟列表渲染长会话 | postMessage 走 extension host RPC 序列化，高频小消息是已知瓶颈（[vscode#137757](https://github.com/microsoft/vscode/issues/137757) 揭示的序列化通道机制）；Cline 用 gRPC 流式订阅而非逐 token 消息同理（[DeepWiki gRPC Service Layer](https://deepwiki.com/cline/cline/2.5-grpc-service-layer)） |
| **工具 list 缓存** | Hub 侧内存目录 + 磁盘元数据缓存（server 未连/未启也能 search），`listChanged` 通知失效；借鉴 pi-mcp 的 metadata-cache + 缓存有效性校验 | 本地源码 `/tmp/research/pi-agent-studio/pi-mcp/src/metadata-cache.ts`；Hub v1 registry 机制 |
| **invoke 超时** | 每个 `tools/call` 显式 timeout（MCP TS SDK 支持 per-request timeout，长任务用 progress 通知续期）；子代理层再套 maxTurns/总预算；空闲连接回收（pi-mcp idle disconnect 同款） | [MCP TS SDK 文档](https://ts.sdk.modelcontextprotocol.io/server)；本地 `/tmp/research/pi-agent-studio/pi-mcp/src/idle.ts` |
| **会话落盘** | 每轮事件 append-only JSONL 写 `globalStorageUri`，含工具调用/结果引用/compaction 边界；写入异步不阻塞 loop | Claude Code/pi 均为 JSONL 会话惯例；`globalStorageUri` 为官方大文件存储位（[Common Capabilities](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)） |
| **崩溃恢复** | webview re-resolve 后从扩展侧状态全量再水化（pi-agent-studio 已验证的模式）；扩展主机重启后从 JSONL 重建会话到最后完整轮；运行中的工具调用标记为 `interrupted` 而非悬挂 | pi-agent-studio README（本地）；Continue `CoreMessenger.restart()` 的子进程重启思路（[DeepWiki](https://deepwiki.com/continuedev/continue/7.2-core-process-communication)） |
| **取消** | 用户停止按钮 → AbortSignal 级联：LLM 流、全部子代理、进行中的 MCP 调用；UI 立即响应，后台异步清理 | Cline grpc request cancellation、Claude Code session AbortController（[cc-adapter 逆向](https://github.com/hoveychen/cc-adapter/blob/main/docs/reverse-engineering.md)） |
| **凭据** | 全部走 SecretStorage；日志与遥测统一脱敏管道 | §1.4 来源 |
| **可观测** | 每子代理/每工具调用记录时延、token、成败（Anthropic 多代理系统的遥测清单）；MCP 连接失败进 Output channel（业界排障惯例） | [Anthropic 多代理博客](https://www.anthropic.com/engineering/multi-agent-research-system)；[MCP 排障惯例](https://www.rapidevelopers.com/mcp-tutorial/how-to-debug-mcp-server-connection-issues) |

---

## 7. 采用 / 不采用 汇总

### 采用
1. **WebviewView 自建侧边栏**（无状态 webview + 扩展侧会话真源 + getState 存轻 UI 态）。
2. **扩展进程内 agent loop + 类型化协议边界**（`IHost` 抽象 + request_id envelope + 流式事件），为未来抽独立 core 进程留路。
3. **InMemoryTransport 进程内嵌入 Hub**，对外保留 stdio `hub.js` 双入口。
4. **渐进工具发现**（Hub v2 的 search/get/select 三段式 + 阈值 auto 模式 + 常用工具常驻）。
5. **双协议 LLM provider 层**（OpenAI 兼容 + Anthropic Messages），per-model baseURL/header/协议覆盖，reasoning 流字段归一化，弱模型 prompt 工具调用兜底。
6. **分层 compaction**（工具结果裁剪→摘要→prompt_too_long 兜底；运维大数据先落盘后引用）。
7. **Orchestrator-worker + agents-as-tools 子代理**（日志/指标/变更/主机四面并行、结构化 artifact 回传、并发 3–6、maxTurns+token 预算、AbortSignal 级联取消）。
8. **子代理隔离 schema 借鉴 Claude Code**（tools 白名单联动 Hub risk 注解、独立 context、per-agent 模型路由、权限只紧不松）。
9. **exports API 做同 host 插件热注册快速路径**，Bridge 注册表为通用路径。
10. **SecretStorage 存凭据 + 文件系统存 Agent/技能/MCP 配置 + globalStorageUri 存 JSONL 会话**。
11. **性能纪律**：空 activationEvents、esbuild 单文件、postMessage 合批、工具目录缓存、per-call 超时、崩溃再水化。

### 不采用
1. **Chat Participant / LM Tools 作为主 UI**（无系统提示控制权、Cursor 不可用）——仅留后期薄适配的可能。
2. **Claude Code 式子进程 CLI 包装**（与进程内 Hub 热注册目标冲突，且无 CLI 资产可复用）。
3. **protobuf/gRPC codegen 通信层**（双端同为 TS，共享类型包即可；Cline 的多语言诉求我们没有）。
4. **retainContextWhenHidden 兜底**（高内存开销，官方明示慎用；侧边栏场景本就要做再水化）。
5. **proposed API（extensionsAny 等）**（不能随 Marketplace 发布）。
6. **globalState 存任何敏感信息**（明文）。
7. **全量工具定义前置注入**（Cursor 40 上限与 Claude Code 10K token 自动 defer 已证伪该路线）。
8. **Handoff/自由 swarm 编排**（事故指挥权不可转移、审计困难）；**子代理递归 spawn**（取消与计费失控）。
9. **本地 HTTP 端口作为扩展内主通信通道**（端口冲突/暴露面）。
10. **为每家模型厂商单独写 SDK 集成**（维护面爆炸）。

---

## 附：来源索引

**VS Code 官方**
- AI Extensibility Overview — https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview
- Chat Participant API — https://code.visualstudio.com/api/extension-guides/ai/chat
- prompt-tsx 指南 — https://code.visualstudio.com/api/extension-guides/ai/prompt-tsx
- Webview API — https://code.visualstudio.com/api/extension-guides/webview
- vscode-api（extensions/SecretStorage）— https://code.visualstudio.com/api/references/vscode-api
- Common Capabilities（Data Storage）— https://code.visualstudio.com/api/extension-capabilities/common-capabilities
- Bundling Extensions — https://code.visualstudio.com/api/working-with-extensions/bundling-extension
- keytar 移除 — https://github.com/microsoft/vscode/issues/185677 ；迁移公告 https://github.com/microsoft/vscode-discussions/discussions/662
- webview buffer 限制 — https://github.com/microsoft/vscode/issues/137757
- 跨 host exports 提案 — https://github.com/microsoft/vscode/issues/145307

**同类产品**
- Continue 架构 — https://deepwiki.com/continuedev/continue/2-architecture ；https://deepwiki.com/continuedev/continue/7.2-core-process-communication ；https://github.com/continuedev/continue/blob/main/extensions/vscode/src/extension/VsCodeMessenger.ts
- Cline — https://deepwiki.com/cline/cline/2-extension-architecture ；https://github.com/cline/cline/pull/2830 ；https://github.com/cline/cline/pull/3747 ；https://martianlee.github.io/posts/2026-06-30-cline-architecture
- Roo Code — https://github.com/RooCodeInc/Roo-Code/blob/main/CHANGELOG.md ；https://pickuma.com/for-dev/cline-vs-roo-code-open-source-agentic-coding-2026/ ；https://www.openaitoolshub.org/en/blog/roo-code-review
- Copilot Chat（开源）— https://github.com/microsoft/vscode-copilot-chat/blob/main/CONTRIBUTING.md ；https://github.com/microsoft/vscode-prompt-tsx
- Cursor MCP — https://cursor.com/docs/mcp ；40 工具上限实测 https://evomap.ai/blog/cursor-mcp-servers-setup-examples-limits ；https://agenticmarket.dev/blog/mcp-server-connected-agent-ignores-tools
- Claude Code VS Code 扩展 — https://continuumcode.ai/guides/claude-code-vscode/ ；逆向 https://github.com/hoveychen/cc-adapter/blob/main/docs/reverse-engineering.md ；https://github.com/anthropics/claude-code/issues/86871
- pi-agent-studio — https://github.com/JohnnyZ93/pi-agent-studio （本地源码 `/tmp/research/pi-agent-studio`，pi-mcp 代理工具/缓存/空闲断连实现）
- EclipseSource 域特定 AI 扩展分析 — https://eclipsesource.com/blogs/2026/03/19/domain-specific-ai-extensions-vs-code/

**MCP**
- TS SDK Server/Transports — https://ts.sdk.modelcontextprotocol.io/server ；https://deepwiki.com/modelcontextprotocol/typescript-sdk/4.4-stdio-and-in-memory-transports ；https://deepwiki.com/modelcontextprotocol/typescript-sdk/6.2-transport-comparison-and-selection
- Anthropic Tool Search / Advanced Tool Use — https://www.anthropic.com/engineering/advanced-tool-use ；https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Claude Code MCP Tool Search 解读 — https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide

**LLM**
- DeepSeek API — https://api-docs.deepseek.com/guides/reasoning_model
- 阿里云深度思考模型（Qwen/GLM/Kimi 开关与 reasoning_content）— https://help.aliyun.com/en/model-studio/deep-thinking
- reasoning 字段分裂实测 — https://blog.mozilla.ai/standardized-reasoning-content-a-first-look-at-using-openais-gpt-oss-on-multiple-providers-using-any-llm/
- vLLM Reasoning Outputs（parser 表）— https://docs.vllm.ai/en/latest/features/reasoning_outputs/
- Anthropic extended thinking — https://platform.claude.com/docs/en/build-with-claude/extended-thinking ；Bedrock 版 https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html
- Claude Code compaction — https://www.mintlify.com/saurav-shakya/Claude_Code-_Source_Code/advanced/context-management ；源码 https://github.com/claude-code-best/claude-code/blob/main/src/services/compact/microCompact.ts
- agentic 基准（2026-08）— https://benchlm.ai/llm-agent-benchmarks ；开源权重接入注意事项 https://fastino.ai/blog/how-to-use-open-weight-models

**多 Agent**
- Anthropic 多代理研究系统 — https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI Agents SDK 编排/handoff — https://developers.openai.com/api/docs/guides/agents/orchestration ；https://openai.github.io/openai-agents-python/multi_agent/ ；https://openai.github.io/openai-agents-js/guides/handoffs/
- Claude Code subagents — https://code.claude.com/docs/en/sub-agents ；tools-reference https://code.claude.com/docs/en/tools-reference.md

**性能**
- activation 最佳实践 — https://deepwiki.com/microsoft/vscode-extension-samples/2.1-extension-lifecycle-and-activation ；https://jason-williams.co.uk/posts/speeding-up-vscode-extensions-in-2022/ ；子进程冷启动开销 https://serard.dev/content/blog/ide-dsl/08-extension-host-client.html
