# Plan 10 · 流式 Markdown、LogViewer、审批留痕、docs/05

> Status: Ready to execute
> Source: docs/15 P1-5、P1-6、P1-7、P1-15
> Depends on: 无代码硬依赖。P1-7 与 Plan 05 都碰 `approvalService.applyApproval`——本 plan 只 **patch transcript item**，05 改 waiter/TTL；可同文件不同函数。
> Parallel-safe with: 08、09（09 改 MarkdownBlock 加复制；本 plan 改 streaming 分支与 fence。**建议 09 的 fence/copy 监听写在 `updated()`，本 plan 不要重写整个 MarkdownBlock 模板**）
> Module: `ChatTranscript.vue`、`MarkdownBlock.vue`、`LogViewer.vue`、`host-protocol.ts`、`approvalService.ts`、`docs/05-ui-system.md`

## 0. 一句话目标 + 完成判据

流式 assistant 按 Markdown 渲染（高亮只在 finalize 后上）；日志行用 ANSI 剥离 + 关键词 span，不再整行染色；审批决议写进 transcript 且协议带 wall-clock；`docs/05` 改成现行单 Chat IA。

完成判据：

1. `ChatTranscript.vue` 流式 assistant **不再** `{{ entry.item.text }}` 插值原文。
2. `highlight.js` 只在 `streaming!==true` 的 MarkdownBlock 启用。
3. LogViewer 含 `\x1b[31mERROR\x1b[0m` 的夹具：DOM 文本无 ESC，ERROR 为 span 而非整行 `logv__line--error` 作为唯一高亮手段（行 class 可保留，但关键词必须是 span）。
4. 决议后 transcript 的 approval item 含 `decision` + `ts`；hydrate 重开会话仍能读到。
5. `docs/05-ui-system.md` §1 不再画 Sessions/Approvals/Skills/Models 四个 TreeView。

## 1. 背景

流式（`ChatTranscript.vue:225-228`）：

```vue
<MarkdownBlock v-else-if="!entry.item.streaming" :source="entry.item.text" />
<div v-else class="transcript__text">
  {{ entry.item.text }}<span class="transcript__caret">▍</span>
</div>
```

值班看的是半截 markdown 源码（`**结论**` 而不是粗体）。已有 caret（`:227`），不要再加第二套光标。

LogViewer（`LogViewer.vue:32-47`）按整行 `ERROR|WARN` 加 `logv__line--error`。ANSI 原样显示；「error」在行中会整行变红，误伤 `error_rate` 所在行——P1-6 要求 strip + 关键词 span。

审批 transcript（`:258-262`）只有 briefId +「见下方 / 已处理」，**没有** approved/rejected，也没有时间。`appendItem` 登记时（`approvalService.ts:280`）无 ts；决议只 `appendTimeline`（`:346`）不 patch item。协议 `TranscriptItem` 各变体无 `ts`（`host-protocol.ts:118-133`）。

`docs/05` §1 仍是设计期多 TreeView IA，与 Cline 式单 Chat + 设置 Webview 漂移。

## 2. 硬约束

- 不引入 mermaid、shiki、KaTeX、虚拟滚动、CoT expander（docs/15 §5.10/5.12）。
- `MarkdownBlock` 保持 `html:false`。highlight.js 只高亮 `<code>` 文本节点，不要 `innerHTML` 拼不可信 HTML。
- 不可信工具结果不要送进高亮管线（工具卡继续 `<pre>` / LogViewer 文本）。
- 思考块（`kind:'thinking'`）维持折叠，Focus/默认不展开 CoT。
- 不要为流式写第二套 markdown 解析器。

## 3. 现状代码

见 §1。highlight.js：**未**在 `package.json` dependencies（实现时加精确版本，禁用 `^`，与 pi 包纪律一致；若体积过大，只注册 `javascript,json,bash,yaml,python` 五语）。

`MarkdownBlock.vue:10-16` 模块级单例 `MarkdownIt`——流式每帧 `md.render` 可接受；不要为每条消息 new MarkdownIt。

