# 06 · 用户友好度与实用基线功能审计（Round 2）

> 审计对象：main `b099484`（fix: show inspection reports and stop swallowing assistant text）。
> 审计方法：逐文件读当前代码（docs/11 已过期，本文所有结论以代码为准），全量测试 487/487 通过。
> 范围：①用户友好度 ②运维文档编辑 ③会话导出 ④邻近实用功能。竞品对照：OpenCode / Kilo Code / Codex CLI / Claude Code（2026-08 现状，见 §1.3 表）。

---

## 1. 现状诊断

### 1.1 docs/11 的 P0/P1 到底落了没有（逐项核实）

| 项 | docs/11 编号 | 状态 | 代码证据 |
|----|----|----|----|
| 首跑向导 + 未配置拦截 | P0-B | ✅ 已落地 | `WelcomeState.vue`（`needsSetup` → 主 CTA 卡直达 Models）；`Composer.vue`（未配置发送 → `blockedHint` 内联提示条 + CTA，不清草稿）；`ModelSelector.vue`（空态是可点按钮不是 disabled option）；`activate.ts`（状态栏黄色「AT Ops 未配置」点击直达 Models）；`webview-settings/i18n.ts` `mFirstRunHint` 三步文案 + 「保存并测试」+ 401 人话 |
| VS Code 官方 walkthrough | P2-1 | ✅ 已落地（有 i18n 缺陷，见 §1.5） | `package.json` contributes.walkthroughs 三步 + `media/walkthrough/*.md` |
| 会话持久化 + 续接 | P1-3 / P0-C | ✅ 已落地 | `sessionStore.ts`：`~/.at-series/agent/ui-sessions.json`（0600、50 会话上限、标题取首条用户消息、重载后 running 工具标 interrupted）；`sessionFile` 记 pi JSONL 供 runtime 续接 |
| 值班报告一键导出 | P1-10 | ⚠️ **半落地** | 逻辑 `exportReport.ts` + 命令 `atOpsAgent.exportReport` + 测试 `export-report.test.ts` 都在；**但没有任何 UI 入口**（详见 §1.3） |
| 失败重试 | P1-5 | ✅ 已落地 | `ChatTranscript.vue`（`error && retryable` → Retry 按钮）|
| context 水位条 | P1-4 | ✅ 已落地 | `Composer.vue` 4px 进度条 + hover token 详情 |
| 软停 / 硬停两档 | P2 | ✅ 已落地 | `Composer.vue` Cancel（等当前工具）/ Stop（立即 abort）；标题栏 `atOpsAgent.abort` 带 `when: atOpsAgent.running` |
| 工具卡折叠 + 只读聚合 | P1-2 | ✅ 已落地 | `ToolCallCard.vue` 默认折叠；`store-helpers.buildRenderList` ≥3 连续只读聚合 |
| 巡检结论可见性兜底 | docs/14 P0-report | ✅ 已落地 | `inspectionSummary.ts`（无可见结论 → 按工具 preview 合成中文报告，「未在上文出现的检查项请视为未检查」）+ 9 条单测 |
| 头部去重 / 单视图收敛 | P1-3(UI) | ✅ 已落地 | `PlaybookHeader.vue` 只剩身份 chip；历史/Playbook/设置全走 view/title |

结论：**P0-B 已完整落地，P1-10 只落了一半**（引擎在、方向盘没装）。

### 1.2 首跑 2 分钟走查（代码推演）

安装 → 活动栏图标 → WelcomeState（标题 + 副标题 + 警示卡「完成一次模型配置（约 1 分钟）」）→ 点 CTA → 设置页 Models（三步提示、预设 provider、粘 key、「保存并测试」即时连通性验证、401/网络错误人话）→ 回聊天，composer 模型选择器出现 → 发问。**链路成立，2 分钟可达。** 加分项：未配置时 playbook 建议卡降饱和但仍可浏览（不藏能力）；`isComposing` 守卫让中文输入法回车不误发；`prefers-reduced-motion`、aria-label、focus-visible 全线覆盖，无障碍质量高于同类。

