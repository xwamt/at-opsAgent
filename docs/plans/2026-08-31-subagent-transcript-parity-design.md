# 子代理 Transcript parity 设计说明（对标 Kilo Sub-Agent Viewer）

> **日期：** 2026-08-31  
> **状态：** 已实现  
> **关联计划：** [2026-08-31-subagent-transcript-parity.md](./2026-08-31-subagent-transcript-parity.md)

---

## 1. 问题陈述

用户期望子代理 Inspector 与主代理 Chat 具备一致的呈现：**自然语言输出（流式 Markdown）、思维链、工具调用卡**，而非当前的「步骤条 + 纯文本日志 + 终态 summary」。

### 1.1 现状（代码实况）

子代理 inner session（`subagent-session.ts`）与主 session **刻意隔离**：

| pi 事件 | 主代理 | 子代理 runtime | 子代理 UI 可见 |
|---------|--------|----------------|----------------|
| `text_delta` | `transcript/patch appendText` → 流式 Markdown | 仅更新 `lastAssistantText`，**不 emit** | 终态 `latest`（≤3200 字） |
| `thinking_delta` | `thinking/delta` → `ThinkingBlock` | `emitProgress('正在深度思考…')` | 一行 activity 字符串 |
| `tool_execution_*` | `tool/start\|end` → `ToolCallCard` | step 标题 + log 行 | 无 preview/ANSI/风险色 |

Inspector（`SubagentInspector.vue`）三 Tab：**Steps / Logs / Overview** — 是进度仪表盘，不是 mini-chat。

协议 `SubagentCard` 有 `steps[]`（含 `type:'thinking'`），但 runtime **从未创建 thinking 类型 step**；`toolCalls` 仅为 `{used,max}` 预算计数，不是工具列表。

### 1.2 Kilo Sub-Agent Viewer 参照

Kilo（OpenCode server 重建版）的 Sub-Agent / Agent Manager 能力：

- 每个子代理有**独立会话视图**，可看到与主会话同构的消息、工具、终端输出  
- 多 tab 切换并行子代理，侧边 panel 不遮挡主 transcript 全文  
- 工具执行带命令与输出，非单行 step 标题  

**我们应学：** 子代理 inner loop 在 Inspector 内以 **与主 agent 相同的组件** 渲染（Markdown / Thinking / ToolCall）。  
**不应抄：** worktree 并行、OS 沙箱、Cloud 双向接管、IM 批准。

---

## 2. 目标与非目标

### 目标

1. Inspector 默认 Tab 为 **「对话」**，渲染子代理 mini-transcript（assistant + thinking + tool）  
2. 运行中支持 **流式 NL 输出** 与 **折叠思维链**（与主 agent 相同 UX 定稿：默折叠可展开）  
3. 工具调用复用 **`ToolCallCard`**（命令栏 + TerminalViewer + 风险色 + copy）  
4. 主 transcript 仍保持 **`SubagentBoard` 摘要卡**，不灌入 inner 细节（避免主视图被 N 个子代理刷屏）  
5. 协议与持久化：子代理 transcript 随 session 可恢复（至少终态完整；运行中可内存态）

### 非目标

- 不把子代理 inner 事件写入主 `TranscriptItem[]`（架构边界保持）  
- 不做子代理独立 VS Code editor tab / 终端面板（Kilo Agent Manager 全量）  
- 不改变阻塞式 dispatch 语义（工具结果仍一次性回主 agent）  
- 不渲染子代理 CoT 到主 transcript（安全边界同主 agent thinking 策略）

---

## 3. 方案对比

### 方案 A：SubagentCard 内嵌 `transcript[]`（推荐）

在 `SubagentCard` 增加 `transcript: SubagentTranscriptItem[]`，结构与主 `TranscriptItem` 子集对齐。Runtime 在 `emitProgress` 时增量更新 transcript；host 全量 `subagent/upsert` 广播；Inspector 用 `SubagentTranscript.vue` 复用现有组件渲染。

| 优点 | 缺点 |
|------|------|
| Webview 复用 ThinkingBlock/ToolCallCard/MarkdownBlock | 卡片 payload 变大，需合批 |
| 单事件通道，与现有 `subagent/upsert` 一致 | 需扩展 sessionStore 持久化 |
| 测试边界清晰（纯函数 build transcript） | |

### 方案 B：平行 evt 通道（`subagent/thinking` 等）

仿主 agent 发 `subagent/tool/start`、`subagent/transcript/patch`，webview store 按 taskId 归并。

| 优点 | 缺点 |
|------|------|
| 与 runtimeEvents 对称 | 协议面翻倍；store 两套归并逻辑 |
| 细粒度更新 | 并行 4 子代理时 evt 风暴 |

### 方案 C：Inspector 打开时拉取 JSONL 快照

子 session 写独立 JSONL，Inspector lazy fetch。

| 优点 | 缺点 |
|------|------|
| 卡片 payload 小 | 无法实时流式；实现复杂 |

