# 15 · 优化整改建议（对照 OpenCode / Kilo / Codex / Claude Code）

> **落地施工请走 [plans/2026-08-29-duty-loop/00-index.md](plans/2026-08-29-duty-loop/00-index.md)。** 本文是审查结论与优先级，不再当逐文件施工清单。
>
> 评审对象：`origin/main` HEAD `b099484`（P0–P2 会话体验已落地之后）。
> 对照产品：OpenCode V2、Kilo Code（OpenCode server 重建版）、OpenAI Codex CLI/IDE、Claude Code（用户所称 cloudecode）。
> 方法：主代理只做拆分调度；七名子代理并行审编排、UI、MCP Hub、记忆、运行时、体验/基础功能、竞品与其它方向。分项原文见 [reviews/round2/](reviews/round2/)。
> 与 [docs/11](11-redesign-recommendations.md) 的关系：**docs/11 是历史基线，不再当待办清单。** 其 P0 已全部落地；本文件是下一阶段施工真源。与已冻结 ADR 冲突时：进程模型 / 双闸 / GuidedManual / 不走 `exports` **以 ADR 为准**；Hub idle TTL、任务结束 clear、状态机单真源、落盘脱敏 **以本文件为准**（落实的是 ADR 已承诺但代码未接线或接线打架的部分）。

## 0. 结论先行

上一轮命题「通用会话体验对齐 Kilo/Cline 及格线」已经完成：CJS 产物能跑、2 分钟能问答、会话可续接、审批不绑 playbook、Markdown/codicon 过关，487/487 测试绿。

这一轮的命题换成：**运维纵深从「能聊天、能查」升级为「能值班」**——编排接缝要封死、按需调用不能被 Hub TTL 偷清、落盘不能带密码、文档能落工作区、证据链可导出可审计。

| 排序 | 根因 | 杀伤力 | 分项 |
|------|------|--------|------|
| 1 | **Hub 120s idle TTL 在嵌入路径未关**：审批等待 / 用户读输出即静默清选择，且 adapter `selectedNames` 撒谎 | 调查中途工具面蒸发，policy 还禁止 replace | [MCP Hub](reviews/round2/03-mcphub.md) |
| 2 | **`ops_close_playbook` 从 investigating 走不通**：host 硬编码 reporting→closed，巡检最常见收尾点直接失败 | 报告不落、选择不重置、席位锁死 | [编排](reviews/round2/01-orchestration.md) |
| 3 | **审批 waiter 无 TTL，软停不解挂** | 两席全挂审批 → 池耗尽，只剩硬停 | [运行时](reviews/round2/05-runtime.md) |
| 4 | **工具结果未脱敏就落 JSONL / ui-sessions / tool-results** | 运维输出里的密码/连接串永久落盘 | [记忆](reviews/round2/04-memory.md) |
| 5 | **第三方 MCP 只读代理被 fail-closed 成 exec** | 列服务器也要走 9 要素，按需发现被审批打断 | [MCP Hub](reviews/round2/03-mcphub.md) |

战略一句话：**通用层已经及格，不要再做成 coding agent；把双闸、证据链、Bridge 零配置做成可验证的信任基础设施。** 对手第二曲线是 OS 沙箱 / 云执行 / 企业 managed settings / OTel——我们翻译成 ops 语义：策略下限、防篡改审计流、内网 OTLP、国产 IM 单向通知。

最短下一路径：**P0-A Hub TTL + 任务结束 clear → P0-B 状态机单真源（巡检能收尾）→ P0-C 审批超时/软停 → P0-D 落盘脱敏 → P0-E 复制+导出入口。** 五项落地即可达成「一次完整巡检：选插件 → 取证 → 可见结论 → 导出报告，中途审批不会丢工具面」。

---

## 1. 现状一句话（b099484）