剩余摩擦：① Hub 无任何能力插件时，欢迎页没有第二张空态卡——「已连模型但没插件」的用户要靠命令面板跑「诊断 Hub」才知道缺什么（`diagnose.ts` 的提示只进 Output Channel）；② walkthrough 第 2 步完成事件是 `onCommand:atOpsAgent.diagnoseHub`，跑完只弹 Output，新手看不懂 stale/fresh 记录表。

### 1.3 会话导出现状与竞品差距

当前实现（`exportReport.ts` + `workbenchService.exportReport`）：当前会话 transcript + 工具调用表 + 证据便签 + 审批记录（含未决 ⏳）+ playbook 阶段轨迹 → 中文 Markdown；showSaveDialog 选路径，**取消时静默落系统临时目录并照样打开**；文件名 `at-ops-report-YYYYMMDD-HHMM.md`；报告尾注明「审批令牌与凭证不会出现在报告中」。

| 能力 | OpenCode | Kilo | Codex CLI | Claude Code | 我们 |
|----|----|----|----|----|----|
| MD 导出 | `/export`（ctrl+x x）| `/export` + History 菜单「Export session transcript」 | ❌（社区工具） | `/export`（文件/剪贴板） | ✅ 但**仅命令面板** |
| JSON / 结构化导出 | `opencode export` JSON | `kilo export` JSON | JSONL 原生（`~/.codex/sessions`） | JSONL（内部格式不承诺） | ❌ |
| 脱敏 | `--sanitize`（redact transcript/file 数据） | ❌ | ❌ | ❌ | ❌（工具 preview 原样入报） |
| 复制最后回复 | — | `/copy` | — | `/copy [N]` + 代码块选择器 | ❌ |
| 非当前会话导出 | ✅（按 sessionID） | ✅（History 菜单） | ✅ | ✅ | ❌（只导活动会话） |
| 分享 URL | `/share` 公网 | `/share` | ❌ | ❌ | ❌（运维场景**不该做**） |

我们的导出**内容维度是竞品没有的**（审批记录、证据三态、阶段轨迹——这正是值班报告的骨架），但入口、脱敏、JSON、跨会话四项都缺。协议里的 `'chat/export'` 分支（`hostController.ts:143`）**没有任何 webview 代码发送它，是死协议**。

### 1.4 运维文档编辑现状：**完全缺失**

- **Agent 没有任何文件写入工具。** `src/runtime` 全部工具面：发现 5 件套 + 业务工具（hub 代理）+ `ops_read_skill` + 可选 `ops_read_workspace_file`（只读、64KB、限 cwd、默认关）。没有 write / edit / diff。
- **Writer 子代理产物只活在聊天里。** `subagents.ts`：writer 角色 `allowTools` 强制清空、契约 `ops-doc` 是自由 markdown——写完只能作为消息滚走，无法落盘、无法二次编辑。
- **模板库没进产品。** `docs/research/findings/03` C3.4 明确了 6 类模板（troubleshooting-report / service-inspection / service-deployment / general-ops-document 等），但 `skills/` 只有 playbook references 里的**纪律句子**（如 daily-inspection reporting.md 的「主会话必须自己写出中文 markdown 巡检结论」），没有 `ops-documents/` 模板文件可供 `ops_read_skill` 加载。
- **占位符纪律只在 prompt 层。** 「待确认 / 未检查 ≠ 正常」在 13 处 skill 文件里重申，且 `inspectionSummary.ts` 合成报告尾部有兜底句，但没有任何结构化校验（模板必填段、占位符残留检查）。
- **@file 附件是半条死路。** `workbenchService.pickAsset` 会列工作区文件，但 `chatService.handlePrompt` 对 file 附件只追加 `[附件] <uri>` 一行文本；`workspaceShell.enabled` 默认 false 时模型**没有工具读这个文件**——用户附了等于没附。

### 1.5 i18n 现状

