# 11 · 整改优化建议（对照 OpenCode / Kilo / Cline）

> **状态：历史基线。** 评审对象是 `764756c`。其中 P0 已在后续提交落地（见 `7f02f86` 起）。下一阶段施工真源改为 [15-optimization-recommendations.md](15-optimization-recommendations.md)（基线 `b099484`，对照补齐 Codex / Claude Code）。
>
> 评审对象：当前毛胚实现（分支 `cursor/ops-agent-design-3c44`，HEAD `764756c`）。
> 对照产品：OpenCode、Kilo Code，次要参照 Cline / Roo Code。
> 方法：主代理只做拆分调度；五名子代理并行审架构、UI、体验、基础功能、竞品差距。分项原文见 [reviews/](reviews/)。
> 事实基线：`npm run typecheck` / `compile` / `vitest` 301/301 **全绿**——测试绿不代表产品能用。

## 0. 结论先行

这不是「没写代码」的空仓，也不是「编译不过」的烂尾。骨架方向对（pi 进程内 loop、Hub 热注册、Cline 式单 Chat、SecretStorage 不落明文），但 **四条关键闭环没接上**，共同造成「连配置 LLM 问答都无法完成」：

| 排序 | 根因 | 杀伤力 | 分项 |
|------|------|--------|------|
| 1 | **发布产物必然坏死**：esbuild 把 ESM-only 的 pi SDK 打进 CJS，`import.meta.url` 变成 `undefined`，runtime 创建必炸，永远回落「未配置模型」 | 用户把 key 配得再对，聊天永远说没配 | [功能审计](reviews/functionality.md) §3.1 |
| 2 | **配置正确性不在配置界面闭环**：无连通性测试、无模型目录拉取、欢迎页对「未配置」零感知 | 设置页绿「已保存」，聊天才失败 | [体验](reviews/ux.md) §1 旅程 2–3 |
| 3 | **会话双真源 + 重建即失忆**：UI transcript 纯内存，pi JSONL 只写不读；换模型/装插件/保存配置会 `disposeRuntime()` | 值班半小时后重载，证据链归零 | [架构](reviews/architecture.md) §3.2 |
| 4 | **审批与 playbook 绑死**：无 `activeRun` 时 write/exec 永久 block；第三方 MCP 工具被 fail-closed 成 exec | 普通问答调工具是死路 | [架构](reviews/architecture.md) §3.3 |

战略一句话：**通用会话体验对齐 Kilo/Cline 的及格线，运维纵深（Playbook / 双闸 / 证据板 / Bridge 热注册）加厚不做拆。** 不要把本产品做成又一个 coding agent。

最短止血路径（按顺序）：**P0-A 修产物** → **P0-B 配置向导+验证** → **P0-C 会话续接** → **P0-D 审批不依赖 playbook**。三项落地即可达成「全新安装 2 分钟内完成一轮流式问答」。

---

## 1. 现状一句话

| 层 | 判断 |
|----|------|
| 设计文档 | 已冻结且大体正确（ADR-001 进程内 Hub、ADR-002 不 fork pi、ADR-003 自建 Webview、ADR-005 调查/执行永不同体） |
| 分层纪律 | `runtime` / `orchestrator` / `policy` / `hub-host` **零 `vscode` import**，可单测，质量尚可 |
| Host | `HostController` 1773 行 God Object，文档说「不含 LLM loop 业务」，实际编排大脑在 host |
| 测试 | 301 绿是假安全感：vitest 以 ESM 跑 `src/`，从不经过 CJS 产物；`createOpsRuntime` 的 fallback 还被测成「预期行为」 |
| UI 骨架 | Activity Bar 只留 Chat、Settings/Board 为编辑器页——已经是 Cline/Kilo 终局形态，**勿回退 TreeView** |
| 观感 | 无 Markdown、全库 emoji 图标、中英混排、`window.prompt` 加附件——「原型不像产品」 |
| 差异化 | Playbook 状态机、9 要素双闸、证据时间线、Bridge 零配置、GuidedManual、角色硬隔离——四家对手都没有 |

