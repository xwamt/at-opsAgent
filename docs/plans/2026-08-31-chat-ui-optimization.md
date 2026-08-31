# Chat UI 体验与架构深度优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于与 Kilo Code、OpenCode、Cline、Claude Code 等开源前沿项目的对比评审结果，全面优化 `at-opsAgent` 前端 Chat UI 的核心交互设计与性能，解决思维链膨胀遮挡、多子代理切换缺失、工具呈现粗糙、审批审计断链、窄边栏排版拥挤等关键缺陷。

**Architecture:** 
1. **轻量化渐进交互 (Progressive Disclosure)**：思维链默认折叠+动态时长指示，长审批简报按需展开/编辑器深链；
2. **多子代理协同 (Multi-Agent Navigation)**：顶栏运行条支持多 Agent 状态轮播与 Inspector 内 `‹ 1/N ›` 顺滑切换，弹窗转侧滑抽屉；
3. **运维载荷一等公民呈现 (Ops-First ExecCell)**：工具执行分段渲染（命令行+退出码+ANSI 终端日志），扩展 SQL/Diff/PromQL 语法高亮；
4. **响应式与弹性排版 (Sidebar Ergonomics)**：事件脉络单行横滑、Composer 紧凑模式与明细水位展示。

**Tech Stack:** Vue 3, Pinia, TypeScript, markdown-it, highlight.js, VS Code Webview Toolkit / CSS Tokens, Vitest.

**Spec:** `docs/reviews/round2/02-ui.md` & `docs/15-optimization-recommendations.md`

## Global Constraints

- **设计 Token 纪律**：严禁硬编码颜色与字体大小，必须严格复用 `ops-tokens.css` 中的 `--vscode-*` 映射与 `--ops-space-*`、`--ops-font-*` 变量。
- **安全边界**：Markdown 渲染管线必须保持 `html:false`，不可信外部引用（UntrustedQuotes）与原始 CoT 严禁直接执行富文本注入。
- **零额外重型依赖**：禁止引入 ECharts / Mermaid / Shiki / heavy UI framework，保持轻量高效的单测与打包体系。
- **测试覆盖**：所有新增或重构的 pure TS helper 与状态归一化函数均需在 `test/webview-chat.test.ts` 中配备完整的单元测试。

---

## Task Decomposition

### Task 1: 思维链 (ThinkingBlock) 默认折叠与动态计时体验优化 (P0)

