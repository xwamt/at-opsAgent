# ADR-003 · 自建 WebviewView，不用 Copilot Chat 主入口

## 状态

Accepted

## 背景

VS Code 提供 Chat Participant / Language Model Tools / Language Model API。运维 Agent 需要：自有系统提示、审批条、子代理卡片、证据时间线、VS Code **与 Cursor** 双兼容。

## 决策

**主 UI = `contributes.views` 里 type=webview 的侧边栏 + 底部 Panel 看板。**

不采用 Chat Participant 做主入口，因为：

1. 无法覆盖 Copilot agent mode 系统提示（运维红线无法强制）。
2. Cursor 不提供这套 API。
3. 无法嵌入 ApprovalBar / SubagentBoard / IncidentTimeline 这类一等运维组件。

可选后期：薄 `@atops` Chat Participant 把文本转发进同一 Orchestrator，仅服务 Copilot 重度用户，**不**作为架构主路径。

Webview 必须无状态化：会话真源在 extension host；隐藏后 `resolveWebviewView` 再水化。不把 `retainContextWhenHidden` 当主策略（官方标明高内存）。

技术栈：Vue 3.5 + Pinia + 自研 `ops-tokens.css` 映射 `--vscode-*`，对齐 At-Database，而不是 pi-chat 的 vanilla TS。原因是运维组件数量与状态（证据板、审批、多子代理）超过 coding chat。
