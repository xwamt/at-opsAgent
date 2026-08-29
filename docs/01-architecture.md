# 01 · 系统架构

## 1. 一句话结构

> **pi SDK 在扩展进程内跑 Agent loop；`@at-series/mcp-hub` 作为一等 ToolProvider 热发现 AT 插件；Vue 3 Webview 只渲染，状态真源在 extension host。**

```text
┌──────────────────────────────── VS Code / Cursor 扩展宿主 ────────────────────────────────┐
│                                                                                           │
│  ┌─ at-opsAgent ───────────────────────────────────────────────────────────────────────┐ │
│  │  WebviewView (Vue 3)  ←类型化 envelope→  HostBridge (IHost)                         │ │
│  │       ▲                                    │                                        │ │
│  │       │ 合批流式事件                        ▼                                        │ │
│  │  TreeViews: Sessions / Capabilities / Approvals / Skills / Models                   │ │
│  │       ▲                                    │                                        │ │
│  │       └─────────────── 投影 ◄── Orchestrator (Playbook 状态机 + 子代理调度)          │ │
│  │                                            │                                        │ │
│  │  ┌─ Agent Runtime (pi SDK, in-process) ────┴─────────────────────────────────────┐ │ │
│  │  │  createAgentSession                                                             │ │ │
│  │  │   · ModelRuntime  (SecretStorage 凭证)                                          │ │ │
│  │  │   · SessionManager (JSONL v3 → ~/.at-series/agent/sessions)                     │ │ │
│  │  │   · OpsResourceLoader (system prompt L0–L4 + skills/playbooks)                  │ │ │
│  │  │   · customTools[]  ← HubHost + ExternalMcpProvider + 内置只读 workspace 工具      │ │ │
│  │  │   · beforeToolCall 权限闸 (riskCeiling / approvalToken / payloadCaps)            │ │ │
│  │  └─────────────────────────────────────────────────────────────────────────────────┘ │ │
│  │                                            │                                        │ │
│  │  ┌─ HubHost ─────────────────────────────────────────────────────────────────────┐ │ │
│  │  │  createHubRuntime({ hostApp, audit, onToolsListChanged })                       │ │ │
│  │  │  SelectionController · AtSeriesToolProvider                                     │ │ │
│  │  └──────────────┬────────────────────────────────────────────────────────────────┘ │ │
│  └─────────────────┼──────────────────────────────────────────────────────────────────┘ │
│                    │ fs.watch + HTTP 127.0.0.1                                          │
│                    ▼                                                                    │
│  ~/.at-series/bridges/<hostApp>/*.json     ~/.at-series/logs/<hostApp>/agent-ops-*.jsonl │
│                    │                                                                    │
│     ┌──────────────┼──────────────┬──────────────┬──────────────┐                       │
│     ▼              ▼              ▼              ▼              ▼                       │
│  at.terminal   at.jumpserver  at.grafana    at.jenkins     at.nacos …                   │
│  Bridge :p     Bridge :p      Bridge :p     Bridge :p      Bridge :p                    │
│  凭据/确认弹窗留在各插件内                                                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘

并行、互不干扰：
  Cursor MCP client ──stdio──► node ~/.at-series/mcp/hub.js ──► 同一批 Bridges
```

## 2. 分层

| 层 | 包 / 模块 | 职责 | 禁止 |
|----|-----------|------|------|
| UI | `packages/webview-chat`、`packages/webview-board` | 渲染对话、时间线、审批条、看板 | 不持有会话真源；不直接 HTTP 调 Bridge |
| Host | `packages/extension` | VS Code 适配：webview 协议、TreeView、SecretStorage、命令 | 不含 LLM loop 业务 |
| Orchestrator | `packages/orchestrator` | Playbook 状态机、子代理下发、证据板合并、审批令牌 | 不直接调 LLM provider |
| Runtime | `packages/runtime` | 封装 pi `createAgentSession`、compaction、steering | 不 import `vscode` |
| Hub adapter | `packages/hub-host` | `createHubRuntime` ↔ `AgentTool[]` | 不实现 Bridge、不写 registry |
| Policy | `packages/policy` | 审批规则、payload caps、与 `@at-series/command-policy` 预判 | 不得替代插件侧权威判定 |
| External MCP | `packages/mcp-client`（可选） | 用户第三方 MCP；**屏蔽名为 AT Series 的条目** | 不把 AT 插件再配成 MCP |