**Files:**
- Modify: `src/webview-chat/components/ThinkingBlock.vue`
- Modify: `src/webview-chat/store-helpers.ts`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/webview-chat.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` (kind: 'thinking', steps: string[], durationMs?: number, untrustedQuotes?: string[])
- Produces: `ThinkingBlock` 默认 `expanded = false`；流式期间提供 `thinkingLiveLabel(elapsedMs)` 计时；展开后提供 `max-height: 240px` 独立内滚与代码块复制。

- [ ] **Step 1: 编写 Thinking 状态与计时相关的失败单元测试**

在 `test/webview-chat.test.ts` 中补充测试用例：
```ts
describe('ThinkingBlock 逻辑与展示', () => {
  it('thinkingMetaVisible 在默认配置下应返回 true，在结论模式下返回 false', () => {
    expect(thinkingMetaVisible(true, false)).toBe(true);
    expect(thinkingMetaVisible(true, true)).toBe(false);
    expect(thinkingMetaVisible(false, false)).toBe(false);
  });

  it('formatThinkingDurationMs 应能正确格式化毫秒与秒数', () => {
    expect(formatThinkingDurationMs(450)).toBe('450ms');
    expect(formatThinkingDurationMs(3200)).toBe('3.2s');
    expect(formatThinkingDurationMs(12500)).toBe('13s');
    expect(formatThinkingDurationMs(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试并验证测试失败或缺省覆盖**

运行：`npx vitest run test/webview-chat.test.ts`

- [ ] **Step 3: 修改 ThinkingBlock.vue 实现默认折叠与动态计时**

1. 将 `ThinkingBlock.vue` 中的 `expanded` 初始值由 `ref(true)` 调整为 `ref(false)`；
2. 为流式思考添加 `elapsedMs` 动态递增计时器（100ms 步进），思考中显示动态秒数；
3. 展开容器增加最大高度约束与优雅滚动：
```css
.thinking-card__body {
  padding: var(--ops-space-2) var(--ops-space-3);
  border-top: 1px dashed var(--ops-border);
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: thin;
}
```
4. 确保 `UntrustedQuotes` 即使在 Thinking 折叠状态下也保持外部警示条高亮可见。

- [ ] **Step 4: 运行单元测试验证通过**

运行：`npx vitest run test/webview-chat.test.ts`
预期：PASS

- [ ] **Step 5: 提交变更**

```bash
git add src/webview-chat/components/ThinkingBlock.vue test/webview-chat.test.ts
git commit -m "fix(chat-ui): make ThinkingBlock collapsed by default with live timer"
```

---

### Task 2: Markdown 语法高亮扩展（SQL/Diff/PromQL/Nginx）与消息复制 (P0)

**Files:**
- Modify: `src/webview-chat/lib/markdown.ts`
- Modify: `src/webview-chat/components/MarkdownBlock.vue`
- Modify: `src/webview-chat/components/ChatTranscript.vue`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/markdown-block.test.ts`
- Test: `test/webview-chat.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown(source: string, streaming?: boolean)`
- Produces: 支持 `sql`, `diff`, `dockerfile`, `nginx`, `ini` 语法的代码高亮；Assistant 消息卡片提供顶层「复制整条回复 (Copy Markdown)」按钮。

- [ ] **Step 1: 编写 Markdown 语法与语言注册测试用例**

在 `test/markdown-block.test.ts` 中补充测试：
```ts
import { renderMarkdown } from '../src/webview-chat/lib/markdown';

describe('Markdown 语法高亮与渲染扩展', () => {
  it('能够正常渲染 SQL 代码块并生成高亮 span', () => {
    const md = '```sql\nSELECT id, name FROM users WHERE status = 1;\n```';
    const html = renderMarkdown(md, false);
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('SELECT');
  });

  it('能够正常渲染 Diff 代码块', () => {
    const md = '```diff\n- old_version\n+ new_version\n```';
    const html = renderMarkdown(md, false);
    expect(html).toContain('new_version');
  });
});
```

- [ ] **Step 2: 运行测试验证**

运行：`npx vitest run test/markdown-block.test.ts`

- [ ] **Step 3: 在 markdown.ts 中按需注册高频运维语言**

在 `src/webview-chat/lib/markdown.ts` 中引入并注册：
```ts
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import nginx from 'highlight.js/lib/languages/nginx';

hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('nginx', nginx);
```

- [ ] **Step 4: 为 Assistant 消息添加整体 Markdown 复制与重试操作条**

在 `src/webview-chat/components/ChatTranscript.vue` 的 `.transcript__msg--agent` 头部工具栏补充：
1. 一键复制整条回复 Markdown 文本（使用 `useCopiedFlag()` 与 `copyText(entry.item.text)`）；
2. 优化复制成功反馈微动效。

- [ ] **Step 5: 运行测试并提交**

运行：`npx vitest run test/markdown-block.test.ts test/webview-chat.test.ts`
```bash
git add src/webview-chat/lib/markdown.ts src/webview-chat/components/MarkdownBlock.vue src/webview-chat/components/ChatTranscript.vue test/markdown-block.test.ts
git commit -m "feat(chat-ui): add ops language highlights and message-level markdown copy"
```

---

### Task 3: 多子代理协作状态指示与 Inspector 切换体验 (P1)

**Files:**
- Modify: `src/webview-chat/components/ChatApp.vue`
- Modify: `src/webview-chat/components/SubagentInspector.vue`
- Modify: `src/webview-chat/components/SubagentBoard.vue`
- Modify: `src/webview-chat/store-helpers.ts`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/subagent-cards.test.ts`
- Test: `test/webview-chat.test.ts`

**Interfaces:**
- Consumes: `store.activeSubagents: SubagentCard[]`, `store.inspectedSubagent: SubagentCard | null`
- Produces:
  * `ChatApp.vue` 顶栏支持多 Agent 滚动/下拉查看；
  * `SubagentInspector.vue` 提供 `nextSubagent(currentId)` / `prevSubagent(currentId)` 切换导航。

- [ ] **Step 1: 编写多子代理查找与切换的 helper 单元测试**

在 `test/subagent-cards.test.ts` 或 `test/webview-chat.test.ts` 中编写：
```ts
describe('Subagent 导航逻辑', () => {
  const mockCards: SubagentCard[] = [
    { taskId: 'task-1', label: 'Host Check', role: 'investigator', status: 'running', riskCeiling: 'read', toolCalls: { used: 1, max: 10 }, wallMs: { used: 100, max: 1000 } },
    { taskId: 'task-2', label: 'DB Check', role: 'investigator', status: 'running', riskCeiling: 'read', toolCalls: { used: 2, max: 10 }, wallMs: { used: 200, max: 1000 } },
  ];

  it('能正确找出当前 inspected agent 的相邻 agent taskId', () => {
    expect(findAdjacentSubagent(mockCards, 'task-1', 'next')).toBe('task-2');
    expect(findAdjacentSubagent(mockCards, 'task-2', 'prev')).toBe('task-1');
  });
});
```

- [ ] **Step 2: 在 store-helpers.ts 中实现相邻子代理查找函数**

```ts
export function findAdjacentSubagent(
  cards: readonly SubagentCard[],
  currentTaskId: string,
  direction: 'prev' | 'next'
): string | null {
  if (cards.length <= 1) return null;
  const idx = cards.findIndex((c) => c.taskId === currentTaskId);
  if (idx < 0) return null;
  const nextIdx = direction === 'next' ? (idx + 1) % cards.length : (idx - 1 + cards.length) % cards.length;
  return cards[nextIdx].taskId;
}
```

- [ ] **Step 3: 优化 ChatApp.vue 顶栏与 SubagentInspector.vue 头部导航**

1. 在 `ChatApp.vue` 中，当 `store.activeSubagents.length > 1` 时，展示可展开的小气泡或徽章，而不是只绑定第 0 个；
2. 在 `SubagentInspector.vue` 头部添加 `‹ 1/N ›` 上一个/下一个切换按钮；
3. 将 Inspector 弹层适配为 VS Code 风格的右侧抽屉式轻量浮层，减小在窄屏下的压迫感。

- [ ] **Step 4: 运行测试并提交**

运行：`npx vitest run test/subagent-cards.test.ts test/webview-chat.test.ts`
```bash
git add src/webview-chat/components/ChatApp.vue src/webview-chat/components/SubagentInspector.vue src/webview-chat/store-helpers.ts test/subagent-cards.test.ts test/webview-chat.test.ts
git commit -m "feat(chat-ui): add multi-subagent pagination in inspector and top running strip"
```

---

### Task 4: 工具调用卡片（ExecCell 分段）与 ANSI 错误行过滤优化 (P1)

**Files:**
- Modify: `src/webview-chat/components/ToolCallCard.vue`
- Modify: `src/webview-chat/components/LogViewer.vue`
- Modify: `src/webview-chat/lib/ansi.ts`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/ansi-log.test.ts`
- Test: `test/webview-chat.test.ts`

**Interfaces:**
- Consumes: `ToolCallView` (name, preview, risk, status, durationMs, artifactUri)
- Produces: `ToolCallCard` 展开区结构化展示：`$ command` 命令栏（独立复制）+ 退出码状态 + 展开折叠的 Stdout/Stderr。

- [ ] **Step 1: 编写 ToolCall 命令解析与 ExitCode 提取的单测**

在 `test/webview-chat.test.ts` 中补充：
```ts
describe('ToolCall 结构化提取', () => {
  it('能够从 preview JSON 中提取 command 与 exit code', () => {
    const raw = JSON.stringify({ command: 'df -h', exitCode: 0, stdout: 'Filesystem 100M' });
    const parsed = parseToolOutputPreview(raw);
    expect(parsed.command).toBe('df -h');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe('Filesystem 100M');
  });
});
```

- [ ] **Step 2: 实现 parseToolOutputPreview 并在 ToolCallCard.vue 中分段渲染**

1. 将 Preview 拆解为 Command、Exit Code、Output 三段；
2. Command 单独高亮并提供独立快捷复制按钮；
3. Exit Code 为 0 时显示绿色 `exit: 0`，非 0 时显示红色 `exit: <code>`；
4. 修复 `LogViewer.vue` 中的 ANSI 转义序列剥离与精准 span 着色。

- [ ] **Step 3: 运行测试并提交**

运行：`npx vitest run test/ansi-log.test.ts test/webview-chat.test.ts`
```bash
git add src/webview-chat/components/ToolCallCard.vue src/webview-chat/components/LogViewer.vue src/webview-chat/lib/ansi.ts test/ansi-log.test.ts test/webview-chat.test.ts
git commit -m "feat(chat-ui): structure ToolCallCard output with command copy and exit codes"
```

---

### Task 5: 审批闸呈现紧凑化与 Transcript 审计留痕 (P1)

**Files:**
- Modify: `src/webview-chat/components/ApprovalBar.vue`
- Modify: `src/webview-chat/components/ChatTranscript.vue`
- Modify: `src/webview-chat/store-helpers.ts`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/approval-loop.test.ts`
- Test: `test/webview-chat.test.ts`

**Interfaces:**
- Consumes: `store.pendingApproval: ApprovalBriefView`
- Produces: 
  * `ApprovalBar` 九要素空白字段自动折叠为「未提供 (N 项)」；
  * 命令组支持单条逐行独立复制；
  * `ChatTranscript` 中的已完成审批条目展现结构化决议文本 `✔ 已批准 · 目标 · 时间`，不再裸露 `briefId`。

- [ ] **Step 1: 编写审批留痕与九要素收敛测试用例**

在 `test/approval-loop.test.ts` 或 `test/webview-chat.test.ts` 中：
```ts
describe('审批留痕呈现', () => {
  it('能够将审批项生成结构化的人类可读摘要', () => {
    const item = { kind: 'approval' as const, id: 'app-1', briefId: 'brief-xyz', decision: 'approved', target: 'api-gateway', ts: 1700000000000 };
    const label = formatApprovalAuditLine(item);
    expect(label).toContain('已批准');
    expect(label).toContain('api-gateway');
  });
});
```

- [ ] **Step 2: 改造 ApprovalBar.vue 与 ChatTranscript.vue**

1. 优化 `ApprovalBar.vue` 展开时的 `max-height` 与网格布局，空要素折叠为单行概览；
2. 命令块中的多行命令增加行号与行尾独立 Copy 图标；
3. 改造 `ChatTranscript.vue` 的 `transcript__approval-ref`，展示明确的审计链信息（决策类型 + 目标 + 发生时刻）。

- [ ] **Step 3: 运行测试并提交**

运行：`npx vitest run test/approval-loop.test.ts test/webview-chat.test.ts`
```bash
git add src/webview-chat/components/ApprovalBar.vue src/webview-chat/components/ChatTranscript.vue src/webview-chat/store-helpers.ts test/approval-loop.test.ts test/webview-chat.test.ts
git commit -m "feat(chat-ui): compact approval brief and format human-readable audit trail in transcript"
```

---

### Task 6: 事件脉络横滑单行化与 Composer 窄屏弹性适配 (P2)

**Files:**
- Modify: `src/webview-chat/components/ChatTranscript.vue`
- Modify: `src/webview-chat/components/Composer.vue`
- Modify: `src/webview-chat/components/WelcomeState.vue`
- Modify: `src/webview-chat/ops-tokens.css`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/webview-chat.test.ts`

**Interfaces:**
- Consumes: `store.timelineStrip: TimelineStripEntry[]`, `store.usage: UsageView`
- Produces: 
  * `.tstrip` 单行水平滚动；
  * `Composer.vue` 水位条常显精简指标 `43% · $0.02`；
  * `WelcomeState.vue` 补充常用运维 Prompt 快捷动作卡。

- [ ] **Step 1: 编写 TimelineStrip 单行截断与 Usage 明细展示测试**

在 `test/webview-chat.test.ts` 中：
```ts
describe('Composer Usage 文本格式化', () => {
  it('能够生成紧凑的单行 usage 指标文本', () => {
    const usage = { contextUsed: 43000, contextWindow: 100000, costUsd: 0.02 };
    const text = formatCompactUsage(usage);
    expect(text).toBe('43% · $0.02');
  });
});
```

- [ ] **Step 2: 改造 ChatTranscript.vue tstrip 样式与 Composer.vue 布局**

1. 将 `.tstrip` 改为：
```css
.tstrip {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
  border-bottom: 1px solid var(--ops-border);
  padding: var(--ops-space-1) var(--ops-space-2);
}
.tstrip::-webkit-scrollbar {
  display: none;
}
```
2. 在 Composer 水位进度条旁添加常驻 xs 文本标签；
3. 为 `WelcomeState.vue` 增加「检查主机 CPU/内存」、「排查 5xx 错误」等即时填入/发送的 Prompt 动作卡。

- [ ] **Step 3: 运行全量测试套件验证**

运行：`npm test` 或 `npx vitest run`
预期：所有测试全部通过。

- [ ] **Step 4: 提交代码**

```bash
git add src/webview-chat/components/ChatTranscript.vue src/webview-chat/components/Composer.vue src/webview-chat/components/WelcomeState.vue src/webview-chat/ops-tokens.css test/webview-chat.test.ts
git commit -m "feat(chat-ui): make timeline strip single-line scrollable and compact composer toolbar"
```

---

## Verification Plan

### Automated Tests
- 执行 `at-opsAgent` 全量前端与协议单元测试：
  ```bash
  cd at-opsAgent && npx vitest run
  ```
- 重点验证：
  - `test/webview-chat.test.ts`（Thinking 计时、折叠、Usage、Timeline Strip、审批留痕）
  - `test/markdown-block.test.ts`（代码高亮、XSS 安全转义、SQL/Diff 语言包）
  - `test/subagent-cards.test.ts`（子代理卡片状态与切换逻辑）
  - `test/ansi-log.test.ts`（终端日志 ANSI 解析）

### Manual Verification in VS Code Webview
1. **思维链折叠验证**：发送复杂排查 Prompt（触发 Qwen3/R1 思维链），验证思考过程中出现动态计时，思考结束后默认折叠为单行，点击后顺滑展开且不撑爆视口。
2. **多子代理导航验证**：触发多代理并发巡检，验证顶栏运行条能显示全部活跃子代理，点击 Inspector 后可通过 `‹ 1/N ›` 顺畅翻页。
3. **窄边栏（300px）排版验证**：将 VS Code 侧边栏拖动至 280px 宽度，检查 Composer 工具栏、顶部 Timeline 事件条、审批栏九要素是否自适应无横向越界。
4. **代码块与消息复制验证**：发送含 SQL、Diff、Nginx 配置的回复，检查语法高亮正确，点击代码块右上角复制与 Assistant 卡头整体复制按钮，验证剪贴板写入成功。