- ✅ 两个 webview（chat / settings）各自完整的 zh-CN/en 双语包，`<html lang>` 注入 + hydrate 切换，工程质量好。`package.nls.json` / `package.nls.zh-cn.json` 全键覆盖。
- ❌ **walkthrough 英文文件是死文件。** VS Code 对 walkthrough markdown 的本地化解析顺序是 `doc.nls.<locale>.md` → `doc.nls.md` → `doc.md`（vscode#129461 实现）。当前 `media/walkthrough/configure-model.en.md` 等 3 个文件命名不符，**永远不会被加载**；英文 locale 用户拿到中文 walkthrough 正文（标题/描述倒是英文的，更显割裂）。
- ❌ **host 侧运行时字符串纯中文硬编码**：状态栏（`AT Ops 未配置`）、`commands.ts` 全部 QuickPick placeholder / 警告、`diagnose.ts` 输出、导出报告全部标题与风险标签（`exportReport.ts`）、GuidedManual 提示（`guidedManual.ts`）、巡检合成报告（`inspectionSummary.ts`）。目标用户以中文为主，可接受，但与 webview 的严格双语标准不一致，导出物给英文同事看时是问题。
- ❌ **设置文案与实现相悖**：`config.workspaceShell.enabled` 的 nls 说 "Allow the agent to run shell commands in the workspace"，设置页说「允许受限的工作区内 shell 命令」，实际（`runtime/workspace-read.ts`）只注册**只读文件读取**。夸大能力的文案比缺功能更伤信任。

### 1.6 GuidedManual 现状

- ✅ 有简报（brief）路径：`ApprovalBar.vue` guided 变体两段式布局——「去 IDE 操作」（command 深链或 `guidedManual/open`）+「我已在 UI 完成」（确定性推进 `guidedManual/complete` → verifying/reporting）+「拒绝」；插件未安装时 open 失败有兜底 notice。300px 下按钮组可换行不溢出。
- ⚠️ 无简报路径（进入 guidedManual 阶段的文本 notice，`guidedManualFlow.maybeEmitNotice`）：文案让用户**「完成后回复『已完成』」**——这句话进模型当普通 prompt，靠模型自觉调 `ops_advance_stage`，没有 host 侧确定性推进；且 notice 里的推荐命令是代码字面量（`` `atJenkins.triggerBuild` ``）不是可点的 `command:` 链接（webview 已开 enableCommandUris，`openArtifact` 深链在用同机制）。同一功能两条路径一个确定、一个碰运气。
- ⚠️ `noticedRuns` 防重是内存 Set，扩展主机重载后同一 run 会再发一次提示（影响小，记录在案）。

---

## 2. 用户友好度问题清单（按值班痛感排序）

> 排序依据：值班/on-call 场景的动作频率 ×被阻断程度。300px 侧栏、事故进行中、需要随时把结论贴给群里/工单，是基准画像。