| 层 | 判断 |
|----|------|
| 设计文档 | ADR-001/002/003/004/005 仍然正确；docs/05 信息架构已与代码严重漂移，必须重写 |
| 通用会话 | 向导、流式、续接、软硬停、水位、Retry、工具卡折叠——对齐 2026 及格线 |
| 编排骨架 | pi 原生 ReAct + 11 阶段 playbook harness + Executor 局部 plan-then-execute：**形态对** |
| 编排接缝 | orchestrator 半截悬空；host 自建迁移表已与 engine 分叉；dispatch 缺 `inputs` |
| Hub 嵌入 | 进程内 `createHubRuntime`、零 hub.js、零 exports、AT 去重、L-env 死锁围堵：**红线成立** |
| 按需调用 | 模型只见暴露集 schema；但 idle TTL 与「任务结束才 clear」互殴 |
| 记忆 | 会话记忆已闭环；长期运维记忆为零；压缩是 coding 摘要；落盘无脱敏 |
| 运行时 | bundle 已实证修复；审批挂起同构 Claude/OpenCode；不做 OS 沙箱是对的 |
| UI | token/语义色/折叠卡/子代理 inspector 产品级；富文本「能排版不能干活」（无高亮、无复制、流式裸源码） |
| 基础功能 | 导出引擎在、方向盘没装；运维文档编辑完全缺失 |
| 差异化 | Playbook 状态机、9 要素双闸、证据三态、Bridge 零配置、GuidedManual、Investigator 硬只读——四家对手都没有 |

不要把本产品做成又一个 coding agent。docs/11 §3.2 的「不该抄」全部维持。

---

## 2. 分维度：对照四家主流 Agent 之后该怎么改

### 2.1 Agent 工作流与编排（ReAct / 动静态 / 多 Agent）

**现状。** 主循环是 pi 的 observe-think-act，未 fork。静态面是 11 阶段状态机（非法迁移 throw；`pb.security-triage` 结构上进不了执行）。动态面在首条消息代跑 triage→selecting→investigating 并代发 yaml select 之后，节奏全交模型 `ops_advance_stage` / `ops_close_playbook`。子代理是阻塞式 coordinator-worker：`tasks[]≤4` 并行、禁递归、investigator 硬顶 4 / executor 恒 1、输出契约。主代理**刻意不是纯调度者**（单机巡检主会话直做）——对运维成立。

**对照。** OpenCode/Kilo 全动态 + task 子会话 + worktree；Codex 无用户级 subagent，审批挂起 turn；Claude Code 隔离上下文只回摘要，可 `background:true` 收割。我们的混合模式（状态机管合法性、模型管节奏、角色硬隔离）是独有资产，应保留。

**该学。** Claude Code 的 delegation message（结构化 `inputs`）；有限后台化（`waitMs` + 收割工具，缺省仍阻塞）；Codex 式执行前预检思路（简报前派 verifier 只读，不必上 Guardian 品牌）。

**不该抄。** swarm/handoff、worktree、git undo、NL 正则自动开链路、递归子代理、host 自动 spawn `parallelGroup`、全局规划器。

**整改要点（详见分项 R1–R8）：**

1. host 改用 orchestrator 的 `advanceStage` / `legalNextStages` / `closeRun`，删 `DEFAULT_NEXT_STAGE`；`guidedManual` 缺省下一步改为 `verifying`。
2. dispatch schema 补 `inputs.{timeWindow,targets,contextNotes}`。
3. 子代理提示词拆掉主会话发现指令；failed 瞬时错误自动 retry 1 次。
4. `mergeEvidence` / `injectPayloadCaps` 接线或删除，不许继续悬空。

### 2.2 前端 UI：组件与自然语言富文本

**现状。** `--vscode-*` token、风险/结论双通道、折叠工具卡、子代理 inspector、虚拟列表、空态/错误/加载、i18n 已达产品级。最大单点差距：全库零 clipboard、零语法高亮；流式期间裸渲染 `**加粗**`，收尾才切 Markdown；LogViewer 不认 ANSI；审批命令是最高风险文本却是裸 `<pre>`；协议无 wall-clock，工具卡只有耗时没有「什么时候跑的」。

**该学。** Codex 的审批决策留痕 cell 与命令一等公民；Kilo PermissionDock 的 once/deny 语法（write/exec **永不 always**）；OpenCode 一行成本/token 状态与 `/export`；Claude Code Focus view → 我们的「结论模式」。

**不该抄。** 可展开 CoT（我们恒隐藏是正确安全姿态，只补「思考了 Ns」）、write/exec 全局 auto-approve、重型图表库、mermaid、shiki、消费级气泡头像。

