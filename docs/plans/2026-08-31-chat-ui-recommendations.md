# Chat UI 优化建议（对照 Kilo / OpenCode / Claude Code / Cline / Codex）

> **日期：** 2026-08-31  
> **范围：** `src/webview-chat/` 前端 Chat 对话 UI  
> **方法：** 静态代码审查 + 竞品公开 UI 模式对照（Kilo Code、OpenCode V2、Claude Code / Cline、OpenAI Codex）  
> **关联：** [02-ui.md](../reviews/round2/02-ui.md)、[06-ux-features.md](../reviews/round2/06-ux-features.md)、[2026-08-31-chat-ui-optimization.md](./2026-08-31-chat-ui-optimization.md)  
> **实施状态：** ✅ 已于分支 `feat/chat-ui-optimization-2026-08-31` 全部落地（BUG-1 + OPT-1…OPT-22），756/756 vitest 通过

---

## 1. 背景与目标

at-opsAgent Chat UI 的底层工程质量（协议、Pinia store、token 体系、组件拆分、单测）已达产品级。与 Kilo / OpenCode 等开源项目的差距，主要集中在三类**交互设计**问题：

1. **思维链与主 transcript 的空间竞争** — 折叠策略、计时感知、安全警示可见性不一致  
2. **窄边栏（~300px）dock 区空间分配** — 审批栏 + Composer 工具栏挤占 transcript  
3. **运维取证信息密度不足** — 时间戳、成本、审批审计链弱于竞品基线  

另有一个 **P0 前端 Bug**：用户已滚到最底部时，Agent 流式输出不会持续跟随，视口脱离最新消息。

**优化目标：**

- 值班/on-call 场景下，300px 侧边栏内完成「看结论 → 复制 → 审批 → 追问」全流程  
- 长巡检（数十工具卡 + 思维链）不遮挡主结论  
- 会话内可独立回答「何时、谁、批准/执行了什么」  

---

## 2. 设计原则（全局约束）

| 原则 | 说明 |
|------|------|
| **Token 纪律** | 颜色/字号/间距严格复用 `ops-tokens.css`，禁止硬编码 |
| **安全边界** | Markdown `html:false`；不可信引用（`UntrustedQuotes`）永不进富文本高亮管线 |
| **渐进披露** | 思维链、工具卡、审批九要素、只读工具组 — **默认折叠，用户可展开** |
| **零重型依赖** | 不引 ECharts / Mermaid / Shiki；highlight.js core 子集即可 |
| **窄边栏优先** | 所有布局决策以 280–320px 宽 × 600px 高为验收基准 |

### 2.1 思维链（CoT）产品定稿

> **用户确认：** 思维链 **默认折叠，但允许用户点击展开** 查看完整推理步骤。

| 维度 | 定稿 |
|------|------|
| 默认态 | 折叠单行卡片：图标 + 「思考中 / 已思考」+ **实时/最终时长 badge** |
| 展开态 | 渲染 steps Markdown（`max-height: 240px` 内滚）+ 逐步 copy |
| 安全警示 | `UntrustedQuotes` **折叠时也常驻可见**（放在 card 头部下方或 body 外） |
| 结论模式 | `conclusionMode=true` 时隐藏整个 ThinkingBlock（与 Claude Focus view 一致） |
| 不做 | 自动展开长思维链；CoT 内容默认铺满 transcript |

**与竞品对齐：**

- **Claude Code**：`Thought for 3.2s` + 可选展开 → 我们学「时长常显 + 可选展开」，不学默认展开  
- **Kilo**：Sub-Agent / thinking 折叠不占主视口 → 我们学折叠纪律  
- **OpenCode / 原安全设计**：不可信引用警示不可被折叠藏住  

---

## 3. P0 · Bug 修复

### BUG-1：滚到底部时不跟随 Agent 流式输出

**现象：** 用户手动滚到 transcript 最底部（或刚发送消息后），Agent 持续输出时视口不再粘底，新内容在视口下方滚动，需手动点「回到底部」。

**根因分析（`ChatTranscript.vue`）：**

```ts
// 当前 watch 依赖项
watch(
  () => [store.items.length, store.streaming ? Date.now() : 0],
  async () => { ... scrollToBottom(false); }
);
```