| # | 问题 | 证据 | 痛感理由 |
|---|------|------|---------|
| UX-1 | **导出报告无 UI 入口**：不在 view/title、不在历史面板、webview 没按钮、`chat/export` 协议死路，只能命令面板打「导出会话报告」 | `package.json` menus 只有 5 项；`HistoryOverlay.vue` 条目无动作；grep `'chat/export'` 无 webview 发送方 | 交接班/事故收尾是导出高频时刻，功能已做但**发现率≈0**。Kilo 在 History 菜单 + slash 双入口，Claude/OpenCode 有 slash + 快捷键 |
| UX-2 | **全线无复制按钮**：工具卡的命令/输出、assistant 结论、审批命令集、证据便签，都只能手工拖选 | `ToolCallCard.vue` / `MarkdownBlock.vue` / `ApprovalBar.vue` 无 clipboard 调用（全仓 grep 无 `navigator.clipboard`） | 值班最高频动作是「把这段贴到 IM/工单」。Claude Code `/copy` 带代码块选择器、Kilo `/copy-session`，我们为零。300px 下拖选 `<pre>` 尤其痛苦 |
| UX-3 | **报告/巡检结论无法落盘成文档**：Writer 产物、巡检合成报告只在聊天流里，会滚走、会被 50 会话上限淘汰 | §1.4；`sessionStore.ts` MAX_PERSISTED_SESSIONS=50 | 运维文档（操作记录/RCA/巡检/交接）是这个产品的**交付物**，现在交付物没有出口 |
| UX-4 | **历史会话无搜索、无重命名、无删除** | `HistoryOverlay.vue` 只有列表 + 新建；`SessionsTab.vue` 同样只读 | 「上周五那次 5xx 是怎么处理的」是交接班标准问题；标题自动取首条消息 40 字，无法搜索时 50 条列表基本靠翻。Codex `/rename`、OpenCode `session delete` 均有 |
| UX-5 | **导出无脱敏**：工具 preview（日志/配置/SQL 结果）原样进报告，尾注「凭证不会出现在报告中」只对审批令牌/API key 成立，对**业务数据中的秘密**不成立 | `exportReport.ts` `cell()`/`truncate()` 只截断不脱敏 | 报告的用途就是转发。一次把带 `Authorization: Bearer …` 的 Loki 日志贴进群，信任就没了。OpenCode `--sanitize` 已是行业基线 |
| UX-6 | **GuidedManual 无简报路径靠「回复已完成」** | §1.6 | 发布/配置变更是写操作链路的收口，收口动作不确定 = 用户不知道链路卡在哪 |
| UX-7 | **@file 附件默认死链** | §1.4 末条 | 用户明确做了「附上这个文件」的动作，Agent 静默拿不到内容且不报错——比没有这功能更糟 |
| UX-8 | **英文 walkthrough 死文件 + host 中文硬编码** | §1.5 | 中文主受众下痛感中等，但 `.en.md` 三个文件是已写完却因命名永不生效的浪费 |
| UX-9 | **workspaceShell 文案夸大**（说 shell，实际只读文件） | §1.5 | 一行文案改动；安全承诺表述失真在审计场景是硬伤 |
| UX-10 | **导出取消 ≠ 取消**：save 对话框点取消，仍写临时目录并打开编辑器 | `workbenchService.exportReport`（注释自述该行为） | 违反平台惯例；含敏感内容时用户「取消」的意图应被尊重 |
| UX-11 | **无插件时欢迎页无能力空态** | §1.2 | 首跑第二步（装插件）的引导只存在于 walkthrough 与 Output，主界面没有 |
| UX-12 | Ops 看板（openBoard）只有命令面板入口；证据便签的 pin 图标是纯装饰（无 pin/取消动作，`pin-guard.test.ts` 测的是 L0 提示词 pin，与 UI 无关） | `commands.ts`、`EvidenceNote.vue` | 低频，但「pin 住关键证据置顶/入报告」是证据板对 scrollback 的核心价值 |

做得好、应保持的：审批 9 要素默认双确认、风险三色 + 文字双通道、结论三态永不只靠颜色、未配置四处一致引导（欢迎卡/composer/选择器/状态栏）、软硬停两档、transcript 虚拟化 + IME 守卫、`ui-sessions.json` 0600、导出明示未决审批。

---

## 3. 文档编辑与会话导出设计

### 3.1 目标与红线

目标：**会话是过程，文档是交付物**——值班报告、巡检记录、RCA、交接单能从会话一键产出为工作区 Markdown 文件，可编辑、可复导、可脱敏分享。
红线：不做通用文件编辑器；不发明 MCP 写工具（ADR/docs/07 纪律不破——写文档走 **host 内置工具**，与插件工具面无关）；写盘限白名单目录；write 风险沿用现有 ApprovalBar 审批链，不新开旁路。

### 3.2 运维文档编辑（Agent 写、用户改、可复审）

**新增 host 内置工具 `ops_write_ops_doc`**（`src/runtime/workspace-write.ts`，与 `workspace-read.ts` 对称）：

```ts
// 参数
{
  docType: 'operation-record' | 'troubleshooting-report' | 'deployment'
         | 'inspection-report' | 'handoff' | 'emergency-plan',
  title: string,
  markdown: string,          // 全文
  overwritePath?: string     // 二次编辑已有文档时给出（仍限白名单目录）
}
```

