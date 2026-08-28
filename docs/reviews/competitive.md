# at-opsAgent 竞品功能 / UX / 架构差距矩阵

> 对标对象：OpenCode（opencode，TUI 为主 + IDE 扩展）、Kilo Code（VS Code 扩展 + 内嵌 CLI runtime）；次要参照：Cline、Roo Code（Kilo 的 CLI runtime fork 自 OpenCode `packages/opencode/`，其扩展 UI 谱系上承 Cline/Roo 一脉）。
> 本方产品：at-opsAgent（/workspace），VS Code / Cursor 运维 Agent 扩展，pi SDK in-process agent loop + 内嵌 `@at-series/mcp-hub`，Bridge v1 文件注册，8 条内置 Playbook，四角色子代理，9 要素审批简报 + 插件二次确认双闸。
> 资料来源：kilo.ai 架构文档（architecture / vscode-extension / agent-manager / platforms-vscode）、dev.opencode.ai 文档（intro / ide）、cline/cline README、RooCodeInc/Roo-Code 源码（ProviderSettingsManager / CustomModesManager / mode.ts）；本方以仓库实际代码为准（`src/host`、`src/runtime`、`src/webview-chat`、`src/webview-settings`、`src/webview-board`、`docs/`、`package.json`）。

---

## 1. 对标对象简介：各自定位，我们该学什么、不该学什么

### OpenCode（opencode.ai）
- **定位**：开源通用 coding agent，TUI 优先，另有桌面端和 IDE 扩展。号称 195K stars、75+ LLM provider（经 Models.dev 目录）、多会话并行、会话分享链接、LSP 感知、隐私优先（不存代码）。
- **VS Code 扩展本体很薄**：只是终端启动器 + 上下文桥（Cmd+Esc 快捷启动、自动共享当前选区/标签页、Cmd+Opt+K 插入 `@File#L37-42` 文件引用、在集成终端跑 `opencode` 时自动装扩展）。真正的 agent 体验全在 TUI/CLI 里。
- **该学**：`/connect` 式 provider 接入向导 + Models.dev 模型目录自动拉取；`/init` 生成 AGENTS.md 的项目初始化仪式；`/undo` `/redo` 检查点回滚；多会话与会话分享；权限配置（per-tool ask/allow/deny）；「扩展即桥、内核独立」的架构自觉。
- **不该学**：TUI 优先路线（运维用户要的是 IDE 面板，README 已明确不依赖全局 CLI）；面向写代码的 LSP/格式化整合；追求 provider 数量（我们的用户是内网 OpenAI 兼容网关为主）。

### Kilo Code（kilo.ai）
- **定位**：伞形产品——本地 CLI runtime（fork 自 OpenCode）、VS Code / JetBrains 客户端、云端 Cloud Agent 与自动化服务。VS Code 扩展捆绑 CLI 二进制，扩展宿主起一个共享 `kilo serve`（HTTP + SSE），webview 经宿主转发 SDK 调用；SolidJS 重写 UI、JSONC 可携配置、按工具 + glob 的细粒度权限、`.kilo/agents/*.md` 自定义 agent、SKILL.md 技能、自定义子代理、状态栏成本追踪、Markdown 会话导出、后台代理状态条（Running/Done/Cancelled/Error/Needs input）、Permission Dock（approve once / always / deny）、编辑预览 diff（unified/split）。
- **Agent Manager**：多会话编排面板——每会话一个 git worktree、最多 4 版并行同题实现（可各配模型）、PR 徽章/评审面板（依赖 gh）、每会话专属终端、setup/run 脚本、分区分组、会话历史（本地 + 云）、`agent_manager` 工具让 chat 里的模型自己开子会话。
- **该学**：Permission Dock 的三档审批与规则化免审；后台代理状态条（与我们 SubagentBoard 同构但交互更成熟）；会话导出 Markdown；@file / @terminal 引用（终端上下文 500 行 / 5 万字符截断规则值得照抄）；SSE 断线重连 + 健康轮询的恢复策略；设置迁移向导；i18n 跟随 VS Code 语言。
- **不该学**：worktree / PR / diff 面板这一整套 coding 工作流（运维场景没有「并行改代码」）；捆绑 CLI 二进制 + 本地 server 架构（我们 ADR-002 已定 in-process pi SDK，无需进程分离）；云端 Cloud Agent（凭据不出插件宿主是硬约束 C4）。