| # | 根因 | 说明 |
|---|------|------|
| R1 | **`items.length` 不变时不触发** | 流式主路径是 `transcript/patch` + `appendText`，同一条 assistant 增量追加，`items.length` 不变 → watch 不执行 |
| R2 | **`Date.now()` 非响应式** | 只在 getter 求值时返回新值，Vue 不会在 streaming 期间因时间流逝而重算 |
| R3 | **DOM 高度滞后** | `MarkdownBlock` / `ToolCallCard` / `TerminalViewer` 在 `nextTick` 后才撑高，`scrollToBottom` 执行过早 |
| R4 | **虚拟滚动估高误差** | `EST_HEIGHT = 120` 固定值，`padBottom` 与真实高度偏差导致 `scrollHeight` 不准 |
| R5 | **粘底判定滞后区间** | `distanceFromBottom > 80` 置 `userScrolledUp=true`，`< 30` 才清除；内容增长时用户实际在底部但未被识别 |

**修复方案：**

1. **新增粘底签名（sticky tail signature）** — 在 `store-helpers.ts` 增加纯函数：

```ts
export function stickyTailSignature(items: readonly TranscriptItem[]): string {
  // 拼接：末条 assistant/thinking/tool 的 id + text.length + status + steps.length
}
```

watch 改为依赖 `stickyTailSignature(store.items)` + `store.streaming`，覆盖 patch 增量。

2. **ResizeObserver 兜底** — 对 `.transcript` 内最后一个 message 节点监听 `contentRect` 变化；若 `!userScrolledUp` 则 `requestAnimationFrame(() => scrollToBottom(false))`。

3. **双 rAF 粘底** — `scrollToBottom` 内连续两次 `requestAnimationFrame` 再设 `scrollTop = scrollHeight`，覆盖 markdown 重排。

4. **收紧粘底阈值** — 将 `userScrolledUp` 改名为 `isPinnedToBottom`（语义反转）：`distanceFromBottom <= 4` 视为粘底；仅当 `!isPinnedToBottom` 时跳过自动滚动。

5. **虚拟滚动改进（可 P1 跟进）** — 粘底时强制 `range.end = renderItems.length` 且 `padBottom = 0`（最后一屏不垫假高度）。

**涉及文件：**

- `src/webview-chat/components/ChatTranscript.vue`
- `src/webview-chat/store-helpers.ts`
- `test/webview-chat.test.ts`（`stickyTailSignature` 单测 + 粘底逻辑 mock）

**验收标准：**

- [ ] 发送消息后，transcript 全程粘底，无需手动滚动  
- [ ] 流式 assistant 文本、thinking delta、tool update、terminal 输出均触发粘底  
- [ ] 用户上翻 >80px 后停止粘底，出现「回到底部」胶囊；滚回底部后恢复粘底  
- [ ] 虚拟滚动开启（>250 条）时长会话粘底行为一致  
- [ ] `prefers-reduced-motion` 下粘底为 instant scroll，不用 smooth  

---

## 4. P0 · 体验优化（高优先级）

### OPT-1：思维链默认折叠 + 可展开 + 安全警示常显

**现状问题：**

- `ThinkingBlock.vue` 已 `expanded = false`，但折叠头**思考进行中不显示 live 计时**（badge 仅在 `durationMs != null` 时出现）  
- `UntrustedQuotes` 放在 `v-if="expanded"` 内，折叠时安全警示不可见  
- `store-helpers.ts` 注释写「CoT 恒隐藏」，与「默折叠可展开」产品定稿冲突  

**改造要点：**

| 项 | 改法 |
|----|------|
| 折叠头 live timer | 思考中始终显示 `elapsedMs` badge（已有 timer，绑定 UI 即可） |
| UntrustedQuotes | 移到 `thinking-card__head` 下方，**与 expanded 无关**，折叠也渲染 |
| 展开区 | 保持 `max-height: 240px; overflow-y: auto`；Markdown + copy |
| 文档/注释 | 更新 `visibleUntrustedQuotes` / `thinkingMetaVisible` 注释，明确「默折叠可展开」 |
| showThinking 默认 | 保持 `true`（显示折叠卡片），结论模式另关 |