**推荐方案 A**：在现有 `SubagentCard` 上扩展 `transcript[]`，host 侧 40ms 合批（复用 StreamBatcher 模式），Inspector 换 Tab 为 Transcript-first。

---

## 4. 架构设计

### 4.1 协议扩展

```typescript
/** 与 TranscriptItem 对齐的子集；不含 user/subagents/evidence/approval */
export type SubagentTranscriptItem =
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; ts?: number }
  | { kind: 'thinking'; id: string; steps: string[]; durationMs?: number; streaming?: boolean }
  | { kind: 'tool'; id: string; call: ToolCallView };

export type SubagentCard = {
  // ...existing fields...
  /** Mini-transcript：Inspector「对话」Tab 数据源 */
  transcript?: SubagentTranscriptItem[];
};
```

`OpsSubagentEvent` 同步增加 `transcript?: SubagentTranscriptItem[]`。

### 4.2 Runtime 数据捕获（`subagent-session.ts`）

| pi 事件 | 写入 transcript |
|---------|-----------------|
| `message_start` (assistant) | append `{ kind:'assistant', streaming:true, text:'' }` |
| `text_delta` | patch assistant `appendText`；emitProgress 携带 transcript |
| `thinking_start` / `thinking_delta` | append/patch `{ kind:'thinking', steps[], streaming:true }` |
| `thinking_end` | finalize thinking `durationMs`, `streaming:false` |
| `tool_execution_start` | append `{ kind:'tool', call:{ status:'running', ... } }` |
| `tool_execution_end` | patch tool call preview/status/durationMs（从 execute 结果取） |

工具 preview 来源：在 `executeBusinessTool` 返回路径记录 `{ toolCallId → result preview }`，`tool_execution_end` 时合并。

合批：`emitProgress` 改为最多 40ms 一次（与主 session StreamBatcher 对齐），避免 webview 卡顿。

### 4.3 Host 层

- `SubagentCardPatch` 增加 `transcript?`  
- `chatService.onSubagentEvent`：`latest` 仍用于 Board 一行摘要；**不再**用 `currentActivity` 覆盖 streaming 文本  
- `sessionStore`：持久化 `transcript` 终态（running 时可选只存内存，reload 后显示终态 summary 兜底）  
- `StreamBatcher` 或 subagent 专用 batcher：`subagent/upsert` 合批

### 4.4 Webview 层

新增 `SubagentTranscript.vue`：

- 输入：`items: SubagentTranscriptItem[]`, `streaming: boolean`, `pinnedScroll`  
- 渲染：复用 `MarkdownBlock`、`ThinkingBlock`、`ToolCallCard`（与 `ChatTranscript.vue` 同分支）  
- 粘底：复用 `stickyTailSignature` / ResizeObserver（BUG-1 已落地）  
- **不**启用 >250 虚拟化（Inspector 高度有限，单 subagent 条目可控）

`SubagentInspector.vue` Tab 改造：

| Tab | 内容 |
|-----|------|
| **对话**（默认） | `SubagentTranscript` |
| **概览** | 保留现有 overview（risk/quota/tools） |
| ~~Steps~~ | 删除或降级为 overview 内折叠 |
| ~~Logs~~ | 删除；raw logs 可在 overview「调试日志」折叠 |

`SubagentBoard.vue`：运行中显示 assistant 最后一行 preview（从 transcript 末条 assistant 截取 80 字），替代 `currentActivity` 技术字符串。

### 4.5 安全

- 子代理 thinking 同样走 `ThinkingBlock` 默折叠；`UntrustedQuotes` 若 future 有则常显  
- transcript 中 tool preview 走现有 4KB 截断 + 脱敏纪律  
- 不把 subagent transcript 注入主 agent prompt（dispatch 结果仍仅 summary JSON）

---

## 5. 验收标准

### 自动

- `test/subagent-transcript.test.ts`：runtime 事件 → transcript 归并纯函数  
- `test/webview-chat.test.ts`：SubagentTranscript 渲染结构、Board preview  
- 全量 vitest 绿

### 手动（280px 侧边栏）

1. 派发 investigator 子代理 → 打开 Inspector → **对话 Tab** 可见流式 Markdown  
2. 模型思考时 → 折叠 ThinkingBlock + live timer  
3. 工具执行 → ToolCallCard 含命令/输出/风险色，可 expand/copy  
4. 多子代理 ‹ 1/N › 切换，各自 transcript 独立  
5. 主 transcript 仍只有 SubagentBoard 摘要卡，不被 inner 细节淹没  

---

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `subagent/upsert` payload 过大 | 40ms 合批；tool preview 4KB cap；transcript 条目上限 500 |
| 工具 preview 在 subagent 路径缺失 | executeBusinessTool 统一写 result cache |
| 重载后会话丢 running transcript | 终态 persist；running 丢失去 summary 兜底 + 文案提示 |
| 与主 agent 组件耦合 | SubagentTranscript 薄包装，不 fork 组件逻辑 |

---

*设计评审通过后，按 [实现计划](./2026-08-31-subagent-transcript-parity.md) 施工。*