`packages/runtime` / `orchestrator` / `hub-host` / `policy` **零 `vscode` import**，便于单测与未来抽独立进程（协议已按此预留，见 §5）。

## 3. 进程模型

**主路径：扩展进程内 loop。** 理由：

- 核心卖点是热注册：Hub 与 Agent 同进程才能在 200ms 级把新插件工具送进下一轮 LLM。
- 已分析的 AT Bridge invoke 是 loopback HTTP，崩溃面在插件侧 HTTP 服务，不在 Hub 状态机。
- 头部产品（Continue / Cline / Copilot Chat）在 VS Code 里同样进程内 loop；Claude Code 子进程模式是因为他们已有 CLI 资产，我们没有。

隔离策略（不靠把整个 loop 扔出进程）：

| 风险 | 对策 |
|------|------|
| 插件 Bridge 挂死 | Hub 2s/5s/120s 超时 + 传输失败立即摘桥；不阻塞 event loop 之外的 UI |
| 子代理失控 | Investigator 默认 in-process 子会话 + maxTurns/maxWallMs；Executor / 长命令可升级为 worker thread 或 child `createAgentSessionRuntime` |
| LLM SDK 体积 / 原生依赖 | esbuild 分 chunk，Bedrock 等按需加载 |
| 扩展宿主崩溃 | 会话 JSONL append-only，重启从最后完整 turn 恢复 |

类型化边界：`docs/schemas/host-protocol.ts` 的 envelope。webview ↔ host、host ↔ runtime 共用同一套事件名。将来若抽 core 进程，只换 transport。

> **TBD · 第二客户端 HTTP/SSE（Plan 12 T14 · SKIP，零代码）**
>
> OpsCore facade（`src/core`）保持为进程内单一 API 面。真实第二宿主（CLI 值班脚本 / Web 值班台）出现之前：
>
> - **不**把 loop 抽成独立进程
> - **不**引入 `pi serve` / `kilo serve` / 自建 HTTP+SSE 值班口
> - **不**为「加个 HTTP 就能量化」改 ADR-001 进程模型
>
> 热注册 200ms 依赖 Hub 与 Agent 同进程。需要第二客户端时再给 facade 套 transport，而不是现在预建。

## 4. 仓库布局（目标态）

```text
at-opsAgent/
├── README.md
├── NOTICE
├── package.json                 # 扩展清单（contributes 见 05）
├── esbuild.extension.mjs
├── esbuild.webview.mjs
├── src/                         # packages/extension 的薄入口，activate 只接线
│   └── extension.ts
├── packages/
│   ├── extension/               # TreeView、命令、SecretStorage、webview 托管
│   ├── runtime/                 # pi SDK 封装，无 vscode
│   ├── hub-host/                # AtSeriesHubHost
│   ├── orchestrator/            # Playbook + 子代理
│   ├── policy/                  # 审批 / caps
│   ├── mcp-client/              # 可选第三方 MCP
│   ├── protocol/                # 共享 .d.ts（host-protocol, task-spec）
│   ├── webview-chat/
│   └── webview-board/
├── skills/                      # 随扩展打包的 Skill / Playbook
├── docs/
└── test/
```

第一期允许先单包（`src/` 按上述边界分目录），但 **import 规则从第一天就按层执行**（runtime 不得 import vscode）。

## 5. 依赖

### 5.1 直接依赖（精确锁定）