**涉及文件：** `ThinkingBlock.vue`、`store-helpers.ts`、`i18n.ts`、`test/webview-chat.test.ts`

**验收：**

- [ ] 长思维链默认只占一行；点击展开后内滚，不撑爆视口  
- [ ] 思考中折叠头显示「思考中 · 3.2s」动态递增  
- [ ] 有 untrustedQuotes 时，折叠态也显示警示条  
- [ ] 结论模式隐藏 ThinkingBlock  

**竞品参照：** Claude Code `Thought for Xs` + Kilo 折叠纪律

---

### OPT-2：Composer 窄边栏布局重构

**现状问题：** 单行塞入 ModelSelector + @资产 + Playbook + 结论模式 + 水位条 + Cancel/Stop/Send，300px 下 inevitable 换行，流式三按钮误触风险高。

**改造要点：**

1. **Status Strip（参照 OpenCode status line）** — 从 Composer 工具栏抽出，置于 transcript 顶栏（tstrip 下方）或 dock 顶：

```
ctx ▓▓▓░ 43% · 15k in · 2k out · $0.02
```

数据已有：`UsageView.contextUsed/contextWindow/inputTokens/outputTokens/costUsd`。

2. **Composer 工具栏精简** — 保留：输入框 + ModelSelector + Send/Steer/Stop；次要动作收入 `⋯` overflow menu（@资产、Playbook、结论模式）。

3. **流式按钮组** — 流式时：Steer + Stop（合并 Cancel 语义或降为 secondary）；非流式：Send / Follow-up。

**涉及文件：** `Composer.vue`、`ChatApp.vue` 或 `ChatTranscript.vue`、`ops-tokens.css`、`store-helpers.ts`（`formatCompactUsage`）、`i18n.ts`

**验收：**

- [ ] 280px 宽下 Composer 主操作区（输入 + 模型 + 发送）单行不换行  
- [ ] costUsd 常显（不仅 hover）  
- [ ] 流式时主按钮不超过 2 个  

**竞品参照：** OpenCode `ctx ▓▓▓░ 43% | 15k tok | $0.02`

---

### OPT-3：ApprovalBar 紧凑化，避免挤压 Composer

**现状问题：** `max-height: 45vh` + 九要素展开，在 ~600px 高侧边栏中可占 270px+，Composer 被顶出视口。命令块为裸 `<pre>` + 整段 copy。

**改造要点：**

1. **默认单行摘要** — 折叠态只显示：`⚠ 待审批 · exec · 目标名 · [查看简报] [批准] [拒绝]`  
2. **九要素按需展开** — 展开时用 overlay / bottom-sheet，或 `max-height: min(30vh, 240px)`  
3. **空要素折叠** — 空白字段合并为「未提供（N 项）」单行，消除成排「—」  
4. **命令块升级** — shell 高亮（复用 highlight.js bash）+ **逐行 copy** + 超 3 行折叠  
5. **Esc 显式拒绝** — 参照 Codex：Esc = Reject（可选 P1）

**涉及文件：** `ApprovalBar.vue`、`lib/approval-brief.ts`、`ops-tokens.css`、`test/approval-loop.test.ts`

**验收：**

- [ ] 审批 pending 时 Composer 输入框始终可见（280×600 基准）  
- [ ] 命令可逐行复制；exec 命令有着色  
- [ ] 空要素不成排破折号  

**竞品参照：** Kilo PermissionDock 紧凑态、Codex 审批 overlay

---

## 5. P1 · 体验增强

### OPT-4：复制动线发现性

**现状：** 功能已补全（消息/代码块/工具/审批），但 copy 按钮普遍 `opacity: 0` 直到 hover。

**改造：**

- Assistant 消息头 copy 图标**常显**（低对比度，`opacity: 0.45`，hover 升至 1）  
- 代码块右上角 copy + **语言标签**常显  
- 可选：slash `/copy` 复制最后一条 assistant（参照 Kilo `/copy-session`、Claude `/copy`）

**涉及文件：** `ChatTranscript.vue`、`MarkdownBlock.vue`、`ops-tokens.css`、`Composer.vue`（slash 检测）

