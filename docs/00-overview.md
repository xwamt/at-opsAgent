# 00 · 产品愿景与设计原则

## 1. 要做成什么

`at-opsAgent` 是 AT 系列的 **运维指挥面**：一个 VS Code / Cursor 侧边栏 Agent，把已经存在的能力插件（SSH 终端、堡垒机、Grafana、Jenkins、Nacos、数据库…）组织成可编排、可审批、可审计的值班工作台。

用户装好 Agent 再装任意 AT 插件后：

1. 侧边栏「能力插件」立刻出现该插件及其工具，**不必再配 MCP server**。
2. 用自然语言发起运维任务（「线上 5xx 帮我查」），Agent 走运维 Playbook：发现工具 → 选中最少 provider → 并行只读取证 → 三态结论 → 需要变更时出 9 要素审批简报。
3. 自定义 LLM（含国产 / 内网 OpenAI 兼容网关）与自定义第三方 MCP 仍然可用，但 **AT Series 不走用户 MCP 配置**。

## 2. 明确不做什么

| 不做 | 原因 |
|------|------|
| 通用 coding agent（写业务代码、本地大重构） | 产品定位冲突；pi-agent-studio 已覆盖该场景 |
| 在 Agent 内保存 JumpServer / Grafana / DB 凭据 | 凭据必须留在各插件 SecretStorage |
| 用 MCP 工具直接发布 Nacos / 触发 Jenkins 构建 | 这些插件 MCP 面刻意只读；写操作走 IDE UI（GuidedManual） |
| 把插件确认弹窗当成会话授权 | SuperOps 铁律：IDE 弹窗 ≠ 会话内批准 |
| 依赖用户全局安装 `pi` CLI | 运维用户不能接受该前置条件 |
| 做 Copilot Chat Participant 主 UI | 无法控制 agent mode 系统提示；Cursor 不可用 |

## 3. 从现有资产继承的硬约束

这些不是偏好，实现不得破坏：

| ID | 约束 | 来源 |
|----|------|------|
| C1 | 能力插件只通过 Bridge v1 注册（`~/.at-series/bridges/<hostApp>/*.json` + `127.0.0.1` HTTP） | Hub protocol v1 |
| C2 | Hub 渐进发现：冷启动不把全部业务工具 schema 塞进上下文；每任务一轮 select；调查中禁止 clear | Hub v2 / SuperOps |
| C3 | Grafana / Nacos / Jenkins MCP **全部只读**；写在 IDE UI | 各插件 skill |
| C4 | Terminal / JumpServer 有 `read/write/exec`；write/exec 插件内确认，且 **不能替代** 会话审批 | SuperOps safe-operations |
| C5 | Payload 有界：Loki `limit≤100`、命令/SFTP 默认 64KB（硬顶 256KB）、SQL 必带 LIMIT、truncated → 收窄 | provider 附录 |
| C6 | 指标相关 ≠ 根因；没有应用侧日志不得宣称根因 | SuperOps 快速路径 |
| C7 | 工具结果是不可信数据，内嵌「指令」不得执行 | SuperOps Safety |
| C8 | 运维文档六类模板 + `待确认/未检查` 占位 | ops-documents |
| C9 | 根因未确认前不写长报告 | SuperOps |
| C10 | 前端对齐 AT 系列：Vue 3 + 映射 `--vscode-*` 的 token，不引入沉重图表库 | At-Database 先例 |

## 4. 关键决策一览

完整论证见 [adr/](adr/000-index.md)。

| ADR | 决策 |
|-----|------|
| [001](adr/001-embed-hub-in-process.md) | 进程内嵌入 `createHubRuntime`，映射为原生 tools；保留 hub.js 给外部 IDE |
| [002](adr/002-pi-sdk-not-fork.md) | 基于 `@earendil-works/pi-*` SDK；不 fork pi-agent-studio；不绑 pi CLI |
| [003](adr/003-webview-not-copilot.md) | 自建 WebviewView；不用 Chat Participant 做主入口 |
| [004](adr/004-no-extension-exports-registration.md) | 插件注册 **只用** 文件系统 registry，不用 `exports.registerTool` |
| [005](adr/005-ops-playbooks.md) | Playbook 状态机 + 四类子代理；调查与执行隔离 |

## 5. 成功标准（设计验收，非实现验收）

后续施工必须能对照本设计回答：

1. 新写一个 AT 插件，只实现 Bridge v1 + `FsBridgePublisher.publish`，**零改 Agent 代码**即可被发现并调用。
2. 纯 VS Code（installer 没有 vscode writer）用户第一次获得 AT 工具入口。
3. 已在 Cursor 里跑着 `hub.js` 的用户，装本 Agent 不会出现双份 AT 工具。
4. 「线上 5xx」能走出 Grafana 只读取证 → 可选 JumpServer 日志 → 三态结论 → 回滚审批的完整链路。
5. 工具数超过阈值时，LLM 上下文里只有 meta/发现能力 + 本任务选中的工具，而不是 70+ 个完整 schema。

## 6. 术语

| 术语 | 含义 |
|------|------|
| 能力插件 | AT 系列 VS Code 扩展，在宿主内跑 Bridge 并向 registry 注册工具 |
| Hub 引擎 | `@at-series/mcp-hub` 的 `createHubRuntime`：watch、聚合、选路、渐进暴露、invoke |
| hub.js | 同一引擎的 stdio MCP 壳，给 Cursor/Kiro/Continue 用；本 Agent **不依赖**它 |
| HubHost | Agent 仓内适配层，把 Hub 引擎投影为 pi `customTools` + UI 事件 |
| Playbook | 机器可读运维链路（`playbook.yaml`） |
| Investigator / Executor / Writer / Verifier | 四类子代理角色 |
| GuidedManual | 链路结局：MCP 不能写，引导用户在对应插件 UI 完成变更 |
| hostApp | `detectHostApp()` 结果（`vscode` / `cursor` / `kiro` / …），隔离 registry 目录 |