**整改要点：** highlight.js 核心子集（shell/sql + 自研约 30 行 PromQL）+ 事件委托复制；流式渐进 Markdown（高亮推迟到 finalize）；LogViewer strip/映射 ANSI；审批决议写入 transcript；`docs/05-ui-system.md` 按现行单 Chat IA 重写。

### 2.3 实用基础功能：文档编辑与会话导出

**现状。** `exportReport.ts` + 命令 + 测试都在，但 webview **零入口**（`chat/export` 无发送方）。导出内容模型（未决审批、证据三态、阶段轨迹）优于四家 transcript dump，缺的是入口、脱敏、JSON schema、跨会话。运维文档编辑**完全缺失**：runtime 无写工具，Writer 产出只活在聊天里，调研里的六类模板从未进 `skills/`。

**该学。** OpenCode `/export`、Kilo `/copy-session`、Claude Code 产物落盘；Codex `--sanitize` 落盘前刮密。

**不该抄。** 通用 bash/write/edit；公开分享链接；IM 里批准 write/exec。

**整改要点：** 导出三入口（view/title、历史抽屉、收尾 notice）；代码块/命令/审批三处复制；白名单目录 `ops-docs/` 的 `ops_write_ops_doc`（走既有 write 审批 + diff 预览）；六类模板 + 「待确认/未检查」结构校验；DutyReportV1 JSON + 脱敏 pass。

### 2.4 用户友好度

**已及格。** 欢迎 CTA、未配置拦截、状态栏黄字、保存并测试、401 人话、IME 保护、walkthrough 三步。2 分钟首跑在代码推演上成立。

**仍伤值班的：** 没有一键复制；导出藏在命令面板；GuidedManual 无简报时靠用户打「已完成」；历史无搜索/重命名/删除；`workspaceShell.enabled` 文案声称「跑 shell」实际只注册只读文件；walkthrough `*.en.md` 文件名错误导致英文包死；host 侧字符串硬编码中文。

**原则维持 docs/11：** 10 秒内要用的进 chrome；改一次管一个月的进设置；任何错误带通往修复界面的按钮。

### 2.5 MCP Hub 嵌入与 AT 插件按需调用

**红线全部成立。** 进程内 Hub、registry 唯一真源、不读插件凭据、AT Series 与 Cursor `hub.js` 双读者去重、L-env + stub + nudge 围死 get_tool 空转。模型上下文只见 `setActiveToolsByName` 的暴露集，不是 70+ schema dump。

**真正的按需缺口不是「再做一套 ToolSearch」。** 是两只手打架：

1. Hub 包默认 `selectionIdleMs=120000`，嵌入路径没关掉 → 审批挂起即 idle-clear。
2. `closePlaybook` / 会话驱逐从不 `selection.clear()` → 上一任务暴露面漂进下一任务；两个 bug 互相遮掩。
3. `RISK_BY_PROXY_TOOL` 无人消费 → `mcp_list_servers` 当 exec 审批。

Capabilities 页远低于 docs/02 §8（无工具列表、无 risk 徽章、无 connectedTargets、无待启用态）。`discovery.mode/threshold` 改了不生效。插件断桥无聊天 notice。

**不该做。** per-plugin MCP、selection 当 ACL、Jenkins/Nacos/Grafana 写 MCP、host 静默全选、exports 注册。

### 2.6 记忆系统

**会话记忆已闭环**（pi JSONL 真源 + `ui-sessions.json` 0600 上限 50 + `resumeSessionFile`）。**长期记忆为零**：主机别名、事故结局、巡检对比，每个值班日从零认主机。压缩走 pi 通用 coding 摘要，证据三态/已批命令集无保护；溢出后让用户手搬证据。`tool-results/` 永不清理。工具结果未刮密就落三处磁盘。

**运维记忆模型（五层，按站点 `agentDir` 而不是 repo path）：**

| 层 | 写时机 | 读时机 | 红线 |
|----|--------|--------|------|
| session | 自动 | 续接 | 刮密后落盘 |
| incident | close / 用户确认 | `ops_recall` grep | 三态 + provenance 必填 |
| environment | 用户确认的别名/拓扑 | 每 prompt 注入 L-env | 禁止自动从工具结果抽取（注入面） |
| preference | 设置 | 会话创建 | **禁止** write/exec 白名单 |
| instruction | `OPS.md` + skills | L0–L4 / `ops_read_skill` | 只读、受管锁源 |