---

### OPT-5：审批决策 audit 留痕（Codex 式）

**现状：** transcript approval 行展示 `targetLabel ?? briefId`，缺风险级别、命令摘要、完整时间；内部 ID 可能外露。

**改造：**

1. host 在 approve/reject/timeout 后追加 `system` 或 `notice` 行：  
   `✔ 已批准 exec · rollback api-gateway · 10:32:15 · brief …尾4位`  
2. transcript 行改：`审批 #尾4位` + tooltip 全 id；绝不裸渲 `briefId` 正文  
3. 结论模式保留审批留痕  

**涉及文件：** host approval 通路、`ChatTranscript.vue`、`store-helpers.ts`（`formatApprovalAuditLine`）、`i18n.ts`

**竞品参照：** Codex `new_approval_decision_cell`

---

### OPT-6：工具卡 / 证据时间戳

**现状：** `ToolCallView` 只有 `durationMs`，无法回答「几点几分跑的 df」。

**改造：**

1. 协议：`TranscriptItem` 加 `ts?`；`ToolCallView` 加 `startedAt?`  
2. UI：工具卡头右侧 xs 相对时间（hover 绝对时间）；证据便签同理  
3. host 下发时在 `tool/start` 写 `startedAt: Date.now()`  

**涉及文件：** `host-protocol.ts`、host 下发点、`ToolCallCard.vue`、`EvidenceNote.vue`

**竞品参照：** Codex ExecCell timestamp、Kilo terminal tab

---

### OPT-7：SubagentInspector 改 Drawer

**现状：** 640px 居中 modal（`position: fixed; inset: 0; justify-content: center`），300px webview 内遮罩全文，无法对照 transcript。

**改造：**

- 改为 **右侧 drawer**：`width: 100%; max-width: 100%`，从 webview 右缘滑入  
- 保留已有 `‹ 1/N ›` 导航、tabs（steps/logs/overview）  
- 加 focus trap + 首次 focus 到关闭按钮  

**涉及文件：** `SubagentInspector.vue`、`ops-tokens.css`

**竞品参照：** Kilo Sub-Agent Viewer side panel

---

### OPT-8：「正在巡检…」占位 + 思考时长

**现状：** 空 assistant 流式时只显示 spinner + 静态文案，30s+ 无法区分慢与卡死。

**改造：**

- `transcript__inspecting` 行追加本地累计「已思考 Ns」（从首条 thinking/delta 或 streaming 开始计时）  
- 与 ThinkingBlock 折叠头 timer 共用 helper  

**涉及文件：** `ChatTranscript.vue`、`store.ts` 或 `store-helpers.ts`

**竞品参照：** Claude Code `Thought for 12s`

---

### OPT-9：Markdown / 运维语言高亮补全

**现状：** 已有 bash/sql/diff/dockerfile/nginx/ini；缺 **PromQL**（~30 行自定义 hljs language）。

**改造：**

- 注册 PromQL 自定义 language（函数名、duration、`{label="value"}` matcher）  
- 流式期间排版、finalize 后高亮（现有策略保持）  
- `MarkdownBlock.onUpdated` 复制按钮绑定改防抖（流式时 200ms debounce）  

**涉及文件：** `lib/markdown.ts`、`MarkdownBlock.vue`、`test/markdown-block.test.ts`

---

### OPT-10：导出 / 会话入口完善

**现状：** 历史抽屉已有 export；缺 view/title 图标、playbook 收尾 notice 深链、脱敏选项。

**改造：**

1. `package.json` view/title 加 export 图标  
2. reporting/closed 阶段 notice 卡「导出值班报告」  
3. 导出对话框：Markdown / JSON + **脱敏开关**（参照 OpenCode `--sanitize`）  

**涉及文件：** `package.json`、`HistoryOverlay.vue`、host `exportReport.ts`

**竞品参照：** OpenCode `/export`、Kilo History 菜单

---

## 6. P2 · 打磨项