caret 已在流式分支。finalize 后走 MarkdownBlock，无 caret——正确。

## 4. 目标设计

### 4.1 流式 Markdown（P1-5）

assistant `content` 分支统一：

```vue
<MarkdownBlock :source="entry.item.text" :streaming="!!entry.item.streaming" />
<span v-if="entry.item.streaming" class="transcript__caret" :aria-label="t('generating')">▍</span>
```

删掉 `{{ entry.item.text }}` 流式分支。

`MarkdownBlock` 增加可选 `streaming?: boolean`。`streaming===true` 时 **不** 跑 highlight。未闭合 fence：markdown-it 当 code 可接受。

高亮：`markdown-it` `highlight` 选项，仅 `!streaming` 时调用 highlight.js。语言不明 → 不高亮（原样 escape）。包：`highlight.js` 精确版本 + 核心语言白名单。CSS 用 VS Code token 接近的最小一套（`.hljs-keyword` 等），或 `highlight.js/styles/github-dark.min.css` 若与 `--vscode-editor-background` 不冲突；冲突则只加 6 个 color 变量到 `ops-tokens.css`。

### 4.2 LogViewer（P1-6）

新纯函数 `src/webview-chat/lib/ansi.ts`（或 `src/host` 不需要）：

```ts
export function stripAnsi(s: string): string
export function annotateLogLine(s: string): Array<{ text: string; tone?: 'error'|'warn' }>
```

`stripAnsi`：去 CSI `/\x1B\[[0-9;]*m/g`。`annotateLogLine`：在 **strip 之后** 对 `\bERROR\b|\bFATAL\b|\bException\b|\bpanic\b` 与 `\bWARN(?:ING)?\b` 切 span；**不要**用 `error_rate` 这种非词界匹配。

模板：

```vue
<span v-for="(seg, i) in segs" :key="i" :class="seg.tone ? 'logv__kw logv__kw--' + seg.tone : undefined">{{ seg.text }}</span>
```

整行 `logv__line--error` **删除**或降为「该行含 error span 时加一条左边框」，避免整行前景色。

### 4.3 审批留痕 + wall-clock（P1-7）

`TranscriptItem` 所有变体加可选 `ts?: number`（缺省 = 旧会话无字段，UI 不展示）。host `appendItem` 若调用方没传，`sessionStore.appendItem` 补 `ts: Date.now()`。

approval 变体扩展：

```ts
| { kind: 'approval'; id: string; briefId: string; decision?: 'approved'|'rejected'|'timeout'|'pending'; ts?: number }
```

- `registerBrief`：`decision: 'pending'` + ts
- `applyApproval` / timeout（Plan 05）：`store.patchItem` 按 briefId 找到 approval item，写 `decision` + ts。若无 patchItem，新增 `sessionStore.patchItem(id, partial)`，并 `broadcast('transcript/patch', { id, patch })`。webview store 已有 tool patch 路径则复用。

UI：`ChatTranscript` approval 行显示 `批准/拒绝/超时 · HH:mm:ss`（`toLocaleTimeString`），不要只写「已处理」。

timeline 已有 `ts`（`TimelineEventView.ts`）——P1-7 要的是 **transcript 协议** 也有 wall-clock，导出才能对齐。`buildOpsReportMarkdown` 审批段若只读 timeline，补读 item.decision 作为双源；以 item 为准若已 patch。

### 4.4 重写 docs/05（P1-15）

重写 `docs/05-ui-system.md` §1 信息架构为：

```text
Activity Bar: AT Ops Agent
  对话 Chat     WebviewView（唯一主表面：PlaybookHeader + Transcript + ApprovalBar + Composer）
  （无 Sessions/Approvals/Skills/Models TreeView）

命令/标题栏：newSession、toggleHistory、pickPlaybook、exportReport、abort、openSettings
历史：HistoryOverlay 模态
设置：独立 Settings Webview（模型 / 能力 / MCP / 会话）
看板：atOpsAgent.openBoard 宽表（可选，非主路径）
```

