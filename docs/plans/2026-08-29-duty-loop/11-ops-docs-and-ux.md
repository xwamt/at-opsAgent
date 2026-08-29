# Plan 11 · 运维文档落盘、GuidedManual、历史管理、walkthrough/l10n

> Status: Ready to execute
> Source: docs/15 P1-4、P1-10、P1-11、P1-16；docs/reviews/round2/06-ux-features.md §3.2 / UX-8
> Depends on: Plan 07（`redactSecrets` 写入前刮密；未合入则 `looksLikeSecret` 拒绝）。Plan 03 若改 `tryAdvance`，GuidedManual `complete()` 的推进循环跟着用 legalNext，不要再写死 `['verifying','reporting']`——**03 合入后改 complete，或本 plan 先保持循环、03 再清**。
> Parallel-safe with: 08、10；避开 06 的 `runtime/index.ts` 大拆——本 plan 只在 `createOpsRuntime` extraTools 数组 **push 一个工具**。
> Module: `src/runtime/workspace-write.ts`、`skills/ops-documents/`、`guidedManual.ts`、`HistoryOverlay.vue`、`sessionStore.ts`、`media/walkthrough/`、`package.nls.*`

## 0. 一句话目标 + 完成判据

模型能把巡检/交接写成工作区 `ops-docs/` 下的 Markdown（write 走现有审批 + diff）；GuidedManual 无简报时用 notice 双按钮，不再让用户打「已完成」；历史可搜索/重命名/删除；walkthrough 英文文件能被 VS Code 加载；`workspaceShell` 文案改成只读文件访问。

完成判据：

1. 未批准前 `ops-docs/` 无新文件；批准后路径 `<workspace>/ops-docs/YYYY/MM/*.md` 存在且含模板必填段（缺则「未检查」）。
2. `../etc/passwd`、绝对路径、白名单外 `overwritePath` 全部 `{ok:false}`。
3. `buildGuidedManualNotice` **不含**「回复「已完成」」；notice `actions` 含打开插件 + 我已完成。
4. 历史：过滤标题、重命名写回 `ui-sessions.json`、删除后不可 switch。
5. `media/walkthrough/*.nls.en.md` 存在且旧 `*.en.md` 删除或改名；`config.workspaceShell.enabled` 中英文都不出现「执行 Shell 命令」作为能力描述。

## 1. 背景

无 `ops_write_*`。`workspace-write.ts` 不存在。`skills/` 无 `ops-documents/`。`ops_read_skill` 只能读 skills 根（`resource-loader.ts:146`）。

GuidedManual 无简报路径（`guidedManual.ts:62`）：

```
- 完成后回复「已完成」，链路将推进到验证 / 报告阶段。
```

有简报时 ApprovalBar 已有「去 IDE 操作 / 我已在 UI 完成」（`ApprovalBar.vue:80-81` i18n）。无简报只靠模型理解「已完成」——不可靠。

`sessionStore` 有 `newSession` / `switchSession` / `itemsOf`，**无** rename/delete。`HistoryOverlay` 整行切换。hostController 无 `session/rename` / `session/delete`。

walkthrough：`media/walkthrough/configure-model.en.md` 等 3 个文件。VS Code 查找顺序是 `doc.nls.<locale>.md` → `doc.nls.md` → `doc.md`（vscode#129461）。`.en.md` **永不加载**。

`workspaceShell.enabled`：实现只注册 `ops_read_workspace_file`（`workspace-read.ts:4-7`），nls 却写「执行 Shell 命令」（`package.nls.zh-cn.json:34`、`package.nls.json:34`、settings i18n `cfgWorkspaceShellDesc`）。

## 2. 硬约束

- **不要**默认打开 pi `write`/`edit`/`bash`。文档工具是 host 内置 `OpsCustomToolSpec`，路径牢笼只写 `ops-docs/`。
- **不要**把 Jenkins/Nacos 写操作做成 MCP。GuidedManual 仍 `executeCommand` 插件命令。
- runtime 禁止 import vscode。diff 预览、打开编辑器、QuickPick 在 **host** `applyToolGate` 批准后的 execute 回调里做——推荐：runtime 工具只返回「将写路径 + markdown」；真正 `fs.writeFile` 放 host handler，与 Terminal 远程执行同一闸门模型。
- 最小可执行拆法（避免 runtime 写盘却无法 `vscode.diff`）：
  1. `workspace-write.ts` 纯函数：校验路径、补「未检查」、返回 `{ absPath, markdown }`（abs 仍相对 workspace 逻辑路径）。
  2. 工具 `execute` 调 host 注入的 `writeOpsDoc(req)`（handlers 新方法），host 内：闸门已在 `applyToolGate`（risk=write）通过后才进 execute → `fs.writeFile` + `openTextDocument`。diff：在 **gate 之前** 难开 UI；docs/15 要求「批准前 vscode.diff」。因此：
     - `applyToolGate` 对 `ops_write_ops_doc` 建简报时 `elements.commands` = 路径 + 行数 + 前 40 行；
     - host `registerBrief` 之后 `vscode.commands.executeCommand('vscode.diff', left, right, title)`，left = 现有文件或空 untitled，right = 待写内容 untitled。失败只 log。