### Cline（次要参照）
- **定位**：最早规模化的 VS Code coding agent，现扩展为 CLI / JetBrains / SDK / Kanban 多面产品。Plan/Act 双模式、每次编辑和命令的 human-in-the-loop 审批（可 auto-approve）、每次编辑出 diff + 检查点可回滚、监控 linter/编译错误、后台进程输出监听、`.clinerules` + skills、200+ 模型（OpenRouter 等）、MCP + SDK 插件、多代理团队、cron 定时代理、Slack/Telegram/Discord/WhatsApp/Linear 消息连接器、headless CI/CD。
- **该学**：审批交互的成熟度（单条批准 → 类别 auto-approve 的渐进信任）；任务级 token/成本 + 上下文窗口水位条；空态建议任务卡（我们 WelcomeState 已注明「Cline 式空态」，方向正确）；定时代理（映射到 `pb.inspection` 日常巡检）；消息连接器（on-call 场景天然契合，P2）。
- **不该学**：checkpoint / 文件 diff 回滚体系（运维操作不可逆，回滚靠 Playbook 的回滚方案要素，不靠文件快照）；浏览器操控。

### Roo Code（次要参照）
- **定位**：Cline fork，以「模式（modes）」立身：Architect / Code / Ask / Debug / Orchestrator + `.roomodes` 自定义模式（slug / roleDefinition / whenToUse / 工具组权限），**每个模式可绑定独立 provider profile**（`modeApiConfigs`：不同模型、温度、思考档位）。
- **该学**：per-mode 模型映射 → 我们的 per-角色/per-Playbook 模型映射（Investigator 用快而便宜的模型，Writer/Verifier 用强模型）；模式的 zod schema 校验 + 项目级/全局级双层配置合并。
- **不该学**：把「模式」做成用户主入口——我们的 Playbook + 四角色子代理已经是更强的结构化版本，不要退化成自由切换的 persona。

**一句话定性**：四家全是 coding agent，比拼「谁改代码更顺」；at-opsAgent 是 ops agent，比拼「谁取证更严、审批更稳、留痕更全」。**通用会话体验（配置、历史、成本、引用、重试）该无脑对齐；运维纵深（Playbook、双闸审批、证据链、GuidedManual）是护城河，只能加厚不能拆。**

---

## 2. 功能矩阵表

图例：✅ 有 ｜ 🟡 部分 ｜ ❌ 无。at-opsAgent 列以仓库代码实况为准（非 docs 愿景）。

