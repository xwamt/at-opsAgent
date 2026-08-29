# Plan 09 · 复制三处 + 导出三入口 + 取消不落盘

> Status: Ready to execute
> Source: docs/15 P0-E；docs/reviews/round2/06-ux-features.md §3.3 入口段
> Depends on: 无。Plan 07 的 `redactSecrets` 若已合入，导出 markdown 走它；否则先用现有 `buildOpsReportMarkdown`（注释已承诺不放 token 字段，但 preview 仍可能含密钥——07 负责刮密）。
> Parallel-safe with: 01、05、07（07 改 exportReport 刮密时本 plan 只加入口与对话框，合并注意 `workbenchService.exportReport` 签名）
> Module: `MarkdownBlock.vue`、`ToolCallCard.vue`、`ApprovalBar.vue`、`HistoryOverlay.vue`、`package.json` menus、`workbenchService.ts`

## 0. 一句话目标 + 完成判据

值班最高频动作（拷命令、拷结论、交班报告）不用打开命令面板：代码块 / 工具卡命令 / 审批命令集可 hover 复制；标题栏、历史条目、收尾 notice 三处能导出 Markdown。保存对话框取消后磁盘零新文件。

完成判据：

1. 不开命令面板，≤2 次点击得到 `.md`（标题栏导出图标 → 保存对话框）。
2. 三处复制点击后按钮/提示变为「已复制」至少 1s。
3. `showSaveDialog` 返回 `undefined` 时 `fs.writeFile` / `workspace.fs.writeFile` / `writeFileSync` 均零调用。
4. 工具卡复制的是**命令/标题**（`toolCallHeadline`），不是 stdout preview。

## 1. 背景与运维影响

`atOpsAgent.exportReport` 已在 `package.json` commands（`:110`）和 `commands.ts:106` 注册，**未**进入 `view/title`（`:116-141` 只有 newSession / history / playbook / abort / settings）。导出引擎 `workbenchService.exportReport`（`:74-107`）已能出 Markdown。

复制：webview 内 **零** `clipboard` / `codicon-copy`。`MarkdownBlock.vue` 只 `v-html` markdown-it；`ToolCallCard` 无复制钮；`ApprovalBar` 命令 `<pre class="approval__commands">` 无复制。

取消落盘：

```96:98:src/host/services/workbenchService.ts
    const filePath = target?.fsPath ?? path.join(os.tmpdir(), fileName);
    try {
      await fs.writeFile(filePath, markdown, 'utf8');
```

`showSaveDialog` 取消 → `target` 空 → **仍写入 tmp 并 `openTextDocument`**。注释 `:71` 把这当成特性，docs/15 明确要求取消零 IO。

主 UI 是 `ChatApp.vue` + `PlaybookHeader.vue`，**不是** `App.vue`。头部入口刻意交给 `view/title` 原生按钮（`PlaybookHeader.vue:8-12`），不要在 webview 标题栏再画一套导出/复制图标抢占位。全文复制可用命令或导出 md；P0-E 要的「复制」是三处局部 hover，不是必须再做一个「复制全文」标题栏按钮。全文需求用导出 md + 可选「复制到剪贴板」次按钮满足。

## 2. 硬约束

- 不要改 `DutyReport` 章节结构（除非 Plan 07 在 return 前刮密）。
- 不要做 share 链接、不要 mermaid。
- 不要给工具卡 stdout 一键复制（未脱敏；07 落地前尤其危险）。只复制 headline/命令。
- runtime / orchestrator / hub-host / policy 不参与本 plan。
- webview 内不要 `document.execCommand('copy')`。优先 `navigator.clipboard.writeText`，失败则 `postEnvelope('clipboard/write', { text })`，host 用 `vscode.env.clipboard.writeText`。

## 3. 现状代码

| 点 | 文件 | 现状 |
|----|------|------|
| 代码块 | `src/webview-chat/components/MarkdownBlock.vue` | markdown-it `html:false`；无 fence 包装按钮 |
| 工具卡 | `ToolCallCard.vue` | 头行 `headline` = `toolCallHeadline(call)`；展开才见 preview |
| 审批命令 | `ApprovalBar.vue:157` | `<pre class="ops-codeblock approval__commands">` |
| 导出命令 | `package.json:110`、`commands.ts:106` | 仅命令面板 |
| 历史 | `HistoryOverlay.vue:59-78` | 整行只 `switchSession`，无行内按钮 |
| 导出实现 | `workbenchService.ts:74` | 只导**活动**会话；取消写 tmp |
| 协议 | `hostController.ts:143` `chat/export` | 无 sessionId |
| store | `sessionStore.itemsOf(sessionId)` | 已支持非活动会话 |
| 收尾 | `playbookService.closePlaybook` | 无导出 notice |
| 测试 | `test/export-report.test.ts` | 只测 markdown 纯函数，不测对话框 |

