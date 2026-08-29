# 05 · 运维专属 UI

## 1. 信息架构

现行壳是 **Cline 式单 Chat WebviewView**：Activity Bar 只有一个对话视图，没有 Sessions / Approvals / Skills / Models 四个 TreeView。历史是模态，设置是独立 Webview，看板是可选宽表。

```text
Activity Bar: AT Ops Agent
  对话 Chat     WebviewView（唯一主表面：PlaybookHeader + Transcript + ApprovalBar + Composer）
  （无 Sessions/Approvals/Skills/Models TreeView）

命令/标题栏：newSession、toggleHistory、pickPlaybook、exportReport、abort、openSettings
历史：HistoryOverlay 模态
设置：独立 Settings Webview（模型 / 能力 / MCP / 会话）
看板：atOpsAgent.openBoard 宽表（可选，非主路径）
```

对话视图线框（`src/webview-chat/components/ChatApp.vue`）：

```text
┌─ ⚡ AT Ops Agent  [+][历史][Playbook][导出][停][⚙] ─┐
│ ▍pb.incident · 调查中                               │  PlaybookHeader
├─────────────────────────────────────────────────────┤
│ 你: 线上网关 5xx 突增，帮我查                         │  user well
│ Agent: **结论**（流式也走 MarkdownBlock）               │  MarkdownBlock
│ ┌ 🔧 工具卡 ─ read ✓ ────────────────────────────┐ │  ToolCallCard
│ └────────────────────────────────────────────────┘ │
│ ┌ 子代理 ─────────────────────────────────────────┐ │  SubagentBoard
│ │ investigator · 只读                            │ │  → SubagentInspector
│ └────────────────────────────────────────────────┘ │
│ 审批请求 brief-…  批准 · 09:12:03                  │  transcript 留痕
├─────────────────────────────────────────────────────┤
│ ⚠ 待审批 回滚 api-gateway  [简报] [批准] [拒]      │  ApprovalBar
│ 输入…  @资产  /playbook                             │  Composer
└─────────────────────────────────────────────────────┘
  HistoryOverlay（toggleHistory）盖在 Chat 上
```

空会话渲染 `WelcomeState`，不走 transcript 空提示。思考块（`kind:'thinking'`）恒折叠，只露出 `UntrustedQuotes`。`contributes` 见 `package.json`（id 前缀 `atOpsAgent.*`）。

## 2. 设计 token

文件：`src/webview-chat/ops-tokens.css`

```css
:root {
  --ops-bg: var(--vscode-sideBar-background);
  --ops-fg: var(--vscode-foreground);
  --ops-border: var(--vscode-panel-border);
  --ops-healthy: var(--vscode-testing-iconPassed, #3fb950);
  --ops-warn: var(--vscode-editorWarning-foreground, #d29922);
  --ops-crit: var(--vscode-testing-iconFailed, #f85149);
  --ops-pending: var(--vscode-descriptionForeground);
  --ops-read: var(--ops-healthy);
  --ops-write: var(--ops-warn);
  --ops-exec: var(--ops-crit);
  --ops-density: 6px;
  --ops-mono: var(--vscode-editor-font-family);
}
```

深色为默认（跟随 IDE）。状态色只用于健康/风险/结论，不用作装饰。圆角 ≤ 6px，避免消费级 chatbot 气泡感。命令与日志块用等宽 + 深底。

## 3. 组件规范

所有组件 props 与 host 消息的 TypeScript 以 [`src/protocol/host-protocol.ts`](../src/protocol/host-protocol.ts)（schema 副本 [`docs/schemas/host-protocol.ts`](schemas/host-protocol.ts)）为准。路径均在 `src/webview-chat/`（**没有** `packages/webview-chat`）。

| 文件 | 职责 | 关键 props / 数据 | Host 消息 |
|------|------|-------------------|-----------|
| `ChatApp.vue` | 主壳：header + 欢迎/transcript + dock | store | hydrate |
| `WelcomeState.vue` | 空会话欢迎 + 建议卡 | sessions / suggestions | — |
| `ChatTranscript.vue` | 消息/卡片；流式 assistant 走 MarkdownBlock | `items[]` | `transcript/append`, `transcript/patch` |
| `MarkdownBlock.vue` | markdown-it `html:false`；`streaming` 时不高亮 | `source`, `streaming?` | — |
| `ToolCallCard.vue` | 单次工具：名、risk、耗时、截断、错误码 | `call` | `tool/start\|update\|end` |
| `ApprovalBar.vue` | 会话审批；9 要素展开 | `brief`, `dualConfirmHint` | `approval/request` → `approval/respond` |
| `SubagentBoard.vue` | 子代理卡片组 | `agents[]` | `subagent/upsert` |
| `SubagentInspector.vue` | 子代理详情 overlay（ChatApp Teleport） | inspected card | `subagent/abort` |
| `HistoryOverlay.vue` | 历史会话模态 | `sessions[]` | `session/switch`, `history/toggle` |
| `EvidenceNote.vue` | 证据便签三态 | `note` | 随 transcript |
| `MetricSnippet.vue` | 单指标 + canvas 火花图 | `title, points[]` | 证据 kind=metric |
| `LogViewer.vue` | ANSI 剥离 + 关键词 span；超 64KB 打开编辑器 | `uri?`, `text?`, `truncated` | 大输出只传 uri |
| `HostSessionChip.vue` | 目标主机/终端 | `pluginId, label` | 工具参数解析后 |
| `PipelineStatus.vue` | Jenkins 构建点 | `job, build, result` | 证据 kind=pipeline |
| `ModelSelector.vue` | Composer 模型切换 | `models, current` | `model/set` |
| `PlaybookHeader.vue` | 当前 playbook / 阶段 | `playbook` | `playbook/stage` |
| `PlaybookPicker.vue` | 选链路 | `playbooks, active` | `playbook/start` |
| `Composer.vue` | 输入、@资产、steer/followUp | `mode: steer\|followUp` | `chat/prompt` |
| `UntrustedQuotes.vue` | 不可信引用警示（思考块唯一可见面） | `quotes[]` | `thinking/delta` |