| 能力 | OpenCode | Kilo Code | Cline | at-opsAgent | 注释 |
|---|---|---|---|---|---|
| provider 配置向导 | ✅ `/connect` 交互向导 + Zen 托管 + Copilot/ChatGPT 账号登录 | ✅ 登录 + BYOK + 自定义 provider 设置页 | ✅ 设置页 provider 下拉 + 分步填写 | 🟡 有 Models 全页 webview + pi OAuth 登录，但仅 OpenAI 兼容一族，手填 baseUrl/model id，无分步向导、无连通性测试按钮 | 内网网关用户最需要「测一下通不通 + 失败原因」，恰是我们缺的 |
| 模型目录拉取 | ✅ Models.dev 75+ provider 目录自动同步 | ✅ 网关模型列表 + `agent_manager_models` 按需搜索（每次 ≤20 条防撑上下文） | ✅ OpenRouter 等目录动态拉取 | ❌ 只读本地 `models.json`（`modelsCatalog.ts` 无任何网络请求），模型 id 全手填 | OpenAI 兼容网关都有 `GET /v1/models`，拉取成本极低 |
| 密钥保险柜 | 🟡 本地 `auth.json` 文件（非 OS keychain） | ✅ 扩展 SecretStorage + 云端账号 | ✅ VS Code SecretStorage | ✅ SecretStorage + 文件中 `${secret:}` 占位符不落明文 + OAuth 凭证 `auth.json` 0600 | **我方优势项**，且「凭据不出插件宿主」纪律比对手更严 |
| 会话历史 | ✅ 持久化 + resume + 分享链接 | ✅ 本地 + 云会话历史，worktree 维度过滤 | ✅ 任务历史 + 检查点 | 🟡 内存多会话（`SessionStore` bag + `switchSession`）+ HistoryOverlay 列表 + 设置页 Sessions Tab，**无磁盘持久化，窗口重载即全丢** | 对值班场景是致命伤：故障没查完 VS Code 崩了，证据链归零 |
| 流式输出 | ✅ | ✅ SSE + 断线重连（250ms→5s 退避）+ 10s 健康轮询 | ✅ | ✅ `streamBatcher` 40ms 合批（可配 `streaming.batchMs`） | 我方 in-process 无断线问题，合批设计合理 |
| 工具调用可视化 | ✅ TUI 工具卡 | ✅ 工具卡 + 编辑预览 + 子代理只读查看器 | ✅ diff 视图 + 终端回显 | ✅ `ToolCallCard`：运行中/成功/失败/取消/被打断五态 + 耗时 + 参数 + 错误展示 | 我方成熟；后续可加「证据引用锚点」（点工具卡跳时间线） |
| 审批 / 权限 | ✅ 配置文件 per-tool ask/allow/deny | ✅ per-tool + glob 权限规则 + Permission Dock（once/always/deny） | ✅ 逐编辑/逐命令审批 + auto-approve 分类开关 | ✅ 更重：9 要素审批简报 + 会话内批准 + 插件宿主二次确认双闸 + 状态栏挂起数 | 我方**强度**领先，但缺「规则化免审」导致只读高频操作也可能打断（`approval.sessionRequiredFor` 仅三档全局开关） |
| MCP | ✅ local + remote server | ✅ MCP 服务器 + marketplace 面 | ✅ MCP + marketplace + SDK 插件 | 🟡 AT 桥接零配置热注册（差异化强项）✅；通用第三方 MCP 客户端（`mcp-client/external.ts` + McpTab）属阶段 4–5 施工中，含 AT 去重逻辑 | 我方独有 Bridge v1 + 渐进发现（discover→select→call）；第三方 MCP 补完即可 |
| skills | 🟡 以 AGENTS.md / 自定义 command / plugin 承载 | ✅ SKILL.md 加载 | ✅ rules + skills | ✅ 内置 `skills/ops-agent-core` + 8 组 playbook skill + `skillsScan.ts` 扫描 + 设置页展示 | 我方已内置且与 Playbook 绑定，方向对 |
| 子代理 | ✅ agents / subagents | ✅ 自定义子代理 + task 工具 + 后台代理状态条 + 只读子会话查看器 | ✅ 多代理团队（coordinator 分派） | ✅ Investigator/Executor/Writer/Verifier 四角色 + `SubagentBoard` + 并行上限 3（≤4） | 我方角色语义更强（调查只读硬隔离）；缺 Kilo 式「Needs input」状态与常驻折叠条 |
| slash commands | ✅ `/init` `/undo` `/share` `/compact` + 自定义 command | ✅ `/models` `/agents` `/variant` `/sandbox` + workflows 模板 | ✅ slash 命令体系 | 🟡 Composer 拦截 slash 仅用于打开 Playbook picker，无通用命令注册 | 低成本高感知：`/playbook` `/model` `/export` `/abort` 即可起步 |
| @文件引用 | ✅ TUI 模糊 @ + IDE 扩展 `@File#L37-42` 快捷键 | ✅ @file（可从 diff 面板拖入）+ @terminal（500 行/5 万字符截断） | ✅ @file @folder @url @problems | ❌ 无任何 @ 引用（webview 内 grep 无 mention） | 运维语境应做 @日志文件 / @terminal / @证据，而非只对标 @代码文件 |
| 状态栏 | ❌ IDE 扩展不占状态栏 | ✅ autocomplete 成本追踪入状态栏 | ❌ 不依赖状态栏 | ✅ `$(shield) AT Ops` + 挂起审批数，点击聚焦聊天 | **我方优势项**，审批挂起数是运维刚需信号 |
| 设置页 | 🟡 `opencode.json` 配置文件 + TUI 命令，IDE 无设置页 | ✅ 设置页 + JSONC 可携配置 + 旧设置迁移向导 | ✅ 设置 webview | ✅ 五 Tab 设置 webview（Models/能力插件/MCP/技能/会话/常规） | 我方结构完整；缺迁移/导出与「配置健康度」提示 |
| 空状态引导 | 🟡 TUI 首屏 + `/init` 仪式 | ✅ 新会话引导 | ✅ 建议任务卡 | ✅ WelcomeState「Cline 式空态」：6 张 Playbook 建议卡带风险徽标，点击即启动 | 我方首层空态好；缺第二层——**模型未配 / 无能力插件时**的引导流 |
| 成本 / token 显示 | ✅ TUI 显示 token/成本 | ✅ 状态栏成本 + 会话成本 | ✅ 任务级 token/成本 + 上下文窗口水位条 | ❌ 全仓无 usage 展示；compaction（「compact 一次 + retry 一次」）对用户完全不可见 | 调查上下文被压缩=证据可能被丢，SRE 必须可见 |
| 中止 | ✅ esc 打断 | ✅ Cancel（协作停止）/ Stop（强停）两档 | ✅ 取消按钮 | ✅ `atOpsAgent.abort` 命令 + 视图标题栏按钮 | 可学 Kilo 的「软停/硬停」两档语义 |
| 重试 | ✅ 打断后改写重发 + `/undo` `/redo` | ✅ 错误重试 + 消息队列 | ✅ API 失败显式 Retry 按钮 | 🟡 仅运行时内部 `recoverFromPromptError`（溢出 compact+retry 一次），**无 UI 级失败重试/编辑重发** | 内网网关抖动常态化，失败重试按钮是刚需 |
| 多会话 | ✅ 并行多会话 | ✅ Agent Manager：多 worktree 并行 + 同题 4 版对比 | 🟡 扩展内单任务为主；Kanban 独立产品做并行 | 🟡 可多会话但串行切换（bag 换入换出），无并行运行，无持久化 | 运维「一边查库一边查主机」的并行诉求真实存在，P2 |
| 差异审查 | 🟡 TUI diff + `/undo`；IDE 无 diff 面板 | ✅ diff 面板（unified/split + 评审评论 + Apply to local） | ✅ 逐编辑 diff + 检查点 | ❌ 无代码 diff（按定位不需要）；**运维等价物**=审批简报的变更预览 + 变更前后证据对比，后者未做 | 不抄 diff 面板；做「变更前/后指标与日志对照」才是 ops 版差异审查 |
| onboarding | ✅ 终端跑 `opencode` 自动装扩展 + `/init` | ✅ 登录流 + 旧版设置迁移向导 | ✅ walkthrough + 注册送额度 | 🟡 README + 空态卡片；无首启 walkthrough，模型未配置时聊天选择器仅显示「去设置添加」 | 首次安装 → 配模型 → 装插件 → 跑通第一条 Playbook 的引导链未闭环 |