**该学。** Claude 的有界 MEMORY.md 索引 + 压缩后磁盘回灌；Codex 落盘前刮密、按使用/老化遗忘、grep 而非向量检索。

**不该抄。** OpenCode git 快照 undo（远端生产不能靠本地 git 撤销）、Claude 按 cwd 爬 CLAUDE.md、Kilo 云同步、后台自动提炼 agent、向量库。

### 2.7 运行时设计

**已验证。** P0-A bundle shim 真修复（bundle-smoke 2/2 + 产物人工检查）。Loop 外包给 pi、闸门在 execute 内挂起、HMAC 令牌绑 sessionId、双 runtime 池硬顶 2、三层 compaction、软硬停级联——形状接近 Claude Code，约束下是正解。

**维持 in-process。** Bridge 热注册 200ms 依赖同进程；现在抽 `kilo serve` 是纯开销。OpsCore facade 已落地，等到第二客户端真实出现再套 HTTP。

**沙箱结论。** 本地零执行面，exec 在远端由插件三闸兜底——**不做 OS 沙箱是架构正确**。但 `src/policy` 手写只读命令表与插件侧 `@at-series/command-policy` 是两套平行实现，必然漂移。

**缺口。** 审批悬挂无 TTL；prompt 期 429/5xx 无一次退避、错误未脱敏；`roleModels` UI 已有、runtime 不收；`runtime/index.ts` 仍 1526 行。

### 2.8 其它必须兼顾的方向

四家 2026 战场已从会话窗转到：可移植内核、OS 沙箱、企业管控、Agent 自身可观测。我们的对位不是跟跑 coding 形态：

| 方向 | 现状 | 动作 |
|------|------|------|
| 安全审计 | 无 append-only 审计日志；JSONL/导出只是「长得像审计」 | 链式哈希 JSONL + 导出命令；接 command-policy 进简报 |
| 注入防护 | UntrustedQuotes + C7 有行为无回归 | 敌意语料进 CI |
| Agent 可观测 | 仅 Output Channel | 默认关的内网 OTLP：`tool_decision` / `approval_*` / `playbook_stage` / usage / subagent |
| 巡检调度 | interval 提醒 + 人点启动（红线对） | cron 表达；上次摘要注入 L-env；差异才是巡检价值 |
| IM | 脱敏 webhook 骨架正确 | 钉钉/飞书/企微加签卡片 + `vscode://` 深链 + 决策回执；**批准永不出 IDE** |
| 多窗口 | 未管：双定时器、双 IM、`ui-sessions.json` 竞写 | agentDir 选主 + 带版本写入 |
| 评测 | 仅 `pb.inspection` 无模型 eval | L1：8 条链路生命周期进 CI；L2：金样本事故 + rubric |
| 企业 | 用户可把 `sessionRequiredFor` 调 `never` | managed 策略下限；气隙清单产品化 |
| 技能 | 随 VSIX，vendor SuperOps 无 diff 仪式 | `skills.lock.json`；不做公开 marketplace |
| 生态位 | 中文一等 + 内网网关是对手结构性做不到的 | 补 GLM/Kimi preset；信创叙事写进一页部署清单 |

---

## 3. 统一整改路线图

下列条目已跨七份报告去重。每条含问题、落点、验收。详细论证见分项。

### P0 —— 值班中会真实伤人 / 安全会真实漏

#### P0-A 嵌入路径关闭 Hub idle TTL，任务结束统一 clear

- **问题：** §2.5。调查中途工具面被 120s 偷清；收尾又不 clear。
- **改：** `createHubRuntime({ selectionIdleMs: 0 })`；`syncOnce` 对账 adapter `selectedNames`；`closePlaybook` 成功与 `onSessionEvicted` 调 `selection.clear()`。改 docs/02 §3.1。
- **文件：** `src/hub-host/index.ts`、`src/host/services/playbookService.ts`、`src/host/services/chatService.ts`。
- **验收：** select 后模拟 >120s 再 refresh，暴露面不缩；investigating 中 clear 仍被闸拒；close 后 `selected=[]`。