- **落盘路径白名单**：`<workspace>/ops-docs/YYYY/MM/<slug>.md`；无工作区时 `~/.at-series/agent/ops-docs/`。拒绝 `..`、绝对路径、白名单外 overwritePath。
- **风险 = write → 走现有审批**：简报 9 要素中 `commands` 换成「目标路径 + 新增/修改行数 + 前 40 行摘录」；批准前 host 调 `vscode.diff` 打开「现有内容（或空）vs 待写内容」预览——审批人看到的就是将要落盘的字节。拒绝则不落盘。
- **模板库**：新增 `skills/ops-documents/`——6 个模板 md + 一个 `SKILL.md` 索引（对齐 research C3.4 的段落骨架：文档信息与修订 → 背景目标 → 现状证据 → 步骤表（预期/实际/失败处理）→ 验证 → 回滚 → 交接）。L4 在 reporting 阶段注入「模板选择表」；Writer 子代理契约升级为 `ops-doc@1`，要求带 `docType` 字段。
- **占位符结构化校验**（写盘前 host 侧纯函数）：模板必填段标题缺失 → 自动补「（未检查）」段而非静默通过；扫描残留的空表格行提示「待确认」。对齐 skills 全线纪律「未检查 ≠ 正常」。
- **用户侧 UX**：assistant 消息 hover 动作「存为运维文档」→ QuickPick 选 docType → 复用同一条 `ops_write_ops_doc` 落盘路径（用户主动触发的可跳过审批，风险主体是用户自己）→ 打开编辑器。用户后续编辑就是普通 VS Code 编辑，不做自定义编辑器。

### 3.3 会话导出升级（P1-10 → 完整值班报告）

**数据模型 `DutyReportV1`**（zod schema，MD 与 JSON 同源渲染，`buildOpsReportMarkdown` 改为消费该结构）：

```ts
interface DutyReportV1 {
  version: 1;
  meta: { sessionId: string; title: string; generatedAt: string;
          locale: 'zh-CN' | 'en'; appVersion: string;
          playbook?: { id: string; stage: string } };
  dialogue: Array<{ role: 'user' | 'assistant' | 'system'; text: string; error?: boolean }>;
  toolCalls: Array<{ name: string; pluginId?: string; risk: 'read'|'write'|'exec';
                     status: string; durationMs?: number; preview?: string;
                     error?: { code?: string; message: string } }>;
  evidence: Array<{ taskId: string; confidence: 'confirmed'|'hypothesis'|'pending';
                    summary: string; pinned?: boolean;
                    refs: Array<{ kind: string; preview: string }> }>;
  approvals: Array<{ briefId: string; risk: string; targetLabel: string;
                     decision: 'approved'|'rejected'|'pending'; ts?: number }>;
  stages: Array<{ ts: number; from?: string; stage: string }>;
  redaction: { applied: boolean; rules: string[]; hits: number };
}
```

- **脱敏 pass（默认开、导出对话框可关）**：`Authorization|Bearer|token|api[-_]?key|password|secret` 赋值右值替换为 `[REDACTED]`；PEM 私钥块整体剔除；`${secret:*}` 占位符保留原样（本来就是脱敏形态）；IP **默认不掩**（运维报告需要定位主机），提供可选开关。命中数写进 `redaction.hits` 并在 MD 尾注展示——对齐 OpenCode `--sanitize` 的语义，比它更透明（报告自证脱了多少）。
- **三个入口**：① `package.json` view/title 加 export 图标（`navigation@5`，`when: view == atOpsAgent.chat`）；② `HistoryOverlay.vue` 条目 hover 导出图标——`exportReport(sessionId)` 支持非活动会话（`store.itemsOf(sessionId)` 已具备，`workbenchService` 只差把 sessionId 参数穿进去）；③ playbook 到达 reporting/closed 时发一张带 action 的 notice 卡「导出值班报告」（`NOTICE` action + `command:` 深链机制已有，零新协议）。
- **格式**：QuickPick 二选一 Markdown / JSON；另给「复制到剪贴板」次按钮（`vscode.env.clipboard`）。
- **i18n**：标题、章节名、风险标签按 `vscode.env.language` 走双语表（host 侧首个正经 i18n 消费点，用 `vscode.l10n`）。
- **修正取消语义**：save 对话框取消 = 什么都不发生；「导出到临时目录」如需保留，做成 QuickPick 显式选项。

