# 终端命令执行组件 UI 布局重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 `at-opsAgent` 的命令执行组件（`ToolCallCard` / `LogViewer`），对标 Kilo Code、Cursor、OpenCode 标准终端体验，将“命令定义/执行操作”与“终端输出视窗”彻底分离，支持真正的 ANSI 彩色终端实时流式渲染与交互增强。

**Architecture:** 
1. 升级 `lib/ansi.ts` 实现轻量级、零依赖的 ANSI SGR 颜色解析器，将包含 16 基础色与样式的 ANSI 转义序列转换为语义化 CSS Class 与 Token；
2. 构建独立的终端视窗组件 `TerminalViewer.vue`，具备终端窗口标题栏、退出码徽标、行数计数、实时终端光标、自动贴底滚动与一键复制输出能力；
3. 重构 `ToolCallCard.vue`，采用“头部摘要 + 独立命令卡 (CommandBar) + 实时终端控制台 (TerminalViewer) + 错误面板”的解耦四段式布局；
4. 补充 i18n 国际化文案与全面的自动化单测。

**Tech Stack:** Vue 3, Pinia, TypeScript, VS Code Webview CSS Tokens, Vitest.

---

### Task 1: 升级 ANSI SGR 彩色终端解析引擎

**Files:**
- Modify: `src/webview-chat/lib/ansi.ts`
- Test: `test/ansi-log.test.ts`

**Interfaces:**
- Produces: 
  - `export interface AnsiSpan { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; tone?: 'error' | 'warn' }`
  - `export interface AnsiLine { spans: AnsiSpan[]; level: 'error' | 'warn' | null }`
  - `export function parseAnsiToLines(text: string): AnsiLine[]`
  - `export function stripAnsi(text: string): string`

- [ ] **Step 1: Write the failing tests for ANSI SGR parsing**

```typescript
// test/ansi-log.test.ts
it('parseAnsiToLines correctly parses 16 ANSI foreground colors and styles', () => {
  const input = '\x1B[31mError message\x1B[0m and \x1B[32;1mGreen Bold\x1B[0m';
  const lines = parseAnsiToLines(input);
  expect(lines.length).toBe(1);
  expect(lines[0].spans).toEqual([
    { text: 'Error message', color: 'ansi-red', tone: 'error' },
    { text: ' and ' },
    { text: 'Green Bold', color: 'ansi-green', bold: true }
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ansi-log.test.ts`
Expected: FAIL with `parseAnsiToLines is not a function`

- [ ] **Step 3: Implement minimal ANSI SGR parser**

In `src/webview-chat/lib/ansi.ts`:
- 实现状态机或正则表达式逐段提取 SGR 代码（0, 1, 2, 3, 4, 30-37, 39, 40-47, 49, 90-97, 100-107）；
- 支持多行拆分并保持行间样式重置；
- 保持关键词（ERROR/WARN）智能提取与高亮兼容。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ansi-log.test.ts`
Expected: PASS

---

### Task 2: 编写 TerminalViewer 终端视窗组件与样式

**Files:**
- Create: `src/webview-chat/components/TerminalViewer.vue`
- Modify: `src/webview-chat/ops-tokens.css`
- Modify: `src/webview-chat/i18n.ts`

**Interfaces:**
- Consumes:
  - `props: { text?: string; isRunning?: boolean; exitCode?: number; uri?: string; truncated?: boolean; title?: string; maxHeight?: string }`
  - `parseAnsiToLines(text)` from `../lib/ansi`
- Produces:
  - `<TerminalViewer />` 供 `ToolCallCard.vue` 及其他组件直接引用。

- [ ] **Step 1: Define i18n keys for terminal window**

In `src/webview-chat/i18n.ts`:
- 增加 `terminalTitle`, `terminalAutoScroll`, `terminalCopyOutput`, `terminalCopiedOutput`, `terminalRunning`, `terminalNoOutput`, `terminalExitCode` 等中英文词条。

- [ ] **Step 2: Define terminal CSS token classes**

In `src/webview-chat/ops-tokens.css`:
- 增加 `.ansi-black`, `.ansi-red`, `.ansi-green`, `.ansi-yellow`, `.ansi-blue`, `.ansi-magenta`, `.ansi-cyan`, `.ansi-white` 等 CSS 类映射至 `--vscode-terminal-ansi*`。

- [ ] **Step 3: Implement TerminalViewer.vue**

- 顶部 Header 包含：
  - 左侧：Terminal 图标、标题 `TERMINAL` / `OUTPUT`、行数指示、运行状态转轮；
  - 右侧：Exit Code 徽标（绿/红/灰色）、Auto-scroll 自动贴底滚动开关按钮、一键复制输出内容按钮。
- 内容区：
  - 采用深色背景 `var(--vscode-terminal-background, #1e1e1e)` 与等宽字体；
  - 渲染带行号和 ANSI 彩色 span 的控制台行；
  - 若处于 `isRunning` 状态，在末行展示带有平滑呼吸动画的光标指示器（Terminal Cursor）；
  - 若输出为空，展示暗色 `(No output recorded)` 占位。
- 底部截断区：
  - 若 `truncated === true`，展示「在编辑器中打开完整日志」入口。

---

### Task 3: 重构 ToolCallCard 组件实现命令与结果分离

**Files:**
- Modify: `src/webview-chat/components/ToolCallCard.vue`
- Modify: `src/webview-chat/store-helpers.ts`

**Interfaces:**
- Consumes:
  - `<TerminalViewer />` from `./TerminalViewer.vue`
  - `parseToolOutputPreview(preview)` from `../store-helpers`

- [ ] **Step 1: Refactor ToolCallCard Template & Layout**

- 头部（Head）：仅保留核心摘要（折叠箭头、意图标题、插件/工具名、风险 Badge、整体状态徽标、耗时）；
- 展开区（Body）：
  1. **独立命令卡（Command Area）**：
     - 单行/多行展示命令内容，左侧带 Terminal 提示符 `$`，右侧带独立命令复制按钮；
     - 显示目标靶机/插件上下文信息（若有）。
  2. **终端结果视窗（Terminal Console View）**：
     - 直接嵌入 `<TerminalViewer :text="displayOutput" :is-running="isRunning" :exit-code="parsed.exitCode" :uri="call.artifactUri" :truncated="clipped" />`；
     - 无论是运行中还是执行结束，结果均以实时终端形式稳定呈现，杜绝内容堆叠。
  3. **错误状态区（Error Alert）**：
     - 若 `status === 'error'` 且有 `errorCode` / `errorMessage`，在终端下方以清晰的 Alert 提示错误原因。

- [ ] **Step 2: Test Component Structure in Webview Unit Tests**

- Update/add tests in `test/webview-chat.test.ts` to verify `parseToolOutputPreview` and component data extraction.

---

### Task 4: 全量构建、自动化测试与 VSIX 打包验证

**Files:**
- All modified files

- [ ] **Step 1: Run full unit test suite**

Run: `npm test`
Expected: 47+ test files pass, 100% green.

- [ ] **Step 2: Run TypeScript type checking**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Compile Webview and Extension**

Run: `npm run compile`
Expected: Clean compilation.

- [ ] **Step 4: Package Extension VSIX**

Run: `npm run package`
Expected: Successfully generate `.vsix` package for user testing.