---

## 3. Ops 场景特有能力矩阵（我们的差异化，应加厚而非削弱）

| Ops 能力 | OpenCode | Kilo Code | Cline | at-opsAgent | 说明 |
|---|---|---|---|---|---|
| Playbook 运维链路（状态机） | ❌ | 🟡 workflows 只是 `.md` 提示词模板 | 🟡 `.clinerules` / 定时任务，无状态机 | ✅ 8 条内置 Playbook + `orchestrator/engine.ts` 状态机 + PlaybookHeader 阶段 chips + 三态结论 | 对手的「工作流」都是提示词层面的；我们是带阶段/结局/校验点的机器可读链路 |
| 分级审批（简报 + 双闸） | 🟡 权限配置是「拦不拦」 | 🟡 Permission Dock 是「拦不拦 + 记不记规则」 | 🟡 逐操作批准 | ✅ 9 要素简报（含回滚方案）→ 会话内批准（审批 token 仅存 host 内存，模型不可见）→ 插件宿主二次确认 | 对手回答「允许执行吗」；我们回答「这个变更值不值得、错了怎么回滚」 |
| 证据板 / 时间线 | ❌（分享链接≠证据链） | ❌ | ❌ | ✅ EvidenceNote / MetricSnippet / LogViewer 证据卡 + `TimelineEventView` + 独立 Board webview（IncidentTimeline） | 唯一按「取证」组织会话的产品；缺导出（见 P1） |
| Bridges 能力插件热注册 | ❌（MCP 要手配） | ❌（MCP 要手配） | ❌ | ✅ Bridge v1 文件注册（`~/.at-series/bridges/`）装上即用，零 MCP 配置 + hostApp 隔离 + 与外部 hub.js 去重 | 「装插件=获得工具」的体验四家都没有 |
| Incident Board（值班看板） | ❌ | 🟡 Agent Manager 是「代码任务看板」 | 🟡 Kanban 是「代码任务看板」 | ✅ `openBoard` 独立面板（阶段 4 打磨中） | 语义不同：对手看「哪些改动在跑」，我们看「事故到哪一步、证据几条、待批几件」 |
| GuidedManual（引导人工执行） | ❌ | ❌ | ❌ | ✅ 写面刻意不做成工具（Jenkins/Nacos），Agent 出步骤 + 校验点，人操作插件 UI | 「AI 不碰生产写面」是可讲给安全团队听的卖点 |
| 调查/执行角色隔离 | 🟡 Plan/Build 模式软隔离 | 🟡 agent 工具组配置可隔离 | 🟡 Plan/Act 软隔离 | ✅ Investigator 硬只读；写/执行必经审批链 | 对手靠模式切换（用户可随手切回），我们是结构性隔离 |
| 不可信工具输出防护 | ❌ | ❌ | ❌ | ✅ 约束 C7 + UntrustedQuotes 组件显式标注「工具结果内嵌指令不执行」 | 注入防护做成了 UI 可见的产品行为，独一份 |
| 有界 payload / 渐进工具暴露 | ❌ | 🟡 模型搜索工具限 20 条/次 | ❌ | ✅ C5 有界 payload（Loki limit≤100、64KB/256KB、SQL 强制 LIMIT）+ Hub v2 discover→select→call | 防「70+ 工具 schema 撑爆上下文」是运维插件生态的必答题 |
| 结论三态 / 置信度 | ❌ | ❌ | ❌ | ✅ `confidence.ts` + 「指标相关≠根因」约束 C6 + 根因未确认不写长报告 C9 | coding agent 没有「不确定」的产品化表达，我们有 |