## 4. 目标设计

### 4.1 共用复制 helper

新文件 `src/webview-chat/lib/clipboard.ts`：

```ts
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  postEnvelope('clipboard/write', { text });
  return true; // host 异步写；UI 仍给已复制反馈
}
```

hostController：

```ts
case 'clipboard/write':
  await vscode.env.clipboard.writeText(String((payload as { text?: string })?.text ?? ''));
  return { ok: true };
```

i18n：`copy` / `copied` / `copyAria`（`src/webview-chat/i18n.ts` zh+en）。

按钮模式：默认 `codicon-copy`；成功 1500ms 内 `codicon-check` + `t('copied')`。CSS hover 才 `opacity:1`（键盘 focus 也显示）。

### 4.2 代码块复制（MarkdownBlock）

自定义 `md.renderer.rules.fence`：外层 `.ops-md-fence`，右上角 copy 按钮，`pre>code` 仍是转义后的代码文本。复制内容 = token 原文（`token.content`），不要复制带行号的 HTML。

`html:false` 保持。按钮是 Vue 组件还是 fence HTML？**不要**把 Vue 事件写进 v-html。推荐：

- fence 输出 `<div class="ops-md-fence" data-copy="base64 或不用">` 不可靠（XSS/长度）。
- 改 MarkdownBlock 为：render 后 `onMounted` 对 `.ops-md pre` query + 插入 button（Mutation/updated 再绑）。更干净：把 fence 渲染成带 `data-ops-copy="1"` 的 pre，在 `updated()` 里 `querySelectorAll('pre.ops-codeblock, .ops-md pre')` 各插一个 button，listener 复制 `pre.innerText`。

选第二种，避免改 markdown-it 插件生态。注意重复绑定：先清 `.ops-copy-btn` 再插。

### 4.3 工具卡命令复制

`ToolCallCard.vue` 头行右侧、status 之前加按钮 `@click.stop="copyHeadline"`。`copyHeadline` = `headline`（已有 computed）。`aria-label` 用 `t('copyAria')`。

**不要**在展开区的 LogViewer/preview 上加复制。

### 4.4 审批命令集复制

`ApprovalBar.vue` 每个 `row.commands` 的 `<pre>` 包一层相对定位容器 + hover copy。复制文本 = `row.commands.join('\n')`。无 commands 的要素行不加按钮。

### 4.5 导出三入口

**入口 1 — view/title**

`package.json` `menus.view/title` 增加：

```json
{
  "command": "atOpsAgent.exportReport",
  "when": "view == atOpsAgent.chat",
  "group": "navigation@5"
}
```

插在 abort（@4）与 settings（@9）之间。`package.nls.json` 已有 `%cmd.exportReport%` 则不改文案。

**入口 2 — HistoryOverlay**

每条 `.history__item` 右侧 hover 图标按钮（`codicon-desktop-download` 或 `codicon-export`），`@click.stop`：

```ts
store.post('chat/export', { sessionId: session.id });
```

host `chat/export` 读 `payload.sessionId`，缺省 = 活动会话。`workbenchService.exportReport(sessionId?: string)`：`items = store.itemsOf(sessionId)`，title 从 `store.sessions` 找。

**入口 3 — 收尾 notice**

`PlaybookService.closePlaybook` 成功（stage===closed，Plan 03 之后一次 close 能成功）后：

```ts
ctx.emitAssistantNotice('巡检已关闭。可导出值班报告。', sessionId, {
  actions: [{ id: 'export-report', label: '导出 Markdown', command: 'atOpsAgent.exportReport' }]
});
```

看 `emitAssistantNotice` 现签名：若只接受 text，则 append 一条 `kind:'notice'` item，`actions` 走已有 `NoticeAction.command` 深链（`ChatTranscript.vue:278` 已渲染 `command:` href）。**不要**发明新协议。

无 playbook 的普通问答不发这条 notice。

### 4.6 取消零 IO