`docs/01` 写的 `packages/*` 布局尚未拆包，当前是单包 `src/*`（文档允许的第一期形态）。`src/host/trees/*`、`modelsView.ts:showModelsPanel`、`modules.ts` + 四套 fallback 是过期脚手架。

---

## 2. 「连配置 LLM 问答都无法完成」——根因栈

### 2.1 确定、已复现：CJS bundle 把 pi SDK 打死

`esbuild.extension.mjs` 以 `format:'cjs'` 整包内联 `@earendil-works/pi-coding-agent`。pi 是 `"type":"module"`，大量 `fileURLToPath(import.meta.url)`。esbuild 对 CJS 把 `import.meta` 降成 `{}` 且不告警。产物里可见：

```text
m5={}, … fileURLToPath(m5.url)   // m5.url === undefined
```

运行链：`ensureRuntime` → `createOpsRuntime` → 动态 import pi → 模块求值抛 `ERR_INVALID_ARG_TYPE` → catch 回 `createFallbackRuntime` → **每条消息固定回复「未配置模型，请在设置中写入 API key」**。OAuth 登录走同一 import，打包后 100% 失败。

子代理用 mock OpenAI SSE 服务器验证了两个方向：

- ESM（= vitest）流式正常，鉴权头为 `Bearer <SecretStorage key>`，证明 **配置写盘与 key 注入本身是通的**。
- 同款 CJS bundle 必回 fallback。给 esbuild 加 `define: {'import.meta.url': '__importMetaUrl'}` + banner 注入 `pathToFileURL(__filename).href` 后，CJS 全链路跑通。

这就是产品负责人看到的字面现象。设置页可以「已保存」，聊天永远说没配。

### 2.2 高概率叠加：hydrate 无握手 + 错误文案误导

- `chatView.ts` 设完 html **立刻** `postHydrate()`，`chat.js` 未加载则消息丢失；chat store 从不主动拉 `hydrate`、忽略 `dir:'res'`。慢加载时选择器显示「去设置添加模型」。
- 创建期任何异常（含 `import.meta`）都被包装成「未配置模型」，用户被导向改配置，而不是看 Output Channel。
- 欢迎页不消费 `hasApiKey`；模型下拉空态是 **disabled option，点了没跳转**；保存只校验 Base URL 与模型 ID 非空，**不填 key 也显示已保存**。

### 2.3 配通之后立刻撞墙的架构债

- 会话：`SessionStore` 纯内存；pi JSONL 写到 `~/.at-series/agent/sessions/` 但从不停 `continueRecent`。`disposeRuntime()` 触发点：换模型、保存配置、新插件工具、切会话。
- 审批：`requestSessionApproval` 要求 `this.activeRun`。纯问答里 write/exec 永久 block；`mcp_*` 不在 hub 目录 → fail-closed 成 exec → 762 行外部 MCP **一次也调不通**。
- 历史抽屉：webview 发 `{ sessionId }`，host 读 `{ id }`，**静默失败**（设置页 Sessions 用 `{ id }` 反而是通的）。
- Playbook 按消息数推进到 `investigating` 后无完结通道，一次 playbook 锁死整段会话。
- policy 的 `role` / `riskCeiling` 从未传入，子代理角色规则是死代码。
- 模型条目写 `thinking`，pi schema 是 `reasoning`，「支持思考」勾选是 no-op。

---

## 3. 与 OpenCode / Kilo / Cline 的差距（该学 / 不该学）

定位差：四家都是 coding agent；我们是 ops agent（取证—审批—留痕）。**通用层该对齐，纵深层是护城河。**

### 3.1 该对齐的通用会话体验