#### P0-B 状态机单真源：investigating 能一次收尾

- **问题：** host `DEFAULT_NEXT_STAGE` 与 orchestrator 分叉；`ops_close_playbook` 从 investigating 失败。
- **改：** `OrchestratorLike` 接 `advanceStage` / `legalNextStages` / `closeRun`；删 host 迁移表；`guidedManual` 缺省 `verifying`；非法 advance 把 `allowedNext` 回给模型。
- **文件：** `src/host/services/playbookService.ts`、`src/orchestrator/engine.ts`、`docs/04-ops-orchestration.md`。
- **验收：** `pb.inspection` 在 investigating 调一次 close → synthesizing→reporting→closed；`rg DEFAULT_NEXT_STAGE src/` 为空。

#### P0-C 审批悬挂：TTL + 软停可预期结束

- **问题：** waiter 永不超时；`abort('cancel')` 不解挂。
- **改：** waiter 默认 10–15min 到期按 rejected（JSON 注明「审批超时」）；软停也 `rejectWaitersFor`，或 UI 明确「有工具在等审批，软停将等待」。
- **文件：** `src/host/services/approvalService.ts`、`src/host/services/chatService.ts`。
- **验收：** 挂起无人处理 N 分钟后席位释放；软停在审批挂起时能结束。

#### P0-D 落盘刮密 + 保留期限

- **问题：** JSONL / `ui-sessions.json` / `tool-results/` 原文落盘；后两者永不清理。
- **改：** 所有持久化文本过刮密器（Bearer/密码/连接串/私钥块）；`tool-results` 与 JSONL 30 天保留；导出走同一 pass。
- **文件：** 新 `src/runtime/sanitize.ts`、`src/host/sessionStore.ts`、`src/host/exportReport.ts`、`src/runtime/index.ts`。
- **验收：** 注入 `Authorization: Bearer xxx` 的工具结果落盘后为 `[REDACTED]`；导出 hits≥1。

#### P0-E 复制三处 + 导出三入口

- **问题：** 值班最高频动作（拷命令、拷结论、交班报告）没有按钮。
- **改：** 代码块 / 工具卡命令 / 审批命令集 hover 复制；view/title + HistoryOverlay + 收尾 notice 导出；save 取消不落临时文件。
- **文件：** `MarkdownBlock.vue`、`ToolCallCard.vue`、`ApprovalBar.vue`、`package.json` menus、`HistoryOverlay.vue`、`store.ts`。
- **验收：** 不开命令面板，≤2 次点击得到 .md；点击复制有「已复制」反馈。

#### P0-F 外部 MCP 只读代理按 read 放行

- **问题：** `mcp_list_servers` / `mcp_search_tools` 走 9 要素。
- **改：** `gateToolCall` 与 `runtimeEvents` 消费 `RISK_BY_PROXY_TOOL`（list/search=read，call=write）。
- **文件：** `src/host/services/approvalService.ts`、`src/host/services/runtimeEvents.ts`。
- **验收：** 列服务器不再弹审批，徽章为 read；`mcp_call_tool` 仍走 write。

#### P0-G prompt 期错误脱敏 + 一次退避

- **问题：** 429/5xx/网络统一裸文本；可能带凭证片段；401 被说成「未配置」。
- **改：** 错误过 `sanitizeErrorText`；401/403 notice + 打开设置；429/5xx **严格一次**退避；仍败带 Retry action。
- **文件：** `src/runtime/index.ts`、`src/host/modelsProbe.ts`（抽共享 sanitize）。
- **验收：** 吊销 key 引导到设置；错误文本断言不含 key。

### P1 —— 把差异化接上线，拉平仍刺手的体验