```ts
const target = await vscode.window.showSaveDialog({ ... });
if (!target) return { ok: false }; // 取消：零 write、零 openTextDocument
await fs.writeFile(target.fsPath, markdown, 'utf8');
await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
```

删除 `?? path.join(os.tmpdir(), fileName)`。更新函数注释，删掉「取消时落系统临时目录」。

可选次动作：对话框之后或 QuickPick「保存文件 / 复制到剪贴板」。P0-E 验收只要求 ≤2 点出 md；剪贴板次按钮**不要**挡主路径。若加 QuickPick，默认焦点必须是「保存 Markdown」。

## 5. 任务拆分

### T1. 取消不写 tmp

- 文件：`workbenchService.ts`
- 测试：新 `test/workbench-export.test.ts`，mock `showSaveDialog` → `undefined`，spy `fs.promises.writeFile`（该文件用的 `fs.writeFile` 是哪套：读 import——若 `import { promises as fs }` 则 spy 那套），assert 零调用；mock 返回 Uri 则一次 write 且内容为 markdown
- Done when：取消路径无 IO

### T2. clipboard helper + host case

- 文件：`webview-chat/lib/clipboard.ts`、`hostController.ts`、i18n 三键
- 测试：node 侧测 host case（mock `env.clipboard`）；webview helper 在 jsdom 测 clipboard 成功路径
- Done when：两边都能写下文本

### T3. 三处 hover 复制

- 文件：`MarkdownBlock.vue`、`ToolCallCard.vue`、`ApprovalBar.vue` + 少量 CSS（可放组件 scoped 或 `ops-tokens.css`）
- 测试：`test/webview-chat.test.ts` 若已挂组件，assert 工具卡存在 copy 按钮且 click 不 toggle expanded；否则用 `@vue/test-utils` 薄测 ToolCallCard
- grep 门：`rg -n "codicon-copy" src/webview-chat/components/{MarkdownBlock,ToolCallCard,ApprovalBar}.vue` 三文件都有命中
- Done when：三处可见复制；工具卡 copy 不含 preview 全文

### T4. view/title 导出

- 文件：`package.json` menus
- 测试：`test/extension.test.ts` 或 package 清单测若有 contributes 快照则更新；至少 `node -e "JSON.parse(fs.readFileSync('package.json')).contributes.menus['view/title']"` 含 exportReport
- Done when：Chat 视图标题栏出现导出图标

### T5. HistoryOverlay 按 sessionId 导出

- 文件：`HistoryOverlay.vue`、`workbenchService.ts` 签名、`hostController.ts` `chat/export`
- 测试：`itemsOf` 非活动会话的 markdown 含该会话 user 文本、不含活动会话独有文本（构造两个 bag）
- Done when：历史行能导非活动会话

### T6. close 后 notice

- 文件：`playbookService.ts` close 成功分支（与 Plan 03 同一函数：本 T 只加 notice，03 改 closeRun；**同 PR 或 03 之后再加**，避免两人都改 close 尾部——推荐本 T 在 03 合入后做，或同一 PR 由 03 作者在成功 return 前调 `emitExportNotice()`）
- 测试：close ok 后 `itemsOf` 含 notice + export action
- Done when：巡检收尾可见导出按钮

## 6. 执行命令

```bash
npx vitest run test/export-report.test.ts test/workbench-export.test.ts test/webview-chat.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] 标题栏导出 ≤2 击得到 md
- [ ] 历史条目可导出指定会话
- [ ] close 成功有导出 notice（有 playbook 时）
- [ ] 代码块 / 工具卡命令 / 审批命令 hover 复制有「已复制」
- [ ] 取消保存零 tmp
- [ ] 工具卡复制 ≠ stdout

## 8. 明确不做

- 不在 ChatApp 内再画一套与 view/title 重复的导出/设置按钮
- 不复制 tool preview/LogViewer 全文（07 刮密之后若要加，另开任务）
- 不改导出章节顺序、不做 JSON 格式（reviews §3.3 JSON 升到 P1 可选；本 P0 只 md）
- 不做 share 链接

## 9. 风险与回滚

- VS Code webview clipboard 权限：必须有 host fallback，否则「已复制」撒谎。host 写失败时 `describeError` log，按钮仍可显示已复制——可接受；不要 toast 打断值班。
- History 行加按钮易误触导出：必须 `@click.stop`，hit 面积 22px。
- 回滚：menus 删 export 行；`exportReport` 恢复 tmp fallback（不建议）。