§3 组件表与现行文件名对齐（`ChatApp.vue`、`WelcomeState`、`SubagentInspector`、`LogViewer`）。删除 `packages/webview-chat` 路径（实际是 `src/webview-chat`）。token 文件改为 `src/webview-chat` 下实际 css 路径（grep `ops-tokens.css`）。

**不要**重写 docs/10 全文。索引指针见 T5。

## 5. 任务拆分

### T1. 流式走 MarkdownBlock

- 文件：`ChatTranscript.vue`、`MarkdownBlock.vue`
- grep 门：`rg "entry.item.text" src/webview-chat/components/ChatTranscript.vue` 在 assistant content 分支只剩 MarkdownBlock `:source`（user/error 分支的插值可保留）
- 测试：`test/markdown-block.test.ts` 或 webview 测：source `# hi` → html 含 `h1`；streaming 真时 html 仍是 md 渲染但无 `hljs`
- Done when：流式可见粗体/标题，不是 `**`

### T2. highlight.js 白名单

- 文件：`package.json` 精确依赖；`MarkdownBlock.vue` highlight 选项
- 体积：bundle webview 后目测 highlight 只含注册语言（不要 `import hljs from 'highlight.js'` 全量；用 `highlight.js/lib/core` + 语言包）
- Done when：finalize 的 js fence 有 `hljs-keyword`；streaming 无

### T3. ANSI + 关键词 span

- 文件：`ansi.ts`、`LogViewer.vue`、`test/ansi-log.test.ts`
- 用例：strip；`error_rate=1` 无 error span；`ERROR boom` 有；ANSI 红 ERROR strip 后仍有 error span
- Done when：三用例绿

### T4. approval item 决议 + ts

- 文件：`host-protocol.ts`、`sessionStore.appendItem/patchItem`、`approvalService.ts`、`ChatTranscript.vue`、`docs/schemas` 若有 protocol 副本则同步
- 测试：register + applyApproval → `itemsOf` 该 approval `decision==='approved'` 且 `typeof ts==='number'`；hydrate JSON 往返不丢
- Done when：重开会话仍显示决议与时间

### T5. docs/05 重写 + 计划索引指针

若本 PR 只交计划、代码尚未动：T5 的**索引指针已在计划落盘 PR 写好**（`docs/README.md`、`AGENTS.md`、`docs/15` 文首、`docs/10` banner、`README.md`）。实现阶段只需重写 `docs/05-ui-system.md`；若 rebase 丢了指针再按表补。

| 文件 | 动作 |
|------|------|
| `docs/05-ui-system.md` | §1/§3 按 §4.4 重写 |
| `docs/README.md` | 配套列表增加 `plans/2026-08-29-duty-loop/00-index.md` |
| `docs/15-optimization-recommendations.md` | 文首：落地计划见 plans 目录；本文是审查结论 |
| `docs/10-implementation-plan.md` | 顶部 banner：会话 UX P0 已完成；下一阶段以 docs/15 + 本 plans 为准 |
| `AGENTS.md` | 「建议实现顺序」改为指向 `docs/plans/2026-08-29-duty-loop/00-index.md` |
| `README.md` | Docs 表加 plans 行 |

Done when：五个索引都能点到 `00-index.md`；docs/05 不再描述四个 TreeView 主 IA。

## 6. 执行命令

```bash
npx vitest run test/ansi-log.test.ts test/webview-chat.test.ts test/session-store.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] 流式 Markdown
- [ ] highlight 仅 finalize
- [ ] LogViewer ANSI strip + 词界 span
- [ ] 审批 decision+ts 可 hydrate
- [ ] docs/05 与代码 IA 一致

## 8. 明确不做

虚拟滚动、mermaid/shiki/KaTeX、CoT expander、工具 preview 高亮。

## 9. 风险

流式每 token `md.render` 可能抖：先不做 throttle，卡再加 50ms。highlight 全量 import 会撑 webview：必须 core+白名单。