| ID | 项 | 落点 | 来源 |
|----|----|------|------|
| P1-1 | dispatch `inputs` 通道 + L2「并行取证必须统一 timeWindow」 | `subagents.ts`、`layers.ts` | 编排 R2 |
| P1-2 | 子代理提示词去矛盾（L0_CORE vs L0_MAIN_BOOTSTRAP）+ 可见工具清单 | `prompts/layers.ts`、`roles.ts` | 编排 R5 |
| P1-3 | 接 `@at-series/command-policy`；手写表降为兜底；简报展示 allow/review/deny | `package.json`、`src/policy`、`approvalGate.ts` | 运行时 / 竞品 |
| P1-4 | `ops_write_ops_doc`（仅 `ops-docs/`）+ 六类模板 + diff 进简报 | 新 `workspace-write.ts`、`skills/ops-documents/` | UX |
| P1-5 | 流式 Markdown + highlight.js 核心子集（高亮 finalize 再上） | `ChatTranscript.vue`、`MarkdownBlock.vue` | UI |
| P1-6 | LogViewer ANSI strip/映射 + 关键词 span 而非整行染色 | `LogViewer.vue` | UI |
| P1-7 | 审批决议 transcript 留痕 + 协议 wall-clock | `approvalService`、`host-protocol.ts`、`ToolCallCard.vue` | UI |
| P1-8 | Capabilities 页对齐 docs/02 §8；discovery 配置热生效；断桥 notice | `CapabilitiesTab.vue`、`configService.ts`、`activate.ts` | MCP |
| P1-9 | 运维感知 compaction：customInstructions + 证据 digest 回灌 + 自动交接新会话 | `compaction.ts`、`stageLayers.ts` | 记忆 |
| P1-10 | GuidedManual 无简报路径：notice 双按钮，删除「回复已完成」 | `guidedManualFlow.ts` | UX |
| P1-11 | 历史搜索/重命名/删除；`workspaceShell` 文案改成只读文件访问 | `sessionStore.ts`、nls | UX |
| P1-12 | roleModels 真接线或删 UI，不许配置撒谎 | `runtime/index.ts` | 运行时 / 编排 R6 |
| P1-13 | failed 瞬时错误 retry 1 次（超时/abort 不重试） | `subagents.ts` | 编排 R3 |
| P1-14 | 8 条 playbook L1 生命周期 eval 进 CI + 注入语料 | `test/playbook-eval.test.ts` | 竞品 |
| P1-15 | 重写 `docs/05-ui-system.md` 为现行单 Chat IA | docs/05 | UI |
| P1-16 | walkthrough `*.nls.en.md` + host 字符串 `vscode.l10n` | media/walkthrough、activate.ts | UX |
| P1-17 | `runtime/index.ts` 拆文件（纯搬移，每件 <400 行） | runtime | 运行时 |
| P1-18 | bundle-smoke `minify:true` 对齐产物 | `test/bundle-smoke.test.ts` | 运行时 |

### P2 —— 信任基础设施与值班闭环

- **记忆层：** `memory/environment.json`（用户确认别名注入 L-env）、`memory/incidents/` ≤200 行索引 + `ops_recall`；只读 `OPS.md`；禁止自动从工具结果抽记忆。
- **编排：** `waitMs` + `ops_check_subagent` 有限后台化（缺省阻塞不变）；`mergeEvidence` / `payloadCaps` 接线或删。
- **审计：** append-only JSONL + 链式哈希 + 按时间窗导出；managed 策略下限（`sessionRequiredFor` 用户只能更严）。
- **可观测：** 默认关的内网 OTLP（六类事件）。
- **值班面：** 钉钉/飞书/企微加签卡片 + `vscode://` 深链 + 决策回执；巡检历史差异；cron；多窗口选主。
- **UI：** 「结论模式」过滤、ApprovalBar 命令高亮与空要素折叠、board 补完 codicon、token 间距收敛、思考时长指示、Focus 不展示 CoT 内容。
- **技能：** `skills.lock.json` + vendor SuperOps diff 仪式。
- **气隙一页清单** + GLM/Kimi preset。
- **第二客户端：** 仅当真实需求出现时给 OpsCore 套 HTTP/SSE——现在不抽进程。

---

## 4. 建议落地顺序（技术依赖）

**施工拆分与文件级任务**见 [plans/2026-08-29-duty-loop/00-index.md](plans/2026-08-29-duty-loop/00-index.md)。下面只保留依赖图。