- 用户 hover「存为运维文档」：风险主体是用户，**可跳过审批**（reviews §3.2）。单独 host 命令 `atOpsAgent.saveOpsDoc`，不走模型工具。

## 3. 现状代码

工具注册：`createOpsRuntime` extraTools（`runtime/index.ts:1236-1242`）已有 `ops_read_skill`、条件 `ops_read_workspace_file`。在此后 `push(gatedTool(createWriteOpsDocTool(handlers)))`。

`OpsCustomToolSpec`（`resource-loader.ts:132-143`）含 `risk?: 'read'|'write'|'exec'`。本工具 `risk: 'write'`。

`PlaybookToolHost` / `OpsRuntimeHandlers`：加

```ts
writeOpsDoc?(req: WriteOpsDocRequest): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
```

host 实现放 `src/host/services/opsDocService.ts`。

Guided：`buildGuidedManualNotice`、`GuidedManualFlow.maybeEmitNotice` 只 `emitAssistantNotice(string)`——需扩展 notice 支持 actions（看 `emitAssistantNotice` 签名；若无 actions，改为 `store.appendItem({ kind:'notice', actions:[...] })`）。

## 4. 目标设计

### 4.1 `ops_write_ops_doc`（P1-4）

参数：

```ts
{
  docType: 'operation-record' | 'troubleshooting-report' | 'deployment'
         | 'inspection-report' | 'handoff' | 'emergency-plan',
  title: string,
  markdown: string,
  overwritePath?: string
}
```

路径：

- 默认：`<workspaceFolder>/ops-docs/${YYYY}/${MM}/${slug(title)}.md`
- 无 workspace：`~/.at-series/agent/ops-docs/${YYYY}/${MM}/...`（与 tool-results 同树，仍非插件凭据）
- `overwritePath` 必须 `resolve` 后仍在上述根下
- 拒绝 `..`、绝对路径（overwrite 若绝对，也要验证 prefix）
- 单文件 256KB；超限失败
- Plan 07：`markdown = redactSecrets(markdown).text`

模板目录 `skills/ops-documents/`：

| 文件 | docType |
|------|---------|
| `SKILL.md` | 索引：何时用哪类 + 「用 ops_write_ops_doc，不要 bash」 |
| `inspection-report.md` | inspection-report |
| `troubleshooting-report.md` | troubleshooting-report |
| `handoff.md` | handoff |
| `operation-record.md` | operation-record |
| `deployment.md` | deployment |
| `emergency-plan.md` | emergency-plan |

每个模板含固定 `##` 标题（文档信息、背景目标、现状证据、步骤、验证、回滚、交接）。`ensureTemplateHeadings(markdown, docType)`：缺标题则追加 `## X\n\n（未检查）\n`。

L3 或 reporting L4 加一句：写文档先 `ops_read_skill` 对应模板，再 `ops_write_ops_doc`。Writer 子代理若有契约文件，加 `docType` 字段；没有则只改 L3，不要为这事新造角色。

审批简报：`approvalGate.buildApprovalElements` 对 toolName===`ops_write_ops_doc` 把 commands 换成「将写入 `path`（+N/-M 行）\n」+ 前 40 行。diff 见 §2。

测试：`test/workspace-write.test.ts` 纯函数路径牢笼 + 补段；host 测 mock gate approved 才写盘。

### 4.2 GuidedManual 双按钮（P1-10）

`buildGuidedManualNotice` 删除「回复「已完成」」行。`maybeEmitNotice` 发 `kind:'notice'`：

- actions: `{ id:'gm-open', label:'打开对应插件', }` → 现有 `guidedManual/open`
- `{ id:'gm-complete', label:'我已在 UI 完成' }` → 现有 `guidedManual/complete`

复用 `store.runNoticeAction` → post 已有 type。无 playbook command 时仍出 complete 按钮，open 失败已有 notice。

`test/guided-manual.test.ts`（若无则建）：notice 文本不含 `已完成` 作为用户输入指令；含两个 action id。

### 4.3 历史搜索/重命名/删除（P1-11）

`sessionStore`：

```ts
renameSession(id: string, title: string): boolean  // trim，空拒，TITLE_MAX_CHARS
deleteSession(id: string): boolean  // 删 bag + sessions 项；若删的是活动会话则 newSession 或切到最近一条；禁止删光后无活动 id
```

persist 立即 `schedulePersist`。

hostController：

- `session/rename` `{ id, title }`
- `session/delete` `{ id }`

`HistoryOverlay.vue`：