| 能力 | OpenCode | Kilo | Cline | 我们 | 动作 |
|------|----------|------|-------|------|------|
| Provider 向导 + 连通性测试 | `/connect` | BYOK 设置页 | 设置内校验 | 手填网关，保存≠可用 | P0-B |
| 模型目录拉取 | Models.dev | 网关列表 | OpenRouter 等 | 只读本地 `models.json` | P1 |
| 密钥保险柜 | 本地 auth.json | SecretStorage | SecretStorage | SecretStorage + 占位符 **领先** | 保持 |
| 会话持久化 / 续接 | session 一等资源 | 本地+云历史 | 任务历史+checkpoint | 内存，重载即丢 | P0-C |
| 流式 | ✅ | SSE 重连 | ✅ | 40ms 合批 ✅ | 保持 |
| 工具卡 | TUI | 折叠+diff | Accordion 默认折 | 永远展开刷屏 | P1 |
| 审批交互 | 工具内挂起 | Permission Dock 三档 | ask 挂起当前调用 | 拒绝-重试 + 绑 playbook | P0-D |
| Markdown | ✅ | ✅ | ✅ | `{{ item.text }}` 裸渲染 | P0-E |
| @ 引用 | `@File#L` | @file / @terminal | @file/@folder | `window.prompt` | P1 |
| token / 成本 / compaction 可见 | TUI | 状态条 | 任务头水位 | 全无 | P1 |
| 失败重试 | `/undo` | Retry | Retry 按钮 | 无 UI 重试 | P1 |
| 子代理 | 阻塞式 tool result | 状态条 + Needs input | 多代理团队 | fire-and-forget + user 角色回灌 | P1 |
| onboarding | `/init` | 登录+迁移向导 | welcome 内向导 | 欢迎页只有 playbook 卡 | P0-B |

### 3.2 不该抄（ops ≠ coding）

1. 默认 bash/write/edit 工具四件套、文件 diff、checkpoint/rewind 快照——运维回滚是被审批的生产动作。
2. 现在抽独立 `kilo serve` / `opencode serve` 进程——Bridge 热注册要同进程；先收敛 `OpsCore` facade，第二客户端出现再套 HTTP。
3. Kilo Agent Manager 的多 worktree / PR 面板——事故必须单指挥链（ADR-005）。
4. 全局 auto-approve / YOLO——可借「本会话本只读工具免审」的 **UI 形态**，write/exec 双闸不动。
5. 把 repo map 塞进 system prompt——上下文预算留给证据。
6. MCP marketplace 把第三方工具与 AT Bridge 一等并列——凭据隔离不能破。
7. 把 Jenkins/Nacos 写面做成 MCP 工具——GuidedManual 是设计，不是欠账。

### 3.3 该加厚的差异化

Playbook 状态机、9 要素简报、证据时间线、Bridge 零配置、Incident Board、GuidedManual、Investigator 硬只读、UntrustedQuotes、有界 payload、结论三态——矩阵 10/10，对手最多 🟡。下一步是 **导出成值班报告、做进 onboarding 话术、compaction 时告诉用户哪些证据被摘要**，而不是做成像 Cline 的聊天窗。

---

## 4. 统一整改路线图

下列条目已跨五份报告去重。每条含目标、落点、验收。详细论证见分项。

### P0 —— 不做就不能给 SRE 用（建议按字母序落地）

#### P0-A 修复 CJS 产物，让 pi runtime 在 VSIX 里活过来

- **问题**：§2.1。测试绿、产物死。
- **改**：`esbuild.extension.mjs` 增加
  ```js
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" }
  ```
  新增 `test/bundle-smoke`：用**同一套** esbuild 配置打 harness，起 mock OpenAI SSE，断言 `text_delta` 且 `Authorization: Bearer <注入 key>`。把 define/banner 撤掉时该测试必须红。