### 3.4 邻近实用功能

- **复制**：`ToolCallCard` 头部 hover copy（优先复制 preview 中的命令行）；`MarkdownBlock` 渲染的 `<pre>` 注入 copy 角标（markdown-it 渲染后统一挂）；`ApprovalBar` 命令集块 copy。均 `navigator.clipboard.writeText` + 1.5s「已复制」反馈。
- **历史搜索**：`HistoryOverlay` 顶部 filter input，本地 `title.includes()` 即可（上限 50 条无需索引）；顺手加重命名（inline 编辑，写回 `sessionStore`）与删除（确认后从 `ui-sessions.json` 移除；pi JSONL 只解引用不删文件，保留审计原料）。
- **Pin 证据**：`EvidenceNote` pin 图标变可点动作 → `evidence.pinned`，时间线条带置顶常显 + 导出报告新增「置顶证据」首节。
- **@file 附件闭环**：`workspaceShellEnabled=false` 时由 host 直接读附件内容（复用 `workspace-read.ts` 的 64KB/路径校验逻辑）注入 prompt 的 `[附件]` 段；开着时保持现状（模型自己按 uri 读）。附件永远不再是静默死链。
- **插件深链**：`HostSessionChip` 可点 → 复用 `guidedManual/open` 的命令执行通道（pluginId → 聚焦命令映射表，如 `at.terminal → atTerminal.focusSession`），失败兜底 notice 已有。

---

## 4. 整改清单

### P0（本迭代必做）

| ID | 内容 | 涉及文件 | 验收标准 |
|----|------|---------|---------|
| P0-1 | 导出三入口 + 跨会话导出：view/title 图标；HistoryOverlay 条目导出；reporting/closed notice 卡 action；`exportReport(sessionId?)` | `package.json`（menus）、`HistoryOverlay.vue`、`store.ts`（发送 `chat/export`，激活死协议）、`workbenchService.ts`、`playbookService.ts` | 不开命令面板，≤2 次点击从任意历史会话得到 .md；`webview-chat.test.ts` 补 history 导出 case；save 取消不产生任何文件 |
| P0-2 | 复制按钮三处（工具卡命令 / MD 代码块 / 审批命令集） | `ToolCallCard.vue`、`MarkdownBlock.vue`、`ApprovalBar.vue`、chat `i18n.ts`（新键 zh/en 双语） | hover 可见、点击有「已复制」反馈；300px 宽度不换行溢出 |
| P0-3 | `ops_write_ops_doc` + diff 预览 + 审批 + 6 模板：运维文档从会话落盘 | 新 `src/runtime/workspace-write.ts`、新 `skills/ops-documents/**`（6 模板 + SKILL.md）、`src/prompts/layers.ts`（L3 报告纪律指向模板）、`subagents.ts`（ops-doc@1 契约）、`approvalGate.ts`（diff 摘要入简报）、新 `test/workspace-write.test.ts` | 「把本次巡检写成报告存档」→ 出 write 简报含 diff → 批准后 `ops-docs/YYYY/MM/*.md` 出现且必填段完整（缺检项补「未检查」）；拒绝不落盘；路径逃逸用例全拒 |
| P0-4 | 导出脱敏 v1 + JSON 双格式（DutyReportV1 + zod） | `exportReport.ts`（结构化重构 + redact pass）、`workbenchService.ts`（格式 QuickPick + 剪贴板）、`export-report.test.ts` | 注入 `Authorization: Bearer xxx` 的 preview 导出后为 `[REDACTED]` 且 `redaction.hits=1`；JSON 过 zod 校验；MD/JSON 内容同源一致 |

### P1