思考过程 **不是**独立 `ThinkingTrace` 组件：CoT 不展开。能力清单在 **Settings Webview**（`src/webview-settings/`），不在 Chat TreeView。

### 3.1 ApprovalBar 双弹窗文案

write/exec 在 Agent 确认后仍可能弹出插件模态。按钮旁固定提示：

> 批准后插件仍可能再次确认。插件弹窗不是本次批准。

对已知必弹插件确认的工具（Terminal `run_remote_command`、JumpServer exec/write），Agent 侧可配置 `sessionApproval: 'brief-only'`（展示简报但一键后直接 invoke，仍写 approvalToken），避免连续两张几乎相同的「是否执行」。**第一期默认双确认**；设置 `atOpsAgent.approval.dedupePluginModal` 默认 false。

### 3.2 ToolCallCard 截断

result 预览最多 4KB。`truncated` 显示「已截断 · 在编辑器打开」。禁止把 256KB 日志 postMessage 进 webview。

### 3.3 SubagentCard 状态

`queued | running | ok | degraded | failed | aborted`。权限徽标：只读灰、可写琥珀+简报号。展开：工具列表、思考、中止。

## 4. 技术实现

| 项 | 选择 |
|----|------|
| 框架 | Vue 3.5 + Pinia |
| 构建 | 独立 esbuild/vite → 单文件 JS，extension 用 `asWebviewUri` |
| CSP | `default-src 'none'; script-src nonce; style-src nonce 'unsafe-inline'`（VS Code 主题注入需要） |
| Markdown | markdown-it `html:false`；highlight.js core + javascript/json/bash/yaml/python，仅 finalize 后高亮。不引入 mermaid / shiki / KaTeX |
| 列表 | ChatTranscript 超 80 条时块级窗口（非虚拟滚动库） |
| 流式 | host 合批 30–50ms；流式也 md.render，高亮只在 `streaming!==true` |
| 火花图 | canvas 折线，不引入 echarts |
| 状态 | webview 无真源；`getState` 只存滚动位置与草稿 |
| i18n | `package.nls.json` + webview 启动包 |

对齐 At-Database 的 token 映射与 At-jenkins 的 CSP/nonce/json script 防 XSS（`<` → `\u003c`）。

## 5. 非 Chat 表面（不是 TreeView）

没有 Sessions / Approvals / Skills / Models TreeView。对应能力的入口：

| 表面 | 数据 | 入口 |
|------|------|------|
| Chat WebviewView | `SessionStore` hydrate | 唯一主表面 |
| HistoryOverlay | `snapshot.sessions` | `atOpsAgent.toggleHistory` |
| Settings Webview | `settings/hydrate`（模型 / 能力 / MCP / 会话） | `atOpsAgent.openSettings` |
| Board Webview | timeline 宽表 | `atOpsAgent.openBoard`（可选） |

能力空态仍说明「安装 AT Terminal / Grafana 等插件后将自动出现，无需配置 MCP」，只是画在设置页而不是树节点。

## 6. 无障碍与密度

- 全部状态不只靠颜色（图标 + 文字）
- 键盘：批准/拒绝、中止子代理、发送/排队
- 高对比跟随 VS Code 主题

## 7. 端到端故事（验收脚本）

### 7.1 线上 5xx

1. 打开侧边栏，输入「网关 5xx 突增」。
2. PlaybookHeader → pb.incident，Selecting 自动 select grafana。
3. 三张 Investigator 卡片并行；证据便签三态出现。
4. 无日志时结论标记 hypothesis，不出现「根因是」。
5. 建议回滚 → ApprovalBar 九要素；批准后 Executor 卡片；插件可能二次确认。
6. Verifier 只读；Writer 产出 troubleshooting-report 并打开预览。
7. 看板时间线能看到同一事故。

### 7.2 新装 At-Nacos

1. Agent 已开，Settings 能力页无 nacos。
2. 安装并激活 At-Nacos，≤3s 内设置页能力列表出现（watch 兜底 3s）。
3. 用户问「xx 配置是谁在听」→ 自动/半自动 select at.nacos，无需 mcp.json。
4. 未开 `allowBackgroundAccess` 时工具错误原文引导去插件 UI，Agent 不伪造 instanceId。