- **验收**：干净 VS Code 装 VSIX → 配 OpenAI-compatible key → 发「你好」→ **逐字流式出现**；Output 出现 `createOpsRuntime 完成` 而非 fallback。
- **误导文案同步改**：仅当失败原因确属无凭证时说「未配置模型」；其余说「模型运行时初始化失败：…」并链到 Output。`src/runtime/index.ts` `FALLBACK_NOTICE`、`src/host/fallback/fallbackRuntime.ts` 去掉「能力插件树 / `src/runtime`」过期指引。

#### P0-B 首次 2 分钟能问答：向导 + 保存并测试 + 空态可点

- **问题**：配置与运行时脱钩；欢迎页假装可以开始排障。
- **目标交互**（文案级见 [体验 §5](reviews/ux.md)）：
  1. 欢迎卡：「完成一次模型配置（约 1 分钟）」主 CTA，playbook 卡降饱和。
  2. Provider 预设：内部网关 / OpenAI / Anthropic OAuth / DeepSeek / Qwen / 自定义；选完预填 baseUrl 与 api 类型。
  3. 「验证并保存」：1-token 或 `GET /v1/models`；成功显示延迟；401/网络/缺 key 内联红字。**未填 key 禁止显示已保存。**
  4. composer 空态按钮「＋ 配置模型」直达设置；发送在未配置时拦截，不静默走 fallback。
- **改**：`WelcomeState.vue`、`Composer.vue`、`ModelSelector.vue`、`store-helpers.ts`（吸收 `hasApiKey`）、`ModelsTab.vue`、`modelsView.ts`、`hostController` 新 `models/test`、`secrets.ts` 改为 `atOpsAgent.apiKey.<providerId>`（迁移旧键）、`runtime/index.ts` 删除 `getRegisteredProviderIds()[0]` 启发式注入。
- **验收**：不看 README，2 分钟内完成一轮成功问答；错 key 在设置页 2 秒内看到 401，而不是回聊天才知道。

#### P0-C 会话单真源：pi JSONL 可续接，UI 不再纯内存

- **问题**：重建失忆、重载丢历史、`msg-${counter}` 重建后串写。
- **目标**：pi 会话文件是唯一真源。换模型 / 新工具时 `switchSession` / `continueRecent` 续接同一 JSONL；事件 id 用 `randomUUID`；HistoryOverlay 从 `~/.at-series/agent/sessions/` 列目录。
- **改**：`src/runtime/index.ts`（resume、id）、`hostController.ts`（`disposeRuntime` → `rebuildRuntimePreservingSession`；catalog 重建推迟到 idle）、`sessionStore.ts`（JSONL hydrate）。
- **顺手修 bug**：`webview-chat/store.ts` `session/switch` 改发 `{ id }`（或 host 兼容两键）；同步 `mock-host.ts`；补协议一致性测试。
- **验收**：配好模型聊 3 轮 → 换模型 → 模型仍记得上文；重载窗口后历史抽屉能打开同一会话。

#### P0-D 审批改为工具内挂起，且不依赖 playbook

- **问题**：拒绝-重试浪费轮次；无 `activeRun` 时 write/exec 与 `mcp_*` 死路。
- **目标**：`execute` 内 `await host.requestApproval(brief)`（Cline / OpenCode 同构）：批准继续同一调用，拒绝返回结构化结果。简报从 orchestrator 剥到 `ApprovalService`。policy ctx 增加 `origin: {kind:'main'} | {kind:'subagent', role, riskCeiling, approvalToken}`。Executor token 由 host 从 `currentApproval` 附上，删 L3「模型自己算 SHA-256」。
- **改**：`runtime/index.ts` `applyToolGate`、`hostController.requestSessionApproval`、`policy` 调用点、`prompts/layers.ts`、`mcp-client/external.ts`（`mcp_list_*` = read，`mcp_call_tool` = write）。
- **验收**：不启动 playbook，让模型调一条 exec 工具 → 出现 ApprovalBar → 批准后同一调用放行；`mcp_list_servers` 不再走审批死路。

