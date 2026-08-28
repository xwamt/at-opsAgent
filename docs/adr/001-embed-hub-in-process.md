# ADR-001 · 进程内嵌入 Hub 引擎

## 状态

Accepted

## 背景

用户核心诉求：AT 系列插件即 Agent 的能力插件。新安装插件直接向 Agent 注册工具，Agent **不必再配 MCP 服务**。

现状：插件 `publish` 到 `~/.at-series/bridges/`，外部 MCP 客户端 stdio 拉起 `hub.js`。VS Code 官方 installer **没有 vscode writer**，纯 VS Code 用户今天没有 Agent 入口。

## 选项

| 方案 | 做法 | 结论 |
|------|------|------|
| 1 | Agent 当 MCP Client，spawn `node hub.js` | 仍要 MCP 配置；与插件激活顺序耦合；vscode 无 installer |
| 2 | 进程内 `createHubRuntime()`，工具映射为 pi `customTools` | **采用** |
| 2b | 进程内用 MCP `InMemoryTransport` 把 Hub 再包成 MCP server | 多一跳协议，无收益（Hub 引擎本就不是必须走 MCP 的） |
| 3 | 插件 `exports.registerTool` 直连 Agent | 依赖反转、双轨维护、破坏「新插件只认协议」 |

## 决策

采用方案 2。

- 插件 **零改动**：继续 Bridge v1。
- Agent **不写** `ensureAtSeriesMcpConfig`、**不调用** `syncHubBundle`。
- Cursor/Kiro 的 `hub.js` 继续由插件维护，与嵌入 Hub **同读** registry（多读者）。
- 用户 MCP 配置里若出现 server 名 `AT Series` 或 args 指向 `hub.js`，嵌入模式 **跳过启动** 该 server，UI 标注「已由内置 AT Series 接管」。

不采用 2b：调研 05 把 InMemoryTransport 标为 MCP SDK 的官方 embedded 路径，但那是「把一个 MCP Server 嵌进进程」的正解。我们的 Hub 已经以库形式导出 runtime，再套 MCP 只为了让 pi 的 MCP 客户端去 list/call，既重复 Hub v2 的渐进发现，又丢掉 `pluginId` / `risk` / 审计这些一等字段。正确嵌入点是 **ToolProvider，不是 MCP transport**。

## 后果

- 必须在 Agent 侧复用（或向上游要）审计模块，否则绕过 hub.js 会丢掉 `agent-ops-*.jsonl`。
- Hub 崩溃会影响扩展宿主——runtime 已将 watch/探测失败降级为 unhealthy，Agent 再包一层 try/catch 与 Output Channel。
- 选择态是每窗口内存态，与「每个 hub.js 连接一份选择态」同构。