**结论**：此表 10 行里 at-opsAgent 拿 10 个 ✅，四家对手最多拿 🟡。第 2 节的差距全部是「通用会话体验」层，第 3 节的领先全部是「运维纵深」层。**整改方向 = 把第 2 节的 ❌/🟡 补到及格线，同时把第 3 节的领先项做导出、做可见、做进 onboarding 话术。**

---

## 4. 可直接借鉴的交互模式（按优先级）

1. **Kilo Permission Dock 三档审批（approve once / always / deny）+ per-tool 规则**：解决审批疲劳。移植方式：只读类工具允许「本会话内本工具免审」，规则展示在设置页可撤销；**write/exec 双闸保持不动**（这是纪律不是摩擦）。
2. **OpenCode `/connect` 向导 + Models.dev 目录**：移植为「Models 页三步向导：填 baseUrl → 点『拉取模型列表』（`GET /v1/models`）→ 点『测试连通』出首 token 延迟与错误原因」。内网网关用户的第一分钟体验就靠它。
3. **Cline 上下文窗口水位条 + 任务级 token/成本**：在 Composer 上方放细水位条；compaction 触发时在时间线插入系统事件「上下文已压缩，N 条早期证据被摘要」，可点开查看被压缩内容摘要。
4. **Kilo 后台代理状态条（含 Needs input 状态）**：SubagentBoard 增加折叠常驻条，子代理等待审批/提问时置顶脉冲提示，点击进入只读子会话transcript——与我们「调查子代理只读」天然契合。
5. **Kilo Markdown 会话导出**：一键把证据时间线 + 工具调用 + 审批记录导出为值班报告，直接套 C8 六类运维文档模板（含「待确认/未检查」占位）。这是把差异化变成交付物的最短路径。
6. **Kilo @terminal / @file 引用（含 500 行 / 5 万字符截断规则）**：运维版做 `@日志文件` `@terminal` `@evidence:<id>`（引用时间线上的证据卡再追问），截断规则照抄。
7. **Cline API 失败 Retry / 编辑重发**：失败的 assistant 消息尾部给「重试」「编辑后重发」，网关 4xx/5xx 显示原始错误码。
8. **OpenCode IDE 快捷键语义**：`Ctrl+Esc` 唤起聊天、`Ctrl+Shift+Esc` 新会话，注册为 VS Code keybindings（我们目前只有命令面板入口）。
9. **Roo per-mode provider profile（`modeApiConfigs`）**：映射为 per-角色模型：Investigator 绑快而便宜的模型（并行 3 个在跑），Writer/Verifier 绑强模型；在 Models 页做角色→模型映射表。
10. **Kilo 软停/硬停两档中止**：Cancel（让当前工具跑完、保留证据）与 Stop（立即终止）分开——运维取证中途硬杀会丢已到手的证据。
11. **Kilo 设置迁移向导 + JSONC 可携配置**：`~/.at-series/agent/` 下配置版本化 + 导出/导入（脱敏，`${secret:}` 占位符天然支持），方便团队内统一下发。
12. **Cline 定时代理（cron）**：`pb.inspection` 日常巡检天然应该定时跑并产日报——先做「定时提醒 + 一键启动」，不做无人值守执行（守住审批闸）。

---

## 5. 整改建议（产品层）

### P0 —— 不做就不能给 SRE 用