```text
P0-A Hub TTL+clear ──┬── P0-B 状态机收尾     ── 一次完整巡检能闭环
                     ├── P0-C 审批超时/软停   ── 席位不会被挂死
                     ├── P0-D 落盘刮密       ── 磁盘不再存密码
                     ├── P0-E 复制+导出入口   ── 值班交得出东西
                     └── P0-F/G MCP risk + 错误脱敏

P1-1/2/12/13 编排接缝 ── 并行取证有同一时间窗
P1-3 command-policy   ── 简报与插件权威分析器对齐
P1-4 运维文档落盘
P1-5/6/7 富文本能干活
P1-8 Capabilities / 热配置
P1-9 compaction 保证据
P1-14 eval 守门

P2 审计链 / 策略下限 / IM / 巡检历史 / 长期记忆 / 有限后台化
```

P0-A 与 P0-B 应同一迭代：clear 依赖 close 真的能 close。

---

## 5. 明确不做什么（对手每一项都在诱惑）

1. **不做 OS/内核沙箱竞赛**（Codex Seatbelt、Kilo Sandboxed Auto、Claude 域名白名单 Bash）：exec 在远端生产，沙箱保护的是错误的机器。
2. **不做云端/后台执行代理**（Kilo Cloud、Codex Cloud、Cursor Cloud Agents）：凭据不出插件宿主是硬约束，是卖点不是欠账。
3. **不做 IM 双向批准 / 手机接管。**
4. **不做 headless 无人值守 ops 执行**（`codex exec` 式）；巡检无人值守上限是只读采集，且须审计流先就位。
5. **不做 swarm / handoff / worktree / git undo / checkpoint。**
6. **不做公开技能 marketplace**；runbook 是企业资产。
7. **不把 Jenkins/Nacos/Grafana 写面做成 MCP 工具。**
8. **不把 selection 改造成 ACL**（Hub v2 INV-5）。
9. **不 fork pi、不现在抽 serve 进程、不引入 29 个入站 hooks。**
10. **不展开 CoT、不把不可信工具结果送进 Markdown/高亮管线。**
11. **不从工具结果自动抽取长期记忆**（注入通道）。
12. **不做消费级 chatbot 皮肤 / 重型图表 / mermaid。**

---

## 6. 最小验收清单（本轮 P0 完成后）

全新 profile、已能问答（docs/11 第 4 步仍绿）的基础上：

1. 装 At-Terminal（或任意 AT 插件）→ 能力页出现 provider → 开 `pb.inspection` → 工具面保持到用户读完输出（>2 分钟）仍在，不会被静默 clear。
2. 巡检结束后模型（或用户）关链路 → 一次成功 closed，选择集清空，中文结论在 transcript 可见。
3. 触发一条 exec 审批后不去点：N 分钟后席位释放，不是整窗卡死。
4. 工具返回含 `Authorization: Bearer` 的预览 → `~/.at-series/agent/` 下文件与导出报告均为 `[REDACTED]`。
5. 工具卡/代码块/审批命令可一键复制；标题栏可导出当前会话 Markdown。
6. 配置一个第三方 MCP → `mcp_list_servers` 不弹 9 要素；`mcp_call_tool` 仍弹。

任一步失败即打回。第 1–2 步是「能值班」的直接回归项。

---

## 7. 分项报告

| 文件 | 子代理范围 |
|------|------------|
| [reviews/round2/01-orchestration.md](reviews/round2/01-orchestration.md) | ReAct / 动静态 / 多代理 / 状态机漂移 / dispatch 缺口 |
| [reviews/round2/02-ui.md](reviews/round2/02-ui.md) | 富文本、组件、token、竞品 UI 模式 |
| [reviews/round2/03-mcphub.md](reviews/round2/03-mcphub.md) | Hub 嵌入、按需暴露、TTL、去重、Capabilities |
| [reviews/round2/04-memory.md](reviews/round2/04-memory.md) | 会话/工作/长期/指令记忆、刮密、遗忘 |
| [reviews/round2/05-runtime.md](reviews/round2/05-runtime.md) | loop、审批挂起、bundle 实证、进程模型、沙箱 |
| [reviews/round2/06-ux-features.md](reviews/round2/06-ux-features.md) | 首跑、导出、文档编辑、GuidedManual、i18n |
| [reviews/round2/07-competitive-other.md](reviews/round2/07-competitive-other.md) | 四家矩阵、docs/11 落地核对、安全/评测/IM/企业 |

首轮分项（[reviews/](reviews/README.md)，基线 `764756c`）仅作历史对照，施工不要再从那里抄待办。