| ID | 项 | 现状 | 建议 | 竞品 |
|----|-----|------|------|------|
| OPT-11 | 虚拟滚动动态测高 | 固定 `EST_HEIGHT=120` | 粘底条目用 `ResizeObserver` 实测；或仅对非末尾条目用估高 | Cline |
| OPT-12 | ModelSelector 自绘 | 原生 `<select>` | provider 分组 + 过滤 + 「管理模型…」尾项 | Kilo |
| OPT-13 | 证据 pin | pin 图标无 handler | 实现 pin/unpin + 入报告标记 | — |
| OPT-14 | History 删除确认 | `window.confirm` | 走 VS Code 原生 dialog 或 inline 二次确认 | OpenCode |
| OPT-15 | slash 命令体系 | 仅 `/playbook` | 增 `/export` `/copy` `/rename` | OpenCode/Kilo/Claude |
| OPT-16 | Composer 键位提示 | 无 | placeholder 或 xs 文案「Enter 发送 · Shift+Enter 换行」 | Cline |
| OPT-17 | ops-btn hover 态 | 仅 focus-visible | 映射 `--vscode-button-hoverBackground` | VS Code 规范 |
| OPT-18 | 简报文档化 | 九要素仅 webview | 超长简报「在编辑器中查看」虚拟 markdown 深链 | Claude Plan 评审 |
| OPT-19 | board codicon 化 | `○△✗` Unicode | 换 codicon（与 chat 同族） | 一致性 |
| OPT-20 | token 迁移收尾 | 12 文件残留 `calc(--ops-density * x)` | 全换 `--ops-space-*`；消灭 10px 字号 | 内部规范 |
| OPT-21 | MetricSnippet 结构化 | regex 猜点位 | 协议 `points/from/to`；regex 降级标「推断」 | — |
| OPT-22 | 存为运维文档 | 按钮已有 | 对接 `ops_write_ops_doc` host 工具（见 06-ux §3.2） | — |

---

## 7. 已对齐竞品 · 保持清单

以下能力**已达及格线，优化时勿回退**：

- 设计 token 转译层（`ops-tokens.css` → `--vscode-*`）  
- 风险三色 + 结论三态双通道（图标 + 文字）  
- 工具卡默认折叠 + ≥3 只读聚合（`toolGroup`）  
- 终端命令分段（`$ cmd` + `TerminalViewer` ANSI）  
- 流式 Markdown 渲染（非裸 `**` 源码）  
- 代码块 copy + 运维语言高亮（bash/sql/diff/nginx 等）  
- 子代理顶栏运行条 + Inspector `‹ 1/N ›`  
- 结论模式（Claude Focus view ops 版）  
- 历史会话搜索 / 重命名 / 删除 / 导出  
- 软停 / 硬停两档、失败 Retry、回到底部胶囊  
- 未配置四处一致引导、IME 输入法 guards、aria/focus-visible  

---

## 8. 竞品对照总表

```
┌──────────────────┬────────────┬────────────┬──────────────┬─────────────┐
│ 能力             │ OpenCode   │ Kilo       │ Claude/Cline │ at-opsAgent │
├──────────────────┼────────────┼────────────┼──────────────┼─────────────┤
│ 粘底滚动         │ ✅ split   │ ✅         │ ✅           │ ❌ BUG-1    │
│ 思维链           │ 时长       │ 折叠       │ 可展开       │ ⚠️ OPT-1    │
│ 状态/成本常显    │ ✅ status  │ ✅         │ partial      │ ❌ OPT-2    │
│ 审批占视口       │ footer     │ dock 紧凑  │ overlay      │ ❌ OPT-3    │
│ 工具 timestamp   │ ✅         │ ✅         │ partial      │ ❌ OPT-6    │
│ 审批 audit 留痕  │ partial    │ ✅         │ ✅           │ ⚠️ OPT-5    │
│ 导出入口         │ /export    │ History    │ /export      │ ⚠️ OPT-10   │
│ 子代理容器       │ tabs       │ side panel │ —            │ ⚠️ OPT-7    │
│ 代码 copy 发现性 │ ✅         │ ✅         │ ✅           │ ⚠️ OPT-4    │
│ 结论/Focus 模式  │ —          │ —          │ ✅           │ ✅ 已有     │
│ 终端 ANSI        │ ✅ TUI     │ ✅         │ partial      │ ✅ 已有     │
└──────────────────┴────────────┴────────────┴──────────────┴─────────────┘
```