| ID | 内容 | 涉及文件 | 验收标准 |
|----|------|---------|---------|
| P1-1 | GuidedManual 无简报路径结构化：notice 换成带 action 的卡（「去 IDE 操作」/「我已完成」→ `guidedManual/complete`），删除「回复『已完成』」话术 | `guidedManual.ts`、`guidedManualFlow.ts`、`ChatTranscript.vue`（notice action 已支持 command href） | 无简报场景下两次点击确定性推进到 verifying，timeline 记 `guided_manual` 事件；不再依赖模型理解自然语言回报 |
| P1-2 | 历史搜索 + 重命名 + 删除（双入口同步：HistoryOverlay 与 SessionsTab） | `HistoryOverlay.vue`、`SessionsTab.vue`、`sessionStore.ts`、`hostController.ts`（新 `session/rename`、`session/delete` 请求） | 输入关键字实时过滤；删除后 `ui-sessions.json` 移除该会话、pi JSONL 保留；50 条上限语义不变 |
| P1-3 | @file 附件闭环（host 读内容注入，64KB 截断复用 workspace-read 校验） | `workbenchService.pickAsset`、`chatService.handlePrompt` | workspaceShell 关闭时附 20KB 文件，模型回答可引用文件内容；超限文件带截断提示 |
| P1-4 | walkthrough 本地化修复（`*.en.md` → `*.nls.en.md`）+ host 高频字符串接 `vscode.l10n`（状态栏、导出对话框、QuickPick placeholder、导出报告章节名） | `media/walkthrough/*`、`activate.ts`、`commands.ts`、`workbenchService.ts`、新 `l10n/bundle.l10n.*.json` | en locale 下 walkthrough 正文为英文；`display Language = en` 时状态栏与导出报告章节为英文 |
| P1-5 | Pin 证据 + 导出「置顶证据」首节 | `EvidenceNote.vue`、`store.ts`、协议 `evidence/pin`、`exportReport.ts` | pin 后时间线条带置顶展示；导出 MD 第一节为置顶证据 |
| P1-6 | workspaceShell 文案纠偏：改为「工作区只读文件访问」（保持实现不变，先把话说对） | `package.nls.json`、`package.nls.zh-cn.json`、`webview-settings/i18n.ts` | 文案与 `workspace-read.ts` 实际能力一致；`settings-ui.test.ts` 快照更新 |

### P2

| ID | 内容 | 涉及文件 | 验收标准 |
|----|------|---------|---------|
| P2-1 | 欢迎页能力空态卡：hub providers 为空时展示「安装 AT 系列插件」卡 + 诊断深链 | `WelcomeState.vue`、`store.ts` | 无插件时欢迎页可见指引，点击直达诊断/文档 |
| P2-2 | HostSessionChip 插件深链（pluginId → 聚焦命令映射） | `HostSessionChip.vue`、`guidedManualFlow.ts` | 点击 chip 聚焦对应插件面板；未安装时 notice 兜底 |
| P2-3 | `@terminal` 附件（对齐 Kilo：500 行 / 50KB 截断 + 截断提示），先取 VS Code 原生 activeTerminal selection | `workbenchService.pickAsset`、`Composer.vue` | 附终端输出后模型可引用；超限截断提示可见 |
| P2-4 | 导出「分享包」：`.tar.gz`（md + json + 引用的 artifact 文件），显式确认脱敏后生成 | `workbenchService.ts` | 包内 JSON 过 schema；未确认脱敏不允许生成 |

### 不该做（负面清单）

1. **消费级 chatbot onboarding**：不做打招呼式多轮引导、账号/登录墙、营销 tips 弹窗。首跑唯一目标是 2 分钟配好模型开始干活，现有「欢迎卡 + 拦截条 + 状态栏」三点式已是正确形态。
2. **IM 侧 write/exec 审批**：`approvalNotify.ts` 的 webhook 保持**单向通知**（无令牌、无完整命令集、提示回 IDE），审批唯一入口是会话内 ApprovalBar——HMAC 审批令牌与命令集哈希绑定语义无法在 IM 里安全复刻，回消息即批准等于把双闸拆成零闸。
3. **公网分享 URL**（OpenCode `/share` 形态）：运维会话默认含基础设施敏感信息，分享形态止步于本地文件/分享包。
4. **通用文件编辑 / 不受限 bash**：`ops_write_ops_doc` 只写 `ops-docs/` 白名单目录；变更类写操作永远走 AT 插件 + GuidedManual/审批，不给 Agent 通用 write/edit/shell。
