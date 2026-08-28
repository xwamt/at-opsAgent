# 05 · 运维专属 UI

## 1. 信息架构

```text
Activity Bar: AT Ops Agent
  对话 Chat            WebviewView（主）
  会话 Sessions        TreeView
  能力插件 Capabilities TreeView（默认展开）
  审批 Approvals       TreeView + badge
  技能 Skills          TreeView（默认折叠）
  模型 Models          TreeView（默认折叠）

Panel: Ops 看板
  事故 / 任务          Webview（宽表：时间线、多主机）

设置: VS Code Settings + 命令打开 Models 全页 webview（OAuth / 自定义 provider）
```

对话视图线框：

```text
┌─ ⚡ AT Ops Agent     [新会话] [Playbook] [⚙] ─┐
│ ▍pb.incident · 调查中   ⏱ 09:12   [升级]      │  PlaybookHeader
│  Triage✓  Evidence●  Synthesize  Report       │  阶段 chips
├───────────────────────────────────────────────┤
│ 你: 线上网关 5xx 突增，帮我查                   │
│ ▸ 思考过程（3 步）                             │  ThinkingTrace
│ ┌ 🔧 ops_select_tools ─ read ✓ 12ms ───────┐ │  ToolCallCard
│ └───────────────────────────────────────────┘ │
│ ┌ 子代理 (3) ────────────────────────────────┐ │  SubagentBoard
│ │ 🔍 metrics ●  5/12  只读                   │ │
│ │ 🔍 logs    ●  2/12  只读                   │ │
│ │ 🔍 changes ✓  Jenkins #482                 │ │
│ └────────────────────────────────────────────┘ │
│ 📌 09:05 5xx 0.2%→14%  ▁▂▇█▆   confirmed      │  MetricSnippet
├───────────────────────────────────────────────┤
│ ⚠ 待审批 回滚 api-gateway  [简报] [批准] [拒] │  ApprovalBar
├───────────────────────────────────────────────┤
│ 输入…  @资产  /playbook                       │  Composer
│ qwen3-max ▾ · 只读模式 ▾ · at.grafana ✓       │  状态条
└───────────────────────────────────────────────┘
```

`contributes` JSON 草案与 context key 见调研 06 §A.2，实现时原样迁入 `package.json`（id 前缀 `atOpsAgent.*`）。

## 2. 设计 token

文件：`packages/webview-chat/src/ops-tokens.css`

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
  --ops-density: 4px; /* 高信息密度间距基数 */
  --ops-mono: var(--vscode-editor-font-family);
}
```

深色为默认（跟随 IDE）。状态色只用于健康/风险/结论，不用作装饰。圆角 ≤ 6px，避免消费级 chatbot 气泡感。命令与日志块用等宽 + 深底。

## 3. 组件规范

所有组件 props 与 host 消息的 TypeScript 以 [`docs/schemas/host-protocol.ts`](schemas/host-protocol.ts) 为准。下面是职责与关键字段。

| 组件 | 职责 | 关键 props | Host 消息 |
|------|------|------------|-----------|
| `ChatTranscript` | 虚拟列表渲染消息/卡片 | `items[]`, `streamingId` | `transcript/append`, `transcript/patch` |
| `ThinkingTrace` | 折叠思考 | `steps`, `untrustedQuotes` | 来自 `thinking_*` 事件 |
| `ToolCallCard` | 单次工具：名、risk、耗时、截断、错误码 | `name, risk, status, durationMs, truncated` | `tool/start\|update\|end` |
| `ApprovalBar` | 会话审批；9 要素展开 | `brief`, `dualConfirmHint` | `approval/request` → `approval/respond` |
| `IncidentTimeline` | 看板/对话内时间线 | `events[]` | `timeline/upsert` |
| `SubagentBoard` | 子代理卡片组 | `agents[]` | `subagent/upsert`；`subagent/abort` 上行 |
| `PluginCapabilityList` | 也可嵌入对话头部 | `providers` | 与 TreeView 同源 |
| `MetricSnippet` | 单指标 + canvas 火花图 | `title, from, to, points[]` | 证据便签 kind=metric |
| `LogViewer` | 有界日志；超 64KB 点「在编辑器打开」 | `uri?`, `text?`, `truncated` | 大输出只传 uri |
| `HostSessionChip` | 目标主机/终端 | `pluginId, label, connected` | 工具参数解析后 |
| `PipelineStatus` | Jenkins 构建点 | `job, build, result` | 证据便签 kind=pipeline |
| `ModelSelector` | 状态条/设置 | `models, current` | `model/set` |
| `SkillPicker` | `/skill` | `skills[]` | `skill/run` |
| `PlaybookPicker` | 标题栏 | `playbooks, active` | `playbook/start` |
| `Composer` | 输入、@资产、排队 | `mode: steer\|followUp` | `chat/prompt` |

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
| Markdown | markdown-it + 消毒；mermaid 动态 import |
| 列表 | 块级虚拟列表（按消息，不按 token） |
| 流式 | host 合批 30–50ms；未完成消息 finalize 后再高亮 |
| 火花图 | canvas 折线，不引入 echarts |
| 状态 | webview 无真源；`getState` 只存滚动位置与草稿 |
| i18n | `package.nls.json` + webview 启动包 |

对齐 At-Database 的 token 映射与 At-jenkins 的 CSP/nonce/json script 防 XSS（`<` → `\u003c`）。

## 5. TreeView 行为

| 视图 | 数据 | 刷新 |
|------|------|------|
| Sessions | SessionManager 索引 | 会话创建/关闭 |
| Capabilities | HubHost.getProviders | watch |
| Approvals | orchestrator 待批队列 | 简报增删；`TreeView.badge` |
| Skills | ResourceLoader | 启动 + 用户目录 watch |
| Models | ModelRuntime | 设置保存 |

Capabilities 空态 welcome：说明「安装 AT Terminal / Grafana 等插件后将自动出现，无需配置 MCP」。

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

1. Agent 已开，Capabilities 无 nacos。
2. 安装并激活 At-Nacos，≤3s 内树节点出现（watch 兜底 3s）。
3. 用户问「xx 配置是谁在听」→ 自动/半自动 select at.nacos，无需 mcp.json。
4. 未开 `allowBackgroundAccess` 时工具错误原文引导去插件 UI，Agent 不伪造 instanceId。