- 顶栏 `<input>` 过滤 `store.historySessions`（标题 includes，大小写不敏感）
- 每行：标题可双击编辑 / 小铅笔；删除 `codicon-trash` 需 `window.confirm` 或 VS Code `showWarningMessage`（webview 用 `post('session/delete')` 前 `confirm` 即可）
- `@click.stop` 防止误切会话

`workspaceShell` 文案三处同步：`package.nls.json`、`package.nls.zh-cn.json`、`webview-settings/i18n.ts`（zh+en `cfgWorkspaceShell` / Desc）。建议：

- 中文：`允许 Agent 只读访问工作区文件（限工作区路径、单文件 64KB）。默认关闭。不提供 Shell。`
- 英文：`Allow read-only workspace file access (cwd-bound, 64KB). Off by default. Does not enable a shell.`

`test/settings-ui.test.ts` 快照若含旧文案则更新。

### 4.4 walkthrough + host l10n（P1-16）

```
git mv media/walkthrough/configure-model.en.md media/walkthrough/configure-model.nls.en.md
git mv media/walkthrough/install-plugins.en.md media/walkthrough/install-plugins.nls.en.md
git mv media/walkthrough/first-playbook.en.md media/walkthrough/first-playbook.nls.en.md
```

`package.json` walkthrough `markdown` 仍指向无 locale 的 `*.md`（中文默认）。不要把 markdown 字段改成 nls 文件名。

host 高频中文：`workbenchService` QuickPick placeholder、导出对话框 title、`activate.ts` 状态栏，改为 `vscode.l10n.t('...')`。新增：

- `l10n/bundle.l10n.json`（默认中文或英文——VS Code 约定：`bundle.l10n.json` 是源语言；本扩展源是中文则源中文 + `bundle.l10n.en.json`）
- 若引入成本高：本 T 最低完成 **walkthrough 改名** + workspaceShell nls；host `l10n.t` 作为 T4b，允许同一 PR 后半段。

`test/walkthrough-nls.test.ts`：assert `fs.existsSync('media/walkthrough/configure-model.nls.en.md')` 且 **不存在** `.en.md`。

## 5. 任务拆分

### T1. 纯函数路径 + 模板 + 补段

- 文件：`src/runtime/workspace-write.ts`、`skills/ops-documents/**`、`test/workspace-write.test.ts`
- Done when：六模板可被 `ops_read_skill` 读到（路径 `ops-documents/inspection-report.md`）；逃逸用例全拒

### T2. 工具注册 + host 写盘 + 简报 diff

- 文件：`runtime/index.ts` extraTools、`hostTypes` handlers、`opsDocService.ts`、`approvalGate.ts`
- 测试：gate reject → 无文件；approve → 文件存在
- Done when：write 风险走 ApprovalBar

### T3. 用户「存为运维文档」命令

- 文件：`commands.ts`、`ChatTranscript` assistant hover（可与 Plan 09 copy 按钮并排）
- 跳过审批；QuickPick docType；把当前 assistant.text 当 markdown
- Done when：无模型调用也能落盘

### T4. GuidedManual notice 双按钮

- 文件：`guidedManual.ts`、`guidedManualFlow.ts`、测试
- Done when：文案无「回复已完成」

### T5. 历史 CRUD + 搜索

- 文件：`sessionStore.ts`、`hostController.ts`、`HistoryOverlay.vue`、`store.ts` post
- 测试：`test/session-store.test.ts` rename/delete/persist
- Done when：删除活动会话不会留下悬空 runtime（切走或 new 后 `pool` 对旧 id 驱逐——调已有 `onSessionEvicted`）

### T6. nls / walkthrough / workspaceShell 文案

- 文件：见 §4.3–4.4
- Done when：英文 walkthrough 文件名符合 VS Code；settings 文案与 workspace-read 一致

## 6. 执行命令

```bash
npx vitest run test/workspace-write.test.ts test/session-store.test.ts test/settings-ui.test.ts test/walkthrough-nls.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] ops_write_ops_doc 白名单 + 审批 + 六模板
- [ ] GuidedManual 双按钮，不靠打字
- [ ] 历史搜索/重命名/删除
- [ ] walkthrough `.nls.en.md`
- [ ] workspaceShell 文案只读
- [ ] 无 pi write/edit

## 8. 明确不做

- 通用文件编辑器、自定义 md 编辑 webview
- 状态条三字段 / 空态三建议 / 切模型 InformationMessage（reviews 可选项，**不是** docs/15 P1-4/10/11/16；不要塞进本 PR）
- Jenkins 写 MCP

## 9. 风险

- runtime 直接写盘会绕过 diff：必须 write 发生在 gate 通过之后的 host handler。
- 删除会话忘记 abort runtime：复用 `chatService` 驱逐路径。
- 模板中文/英文：模板用中文标题（主受众）；L3 写明 docType 枚举英文 key。