---

## 9. 实施顺序建议

```
Phase 0 — Bug（1–2 天）
  BUG-1  粘底滚动修复（stickyTailSignature + ResizeObserver + 双 rAF）

Phase 1 — P0 体验（3–5 天）
  OPT-1  思维链默折叠可展开 + UntrustedQuotes 常显 + live timer
  OPT-2  Composer 窄屏 + Status Strip（含 costUsd）
  OPT-3  ApprovalBar 紧凑化 + 命令逐行 copy

Phase 2 — P1 增强（5–8 天）
  OPT-4  复制发现性
  OPT-5  审批 audit 留痕
  OPT-6  时间戳协议 + UI
  OPT-7  SubagentInspector drawer
  OPT-8  巡检占位 + 思考时长
  OPT-9  PromQL 高亮 + copy debounce
  OPT-10 导出入口 + 脱敏

Phase 3 — P2 打磨（按需）
  OPT-11 … OPT-22
```

---

## 10. 验收基线（Manual + Automated）

### 自动化

```bash
cd at-opsAgent && npx vitest run test/webview-chat.test.ts test/markdown-block.test.ts test/approval-loop.test.ts
```

重点新增单测：

- `stickyTailSignature` — patch 不改变 length 时签名仍变  
- `isPinnedToBottom` 阈值逻辑  
- `formatCompactUsage` — `43% · $0.02`  
- `formatApprovalAuditLine` — 人类可读审计行  
- ThinkingBlock — 折叠态 UntrustedQuotes 可见、live timer  

### 手动（VS Code webview，280×600 侧边栏）

1. **粘底：** 发送长回复，全程视口跟随；上翻后停止；滚回恢复  
2. **思维链：** 触发 Qwen/R1 思维链 → 默认一行 → 点击展开内滚 → 折叠态见警示条  
3. **Composer：** 280px 不换行；cost 常显  
4. **审批：** pending 时输入框可见；命令逐行 copy  
5. **复制：** 消息/代码块 copy 无需 hover 即可发现  
6. **子代理：** 多 agent 时 drawer 不遮全文，‹ 1/N › 可切换  

---

## 11. 明确不做（防跑偏）

1. **思维链默认自动展开** — 与用户定稿冲突  
2. **CoT 完全隐藏不可展开** — 与用户定稿冲突；安全边界靠 UntrustedQuotes 常显 + `html:false`  
3. **write/exec auto-approve / always-allow** — Kilo 盾牌不进本产品  
4. **重型图表 / mermaid / shiki** — 侧边栏 webview 体积纪律  
5. **消费级气泡 UI** — 保持用户右侧井 + Agent 全宽，禁头像渐变  
6. **IM 双向批准 / 手机接管** — 凭据与决策不出 IDE  

---

## 12. 文件索引

| 文件 | 关联项 |
|------|--------|
| `components/ChatTranscript.vue` | BUG-1, OPT-5, OPT-8 |
| `components/ThinkingBlock.vue` | OPT-1 |
| `components/Composer.vue` | OPT-2, OPT-4, OPT-16 |
| `components/ApprovalBar.vue` | OPT-3 |
| `components/SubagentInspector.vue` | OPT-7 |
| `components/MarkdownBlock.vue` | OPT-4, OPT-9 |
| `components/ToolCallCard.vue` | OPT-6 |
| `components/HistoryOverlay.vue` | OPT-10, OPT-14 |
| `store-helpers.ts` | BUG-1, OPT-1, OPT-2, OPT-5, OPT-6 |
| `store.ts` | BUG-1, OPT-8 |
| `lib/markdown.ts` | OPT-9 |
| `lib/clipboard.ts` | OPT-4 |
| `host-protocol.ts` | OPT-6 |
| `ops-tokens.css` | OPT-2, OPT-4, OPT-7, OPT-17 |
| `test/webview-chat.test.ts` | 全部 |

---

*本文档为 Chat UI 优化建议真源；施工时可拆为独立 PR，建议 Phase 0（BUG-1）优先合入。*