#### P0-E 跨过「原型观感」的三条表层（可与 A–D 并行）

1. **Markdown**：`ChatTranscript.vue` 用闲置的 `markdown-it` + 消毒；代码块走 `--vscode-textCodeBlock-background`。
2. **codicon**：打包 `@vscode/codicons`，替换全库 emoji（🔧📌🔍⏹⬡ 等）。
3. **ApprovalBar 两段式布局**：侧边栏 300px 下头行不再 8 元素挤爆；批准为 primary。
4. **Composer `@` 去掉 `window.prompt`**：改 host `showQuickPick`。
5. **webviewHtml.ts**：`lang` 与 boot 文案跟 `vscode.env.language`，硬编码中文进 i18n。

### P1 —— 拉平会话体验，把差异化变成交付物

| ID | 项 | 落点 | 参考 |
|----|----|------|------|
| P1-1 | Provider 多 key + `GET /v1/models` 拉目录 + 表单 `thinking`→`reasoning` | `modelsView.ts`、`ModelsTab.vue` | OpenCode `/connect` |
| P1-2 | 工具卡默认折叠 + ≥3 只读聚合 | `ToolCallCard.vue` | Cline `groupLowStakesTools` |
| P1-3 | 头部去重：webview 内不再重复「历史/Playbook」按钮 | `PlaybookHeader.vue`、`package.json` menus | Cline 顶栏全走 view/title |
| P1-4 | Composer 内 context 水位条；compaction 在时间线插系统事件 | 协议加 `usage` evt | Kilo / Cline 任务头 |
| P1-5 | 失败消息「重试 / 编辑重发」+ 401 人话 | `ChatTranscript.vue`、runtime catch | Cline Retry |
| P1-6 | 子代理改为阻塞式 tool result，删 `deliverToMain` | `runtime/index.ts`、`subagents.ts` | OpenCode task |
| P1-7 | Playbook 给 `ops_advance_stage` / `ops_close_playbook`，停用按消息数推进 | `playbook-tools.ts`、`hostController.advancePlaybookForPrompt` | 自有状态机止血 |
| P1-8 | 删除 `modules.ts` + `fallback/*`（约 -700 行），错误上屏 | `activate.ts`、`hostController` | — |
| P1-9 | 只读工具「本会话免审」记忆（write/exec 双闸不动） | policy + 设置页规则列表 | Kilo Permission Dock |
| P1-10 | 值班报告一键导出（时间线+证据+审批 → Markdown） | 新 command | Kilo transcript export |
| P1-11 | `@日志` / `@terminal` / `@evidence:id` | Composer + host QuickPick | Kilo @terminal 截断规则 |
| P1-12 | 设置页改 editor 背景、token 化间距、MCP 卡片化 | `SettingsApp.vue`、`McpTab.vue` | VS Code 原生设置 |
| P1-13 | i18n 闭环：hydrate 带 locale；host notice 进表 | 两份 `i18n.ts`、`webviewHtml.ts` | Kilo 跟 VS Code 语言 |
| P1-14 | 批准后自动 followUp「已批准请继续」+ 状态行 | `applyApproval` | — |
| P1-15 | 热更新推迟到会话 idle，避免装插件丢上下文 | `onCatalogNeedsRebuild` | 与 P0-C 配套 |

### P2 —— 结构收敛与差异化打磨