| 包 | 版本策略 | 用途 |
|----|----------|------|
| `@earendil-works/pi-coding-agent` | **精确** `0.84.3`（三包同号，禁用 `^`） | `createAgentSession`、SessionManager、SettingsManager、ResourceLoader、`defineTool` |
| `@earendil-works/pi-agent-core` | 同号 | `beforeToolCall` / 事件流 |
| `@earendil-works/pi-ai` | 同号 | ModelRuntime、兼容层、OAuth |
| `@at-series/mcp-hub` | `^0.3.3`，建议推进 0.4 增量导出 | `createHubRuntime`、`detectHostApp`、bridge client、审计 |
| `@at-series/command-policy` | `^0.1.1` | Agent 侧 **预判**（权威判定仍在 Terminal Bridge） |
| `vue` `pinia` | 与 At-Database 对齐 3.5.x | 运维 UI |
| `zod` | 单一大版本（锁定 4.x，避免与 Nacos 的 3.x 漂移进本仓） | 配置 / task spec |
| `typebox` | 跟 pi 锁同版 | 包装 Hub JSON Schema 为 `AgentTool.parameters` |

可选：`@modelcontextprotocol/sdk` —— 仅当开启「用户自定义 MCP」。Hub 嵌入路径 **不需要** 它。

不依赖：`pi-tui`、pi CLI、`@mariozechner/*`（已 deprecated，官方改名为 earendil-works）。

### 5.2 对 `@at-series/mcp-hub` 的增量请求

实现可以先用现有导出（`createHubRuntime` / `listBridgeRecords` / `watchBridgeRegistry` / `bridgeInvoke` / `aggregateTools`）在适配层补齐。正式版本应向上游提（详见 02 §7）：

1. 根导出 `toMcpToolDescriptors` / `toolAnnotationsForRisk`
2. `createHubRuntime` 的 `audit` 配置注入（不要靠改 `process.env`）
3. `HubRuntime.listAllTools()` / `getSelectionState()` / `getProviders()`

这些 **不改 protocolVersion**，插件无感。

### 5.3 从 pi-agent-studio 可移植的文件（MIT，保留版权头）

- `src/models/{models-config,auth-config,oauth-flow}.ts` — LLM 配置层
- `bridge/permission-gate.ts` — **只借钩子模式**，规则引擎重写
- `pi-mcp/src/{connection,idle,metadata-cache,search-ranking}.ts` — 仅第三方 MCP 需要
- **不移植** `pi-chat`、`_resolve.ts`（pi 路径探测）、terminal TUI、rewind-code

## 6. 配置与数据落盘

全部 AT 系列共享 `~/.at-series/`，Agent 使用独立子树，避免污染用户若同时安装了 pi coding agent 的 `~/.pi/`。

```text
~/.at-series/
├── bridges/<hostApp>/<bridgeId>.json     # 插件写，Agent 只读
├── mcp/hub.js                            # 插件选举维护，Agent 不依赖
├── logs/<hostApp>/agent-ops-*.jsonl      # Hub 业务调用审计（嵌入路径必须继续写）
└── agent/                                # 本扩展私有
    ├── settings.json                     # 默认模型、发现阈值、审批策略
    ├── models.json                       # 自定义 provider（格式对齐 pi，路径独立）
    ├── mcp.json                          # 用户第三方 MCP（禁止 AT Series 条目）
    ├── auth.json                         # 仅当用户选择文件凭证；默认走 SecretStorage
    ├── sessions/<id>.jsonl               # 会话树 = 产品审计
    └── cache/tool-catalog.json           # 目录元数据，断连仍可搜索
```

项目级覆盖：工作区 `.at-ops-agent/settings.json`（深合并）。

凭据：LLM API key → `context.secrets`；AT 插件凭据 → 各插件自己的 SecretStorage（Agent 永不读取）。

## 7. 与 AT 插件的激活关系

| 扩展 | 建议 activation | 原因 |
|------|-----------------|------|
| 各 AT 能力插件 | 已是 `onStartupFinished` | Bridge 必须常驻，否则 Hub 看不到工具 |
| at-opsAgent | `onStartupFinished` + `onView:atOpsAgent.*` | 必须尽早 `watch` registry，否则「装插件工具立刻出现」在 Agent 未开时失效 |

Agent 的 `activate` **必须廉价**：注册命令 / 建 HubHost / 挂 watch，不创建 LLM session、不连任何模型。首个对话才 `createAgentSession`。