1. **会话持久化 + 崩溃恢复**：`SessionStore` 的 bag 落盘（JSONL 追加写，`~/.at-series/agent/sessions/`），窗口重载后 HistoryOverlay 能列出并恢复历史会话（transcript + 时间线 + 挂起审批）。理由：故障排查半小时后 VS Code 重载，证据链归零，这在值班场景等于产品不可用。四家对手全部持久化。
2. **模型目录拉取 + 连通性测试**：Models 页加「拉取模型列表」（`GET {baseUrl}/v1/models`）与「测试连接」（一次 1-token 请求，显示延迟/HTTP 状态/错误体摘要）。理由：手填模型 id + 盲配 baseUrl 是当前 onboarding 最大流失点；这也是四家里我们唯一的 ❌ 项之一。
3. **上下文/token 可见化 + compaction 透明化**：Composer 水位条 + compaction 系统事件（见借鉴 3）。理由：我们有「compact 一次 + retry 一次」的硬策略却完全不可见——被压掉的可能是关键证据，SRE 必须知情。
4. **失败重试 / 编辑重发**：UI 级 Retry 按钮 + 保留原始错误码。理由：内网网关抖动是常态，目前失败只能新开会话重问。
5. **只读工具会话级免审规则**：`approval.sessionRequiredFor` 从全局三档细化为「本会话 + 本工具」免审记忆（仅限 read 风险级），规则可在设置页查看/撤销。理由：审批疲劳会逼用户把全局开关拧到 `never`，反而摧毁双闸的意义。

### P1 —— 补齐会话体验、把差异化变成交付物

6. **值班报告一键导出**：时间线 + 证据卡 + 审批记录 → C8 模板 Markdown（借鉴 5）。这是把「证据板」从屏幕上的东西变成能贴进故障复盘工单的东西。
7. **@ 引用系统**：`@日志文件`（workspace 内文件模糊搜索）、`@terminal`（截断规则照抄 Kilo）、`@evidence:<id>`（引用证据卡追问）。
8. **子代理常驻状态条 + Needs input**：借鉴 4；同时把子代理等待审批计入状态栏挂起数（现在只算主会话审批）。
9. **第二层空态 / 首启引导链**：检测「无模型 → 引导去 Models 页」「无能力插件 → 引导装 AT 插件或配 MCP」「都齐了 → 现有 Playbook 卡」；加 VS Code walkthrough（装插件 → 配模型 → 跑通一条 `pb.inspection`）。
10. **slash 命令体系化**：`/playbook` `/model` `/export` `/abort` `/session`，复用现有 picker；同时注册 `Ctrl+Esc` 系快捷键（借鉴 8）。
11. **软停/硬停两档中止**（借鉴 10）：Cancel 保留在途工具产出为证据，Stop 立即终止。
12. **per-角色模型映射**（借鉴 9）：Investigator/Writer/Verifier 分别绑模型，Models 页出映射表，默认全走当前模型不增加配置负担。

### P2 —— 扩张面，验证后再投

13. **多会话并行**：允许 ≤2 条会话同时运行（如「查库」+「查主机」），沿用现有 bag 架构 + 并行上限治理；不做 Kilo 式 worktree（无代码隔离需求）。
14. **定时巡检**：`pb.inspection` 定时触发 + 日报导出（借鉴 12），保持「到点提醒 + 人点一下启动」，不做无人值守。
15. **IM 连接器**：on-call 场景把审批简报推到钉钉/飞书/Slack，**只推只读摘要 + 深链回 IDE 批准**，绝不在 IM 里批准 write/exec（守住双闸）。
16. **会话分享**：导出脱敏 HTML/Markdown 分享复盘（`${secret:}` 与 MCP 脱敏逻辑已有，扩展到导出面即可）；不做 OpenCode 式云端分享链接（内网环境不可接受）。
17. **配置导出/导入 + 团队下发**（借鉴 11）。

### 明确不做（防跑偏清单）

- 不做 git worktree / PR 面板 / 代码 diff 审查 / 检查点回滚——coding 工作流，与定位冲突（docs/00 已列）。
- 不做全局 auto-approve「全自动模式」——Cline 的 auto-approve 在我们场景等于拆闸。
- 不追 provider 数量与模型 marketplace——OpenAI 兼容 + OAuth 覆盖目标用户即可。
- 不把插件写面（Jenkins 触发、Nacos 发布）做成 MCP 工具——GuidedManual 是设计而非欠账（硬约束 6）。