- **OpsCore facade**：`runtime+orchestrator+hub-host+policy+mcp-client` 收成无 vscode 的单一 API，host 退回适配层；为将来第二客户端预留，**现在不抽进程**。
- 拆分 `HostController`（Chat / Approval / Playbook / Config / Capabilities，各 ≤300 行）。
- Board 升级为「Ops 版 Agent Manager」：过滤、日期分组、相对时间、定位回会话。
- 软停 / 硬停两档中止（Cancel 保留在途证据）。
- per-角色模型映射（Investigator 便宜模型，Writer/Verifier 强模型），默认全走当前模型。
- `contributes.walkthroughs` 三步：配模型 → 装 AT 插件 → 跑 `pb.inspection`。
- ≤2 会话并行（查库+查主机）；不做 worktree。
- 定时巡检：到点提醒 + 人点启动，无人值守执行。
- IM 只推审批摘要 + 深链回 IDE，**绝不在 IM 里批准 write/exec**。
- 删死代码：`src/host/trees/*`、`showModelsPanel`、orchestrator 未接线的 `spawnSubagentSpecs` / `mergeEvidence`（接线或删）。
- 8 条 playbook 的 fixture Bridge 端到端 evals，作为升 pi / mcp-hub 的守门员。

---

## 5. 分维度摘要

### 5.1 架构（详见 [reviews/architecture.md](reviews/architecture.md)）

保留：ADR-001/002/004/005、L0–L4 精简常驻 + skill 渐进披露、HubHost catalog/abort/Database 兼容。

必改：会话真源、配置向导、挂起式审批、policy origin 接线。Playbook 11 态 mermaid 是文档产物，代码只驱动 3 态——先给显式完结通道，再考虑降级为 checklist。子代理三层簿记（runtime records / orchestrator Map / SessionStore）没有单一 owner。

目标结构（进程模型不变）：

```text
Webview (render-only)
    │ envelope
Host 薄适配（Chat / Config / Capabilities）
    │
OpsCore（无 vscode，可测，可未来套 HTTP）
    ├─ SessionService     pi JSONL 单真源
    ├─ AgentRuntime       execute 内挂起审批 / 阻塞式子代理
    ├─ ApprovalService    独立于 playbook
    ├─ PolicyGate         origin{role,riskCeiling}
    ├─ PlaybookService    阶段 checklist + ops_advance/close
    └─ ToolProviders      HubHost + ExternalMcp（带 risk 声明）
```

### 5.2 UI（详见 [reviews/ui.md](reviews/ui.md)）

工程底子好（token 映射 `--vscode-*`、虚拟化、CSP、aria 双通道）。不美观的根因是表层四件：无 Markdown、emoji、中英混排、demo 交互。

信息架构已正确，收紧即可：

```text
Activity Bar → 唯一 Chat
  顶栏：原生按钮（新会话/历史/Playbook/停止/设置）  ← webview 内不要再做一套
  PlaybookHeader：仅激活时一行 chip
  Transcript：Markdown + 折叠工具卡
  Composer：模型徽标 + @资产 + context bar

编辑器区按需
  Settings（齿轮 / 空态 CTA）
  Board（事故升级才出现，永不常驻 Panel）
```

Token：用 `--ops-space-1..4`（4 的倍数）和 `--ops-font-md/sm/xs`（最小 11px）替换就地 `calc`；settings/board 用 `editor-background`，chat 用 `sideBar-background`。风险三色是领域资产，禁止当装饰。

### 5.3 体验（详见 [reviews/ux.md](reviews/ux.md)）

判据：**会话中 10 秒内要用的进 chrome**（模型、审批、中止、playbook、会话、未配置 CTA）；**改一次管一个月的进设置**（key、URL、MCP、策略）。任何错误必须带通往修复界面的按钮。

状态栏在未配置时应显示 `$(warning) AT Ops 未配置`，点击直达 Models。`abort` 标题栏按钮只在运行中显示。

### 5.4 基础功能成熟度（详见 [reviews/functionality.md](reviews/functionality.md)）

| 功能 | 源码 | 产物 | 说明 |
|------|------|------|------|
| 编译/单测 | ✅ | — | 301 绿，不覆盖 bundle |
| 配置写盘 + SecretStorage | ✅ | ✅ | 占位符 + 0600，设计到位 |
| pi runtime / 流式 / 鉴权注入 | ✅ ESM | ❌ CJS | P0-A |
| 模型选择器同步 | ✅ | 受 hydrate 竞态 | P0-A 握手 |
| 中止 | ✅ | 依赖 runtime | — |
| Playbook 启动 / Hub | ✅ | 问答部分同死于 P0-A | — |
| OAuth | 源码完整 | ❌ 同 import.meta | P0-A 后改默认 provider |
| 会话切换（chat 抽屉） | ❌ 字段名 | ❌ | P0-C |
| 无 playbook 审批 | ❌ | ❌ | P0-D |
| 思考开关 | no-op（`thinking` vs `reasoning`） | — | P1-1 |
| Anthropic/Ollama UI | 只能手改 json | — | P1-1 |

### 5.5 竞品可抄的 12 个交互（详见 [reviews/competitive.md](reviews/competitive.md)）

按优先级：Permission Dock 只读免审 → `/connect`+拉模型 → 水位条+compaction 事件 → 子代理 Needs input 条 → Markdown 值班导出 → @terminal/@evidence → Retry → `Ctrl+Esc` 快捷键 → per-角色模型 → 软停/硬停 → 配置导出 → 巡检到点提醒。

---

## 6. 最小验收清单（P0 完成后）

全新 profile、不看 README：

1. 安装 VSIX → 打开活动栏 → 欢迎卡出现「配置模型」主按钮（不是直接 6 张 playbook）。
2. 点入 Models → 选 OpenAI 兼容 → 填 baseUrl / 模型 / key → **验证并保存** 显示「连接成功」。
3. `~/.at-series/agent/models.json` 的 apiKey 仍是 `${secret:…}` 占位符，权限 0600。
4. 回聊天，选择器已有该模型 → 发「用一句话介绍你自己」→ **流式逐字出现**。
5. 流式中点停止 → 立即停住。
6. 故意改错 key 保存 → 设置页或聊天出现 **401 人话**，不再说「未配置模型」。
7. 聊 3 轮后重载窗口 → 历史抽屉能打开同一会话。

任一步失败即打回。第 4 步是「连配置 LLM 问答都无法完成」的直接回归项。

---

## 7. 建议的落地顺序（技术依赖）

```text
P0-A 产物修复 ──┬── P0-B 向导/验证     ── 2 分钟问答
                ├── P0-E UI 表层        ── 看起来像产品
                └── P0-C 会话续接 ── P0-D 审批挂起 ── 能干活
                                              │
                         P1-6 阻塞子代理 / P1-7 playbook 完结 / P1-8 删 fallback
                                              │
                         P1 体验拉平 + 值班导出
                                              │
                         P2 OpsCore 拆分 / Board / 并行会话
```

P0-A 是所有功能验收的前置。没有它，后面做的设置页再漂亮，聊天仍会说「未配置模型」。

---

## 8. 分项报告

| 文件 | 子代理范围 |
|------|------------|
| [reviews/architecture.md](reviews/architecture.md) | 运行时、编排、子代理、policy、与 OpenCode/Kilo 进程模型对比、目标架构图 |
| [reviews/ui.md](reviews/ui.md) | 视觉系统、组件完成度、token、信息架构 |
| [reviews/ux.md](reviews/ux.md) | 首跑旅程断裂点、2 分钟向导文案、设置 vs chrome IA |
| [reviews/functionality.md](reviews/functionality.md) | 配置→发消息→流式的调用图、bundle 复现、成熟度表 |
| [reviews/competitive.md](reviews/competitive.md) | 21 行通用矩阵 + 10 行 ops 矩阵 + 12 条可抄交互 |

本文件是施工真源的**下一阶段输入**；与已冻结的 ADR 冲突时：进程模型 / 双闸 / GuidedManual / 不走 `exports` **以 ADR 为准**；会话真源、审批挂起、配置向导 **以本文件为准**（它们落实的是 ADR 已承诺但代码未接线的部分）。
