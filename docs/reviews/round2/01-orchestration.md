# 第二轮评审 01 · Agent 工作流与编排（P0–P2 落地后）

> 评审对象：`origin/main` HEAD `b099484`（P0–P2 已落地：`7f02f86` 重设计、`7606910` Host 拆件 + 双 runtime、`dcf63a5`/`ffefa91`/`b099484` 巡检 UX）。
> 范围：仅 Agent 工作流与编排（ReAct / 静态-动态编排 / 多代理协作 / 主代理拆分调度）。UI、模型配置、Hub 协议不在本篇。
> 方法：通读现行代码 + 竞品（OpenCode / Kilo Code / Codex CLI / Claude Code）公开架构对照。docs/11 评的是 `764756c`，其 P0-A~E、P1-6/7/15、P2 会话池均已发货，本篇只谈剩余缺口。

---

## 1. 现状诊断

### 1.1 循环形态：pi 原生 ReAct + Playbook 状态机 harness + 局部 plan-then-execute——骨架正确

- **主循环**是 pi SDK 的原生 observe-think-act 闭环，未 fork（ADR-002）。主会话工具面 = 5 个发现工具 + `ops_dispatch_subagent` + 4 个 playbook 工具 + `ops_read_skill`（+可选只读工作区）+ Hub 业务工具（`src/runtime/index.ts:1266-1273`）。无 bash/write/edit，符合红线。
- **静态编排**是 11 阶段状态机：`STAGE_IDS`（`src/orchestrator/playbooks.ts:11-23`）+ 全局迁移表 `STAGE_TRANSITIONS`（`src/orchestrator/engine.ts:10-24`），非法迁移 throw，且目标阶段必须在该 playbook yaml 声明的阶段集合内（`src/orchestrator/index.ts:202-211`），因此 `pb.security-triage` 结构上进不了执行路径——这是四家竞品都没有的硬保证。
- **动态性**在 P1-7 后归还给模型：host 只在首条消息代跑 triage→selecting→investigating 并代发 yaml select（`src/host/services/playbookService.ts:300-322`），之后推进/收尾全靠模型显式调 `ops_advance_stage`/`ops_close_playbook`（`src/runtime/playbook-tools.ts:114-163`）；yaml `parallelGroup` 只作为 L4 里的候选建议注入（`src/host/playbookLayer.ts:50-69`），host 不自动 spawn。**混合模式（状态机管合法性、模型管节奏）是对的**。
- **plan-then-execute 只存在于该在的地方**：Executor 的 `TaskSpec.plan[]`（backup→verifyBackup→change→readback→verify，`src/prompts/roles.ts:37-44`）绑定已批命令集；调查阶段保持自由 ReAct。这与 Codex 的「审批暂停 turn」同构且更严（9 要素 + 哈希绑定）。

### 1.2 多代理协作：阻塞式 coordinator-worker 已闭环，隔离到位

`ops_dispatch_subagent` 是阻塞式工具（P1-6）：单任务或 `tasks[]≤4` 并行，`Promise.all` 等全部终态后一次性返回摘要 JSON（`src/runtime/subagents.ts:664-686`）。子会话为 in-memory pi session，工具面 = 业务工具 ∩ allowTools ∩ 暴露集 ∩ riskCeiling，无任何 ops_* 发现/派发工具（`src/runtime/index.ts:922-983`），禁止递归；角色并行上限 investigator 4 / executor 1（`src/runtime/subagents.ts:23-28`）；预算双闸 maxToolCalls/maxWallMs + 超时 failed、超步 degraded；输出契约解析失败标 degraded 但宽松保留便签（`subagents.ts:437-495`）。Abort 级联、软停保在途证据（`runtime/index.ts:1362-1372,1441-1449`）。**这一层的调度语义、状态机、事件面在四家竞品对照下不落下风，且有角色硬隔离这一独有资产。**

### 1.3 主代理是否「只拆分+调度」：刻意不是，且理由成立

L2 明确要求单台已连主机由主会话直接 `run_remote_command` 巡检、禁止单目标派 `tasks[]`（`src/prompts/layers.ts:62-66`；dispatch 工具描述同款，`subagents.ts:758-770`）。即主代理 = 协调者 + 单目标调查员的混合体。对运维这是对的：单机巡检若强制走子代理，多一跳上下文搬运、慢且贵。真正的越界防护不靠「主代理不干活」，靠 policy 闸（`applyToolGate`，`runtime/index.ts:426-472`）+ 8KB 结果截断落盘（`:541-568`）。**结论：不必追求教科书式「纯调度主代理」，但下述接缝要补。**

### 1.4 死代码与文档-代码漂移（本轮主要问题）

1. **Orchestrator 半截身子悬空**。`spawnSubagentSpecs` / `recordSubagentResult` / `mergeEvidence` / `injectPayloadCaps` / `advanceStage` / `legalNextStages` / `closeRun`（`src/orchestrator/index.ts:98-112,219-281,326-441`）全部只被测试引用（`test/orchestrator.test.ts`、`test/playbook-eval.test.ts:59-80`），host 的 `OrchestratorLike` 接口根本没有这些方法（`src/host/hostTypes.ts:89-115`）。`PlaybookRun.evidence` 从不写入，证据板归并与冲突检测（`engine.ts:106-138`）在真实链路不可达。
2. **状态机双真源**。host 自建 `DEFAULT_NEXT_STAGE` 表（`playbookService.ts:25-35`）复刻迁移主线，且与 orchestrator 的 `advanceStage` 缺省语义**已经分叉**：`guidedManual` 缺省下一步 host 说 `verifying`，orchestrator（`legalNextStages[0]`）说 `reporting`（`engine.ts:20` 顺序 `['reporting','verifying']`）。docs/04 mermaid 又只画了 GuidedManual→Reporting（代码注释自己承认漂移，`engine.ts:18-20`）。
3. **`ops_close_playbook` 在 investigating/executing 阶段直接失败**。host 的收尾是硬编码两步 `tryAdvance('reporting')`→`tryAdvance('closed')`（`playbookService.ts:241-252`），从 investigating 走不通（investigating→reporting 非法），返回「无法收尾」；而 orchestrator 的 `closeRun` BFS 最短路（`index.ts:250-281`）正是为此写的，host 不用。巡检链路首条消息即被推进到 investigating，这是**最常见的收尾路径**。
4. **工具描述承诺未兑现**。`ops_advance_stage` 描述说「非法迁移会返回 ok=false 并列出合法的下一步」（`playbook-tools.ts:117-119`）；实际 `IllegalStageTransitionError` 带的合法下一步列表被 `tryAdvance` 吞掉只进日志（`playbookService.ts:333-341`），回给模型的只有「无法从 X 迁移到 Y」（`:226`）。
5. **派单参数面残缺**。`SubagentDispatchInput.inputs`（timeWindow/targets/contextNotes）类型存在（`subagents.ts:66`），但工具 JSON schema `DISPATCH_TASK_PROPERTIES` 没有 `inputs` 字段且 `additionalProperties:false`（`subagents.ts:690-789`）——模型**没有任何通道**给子代理传结构化时间窗/目标清单，一切只能塞进 `goal` 一句话。Claude Code 的 delegation message、我们自己 docs/04 §3.2 的 `inputs` 设计名存实亡。
6. **重试阶梯断头**。`buildTaskSpec` 写死 `escalation:{retries:1,onFail:'degrade'}`（`subagents.ts:188`），但 dispatch 路径的 `settle` 对 failed 没有任何重试消费；实现了重试 clone 的 `recordSubagentResult` 无人调用。docs/04 §3.3「失败 retry 1 → degrade」是纸面协议。
7. **payloadCaps 未注入**。`injectPayloadCaps`（Loki limit≤100 缺省补参）从未在 `executeBusinessTool` 链路被调用；上限目前只靠 L1 提示词自觉。
8. **子代理提示词自相矛盾**。子代理复用整个 `L0_IDENTITY`（`roles.ts:82`），而 L0 里是主会话发现指令（「第一动作读 L-env / ops_list_providers / 先 ops_select_tools」，`layers.ts:12-23`）——这些工具子会话一律没有，L3' 又明令禁止（`roles.ts:16-19`）。同时子代理没有任何 L-env'/现场层，连接目标全靠 goal 转述。
9. **per-role 模型是 UI 期货**。`chatService.createRuntime` 读取并传入 `roleModels`（`chatService.ts:354-372`），但 `CreateOpsRuntimeOptions` 没这个字段（`runtime/index.ts:326-360`），`runSubagentSession` 恒用主会话模型（`:1127`）。investigator 派 4 个并行全烧旗舰模型。

---

## 2. 竞品对照表

| 维度 | OpenCode | Kilo Code | Codex CLI | Claude Code | at-opsAgent 现状 |
|---|---|---|---|---|---|
| 循环形态 | Effect 驱动的会话循环（streamText + 工具流），plan/build/explore 是「权限规则集+prompt」的 agent 切换 | 复用 OpenCode server 同一引擎；Orchestrator mode 负责拆分与合并 | app-server 线程/turn 生命周期；ToolOrchestrator 统一 审批→沙箱→执行→重试 | 原生 ReAct；hooks（PreToolUse 等）做确定性拦截 | pi 原生 ReAct + playbook 状态机 harness；policy 闸同构 hooks ✅ |
| 静态 vs 动态 | 无状态机；agent/permission 配置是静态面，编排全动态 | 同 OpenCode；Agent Manager 是人肉看板不是状态机 | 无业务状态机；approval policy 是静态配置 | 无状态机；skills/hooks 静态、编排动态 | **混合**：yaml 状态机管合法迁移，模型管推进节奏——独有且该保留 |
| 子代理形态 | task 工具 → 子 session；BatchTool 并行工具调用 | 自定义 subagent（jsonc/markdown）；并行 subagent 归父代理合并 | 无用户级 subagent；Guardian 子代理做执行前自动风险评审 | Task/Agent 工具，隔离上下文只回摘要；`skills` 预载、`maxTurns` 预算、禁递归 | 四角色 TaskSpec + 输出契约 + riskCeiling 硬顶；禁递归 ✅ 但派单缺 `inputs` 通道 ❌ |
| 阻塞 vs 后台 | task 阻塞；另有 BackgroundJob 服务 | 阻塞为主；Agent Manager 卡片长活 | turn 内同步；审批把 turn 挂起 | 阻塞缺省 + `background:true` 异步收割（TaskOutput） | 仅阻塞（P1-6）；`tasks[]` 批内并行、批间串行 |
| 结果合并 | 父 session 收 tool result 自行综合 | Orchestrator mode「智能合并」（模型侧） | n/a | 只回摘要，父模型综合 | 摘要 ≤3200 字 + evidence-note 结构化解析 ✅；timeWindow 冲突归并未接线 ❌ |
| 隔离/回滚 | git write-tree 快照每步可 undo；worktree 并行 | 每 agent 一个 git worktree，diff 评审后合并 | landlock/bubblewrap 内核沙箱 + externalSandbox | worktree 隔离可选；PreToolUse deny | 隔离 = 凭据不进扩展 + 双闸审批 + GuidedManual；无 undo（运维不可 undo，正确） |

**该学**：① Claude Code 的 delegation message——派单要能带结构化上下文（→建议 3）；② Claude Code `background:true` + 收割工具的后台子代理形态（→建议 6，最小版）；③ Codex 的 `acceptForSession` 审批分级（对应 docs/11 P1-9，属审批篇不展开）与 Guardian「执行前自动风险预审子代理」思路——可映射为「9 要素简报生成前先派 verifier 只读预检」；④ Kilo 的子代理 transcript 只读检视器——我们子代理卡有 goal/visibleTools/latest，缺完整过程检视（属 UI 篇，仅存档）。

**不该抄**：OpenCode git 快照 undo / Kilo worktree 并行（运维对象是生产系统不是工作副本，回滚必须是被审批的正向动作）；OpenCode/Kilo 的独立 server 进程（Bridge 热注册要同进程，ADR-001）；Codex 内核沙箱（我们的边界在插件桥与凭据隔离）；Claude Code 的通用 general-purpose 子代理（我们的角色/契约特化是护城河）。

---

## 3. 核心建议

### R1（P0）状态机单真源：host 改用 orchestrator 的 advanceStage / legalNextStages / closeRun

- **问题**：诊断 §1.4-2/3/4——双真源已分叉（guidedManual）、investigating 无法一次收尾、错误信息不带合法下一步。
- **运维意义**：巡检/指标链路 90% 的收尾发生在 investigating；close 失败的直接后果是模型放弃收尾、报告不落盘、席位工具选择不重置。guidedManual 缺省下一步分叉会让 Jenkins/Nacos 手动发布后「跳过只读确认」直接 reporting——违背 docs/04 §2.2 的 Verifying 意图。
- **设计**：`OrchestratorLike` 增加 `advanceStage?/legalNextStages?/closeRun?`；`PlaybookService.advancePlaybook` 删 `DEFAULT_NEXT_STAGE` 改调 `orchestrator.advanceStage`（缺省下一步语义收敛到一处，guidedManual 缺省按 docs/04 §2.2 调整迁移表顺序为 `['verifying','reporting']`，mermaid 同步改）；`closePlaybook` 改调 `closeRun`（BFS 逐步发阶段事件，`ensureVisibleInspectionReport` 兜底保留）；失败路径把 `legalNextStages` 塞进工具结果 JSON。
- **改动文件**：`src/host/hostTypes.ts`、`src/host/services/playbookService.ts`、`src/orchestrator/engine.ts`（迁移表顺序）、`docs/04-ops-orchestration.md`（mermaid）、`test/playbook-tools.test.ts`。
- **验收**：pb.inspection 在 investigating 调 `ops_close_playbook` 一次成功，阶段事件依次 synthesizing→reporting→closed；非法 advance 的工具结果含 `allowedNext:[…]`；`rg DEFAULT_NEXT_STAGE src/` 为空。

### R2（P0）打通派单 inputs 通道

- **问题**：诊断 §1.4-5——工具 schema 没有 `inputs`，时间窗/目标/上下文便签只能挤进 goal 一句话。
- **运维意义**：并行取证的价值在「同一时间窗、不同证据面」；没有结构化 timeWindow，investigator 各自猜窗口，evidence-note 的 timeWindow 归并（R4）无从谈起；多主机巡检没有 targets 清单，只能靠 goal 里的自然语言列举。
- **设计**：`DISPATCH_TASK_PROPERTIES` 增加 `inputs {timeWindow{from,to}, targets[{kind,id}], contextNotes[]}`（与 `TaskSpec.inputs` 同形，schema 已有类型支持）；L2 的 dispatch 段加一句「并行取证必须给统一 timeWindow」。
- **改动文件**：`src/runtime/subagents.ts`（schema + 描述）、`src/prompts/layers.ts`、`test/runtime.test.ts`。
- **验收**：带 `inputs.timeWindow` 派单，L5 TaskSpec JSON 含该窗口；`tasks[]` 内 4 条任务共享同一窗口时子代理便签 timeWindow 一致。

### R3（P1）重试阶梯接线：failed → 同 spec 重试一次 → degrade

- **问题**：诊断 §1.4-6——`escalation.retries` 无消费，瞬时失败（桥抖动、超时）直接 failed 回主模型，主模型只能手工重派、烧一轮主会话推理。
- **设计**：在 `createSubagentManager.settle` 中，`status=failed`（非 userAborted、非 timedOut 的 runner 异常）且 `spec.escalation.retries>0` 时自动 clone spec（taskId 加 `-retry`，retries 减 1）重新入队；`runDispatchToolCall` 的 `waitFor` 跟随重试任务终态。放弃 orchestrator 侧 `recordSubagentResult`（删除或标记 test-only）。超时（maxWallMs）**不**自动重试——超时重试大概率再超时且翻倍占位。
- **改动文件**：`src/runtime/subagents.ts`、`test/runtime.test.ts`；删除或收编 `src/orchestrator/index.ts:401-441`。
- **验收**：假 runner 第一次 reject、第二次 resolve → dispatch 工具结果 `status:'ok'` 且 taskId 带 `-retry`；aborted/timedOut 不重试；重试仍失败标 failed 且 error 注明「已重试 1 次」。

### R4（P1）证据冲突归并接线（或删除）

- **问题**：诊断 §1.4-1——`mergeEvidence` 的 timeWindow 冲突互标（docs/04 §3.3「冲突生成冲突便签」）在真实链路不可达；并行 investigator 给出矛盾结论时主模型只能靠自己读出来。
- **设计**：`runDispatchToolCall` 在 `tasks[]` 全部终态后，对解析出的 `evidenceNote[]` 调 `engine.mergeEvidence`，把互标后的 conflicts 写回各任务结果再序列化；host 侧 `appendEvidenceNote` 透传 conflicts（协议 `EvidenceNoteView` 加可选字段）。若认为价值不足，则删除 `engine.ts:92-138` 并改 docs/04——二选一，不许继续悬空。
- **改动文件**：`src/runtime/subagents.ts`、`src/host/services/subagentCards.ts`、`src/protocol`、`test/runtime.test.ts`。
- **验收**：两条同窗、同 subject、不同结论的便签返回时，工具结果里两条 note 的 conflicts 互含对方 id；主模型提示词无需改动即可在 Synthesizing 引用。

### R5（P1）子代理提示词去矛盾 + 最小现场层

- **问题**：诊断 §1.4-8——L0 的发现指令对子代理是禁区；子代理无现场信息。
- **设计**：`layers.ts` 拆 `L0_IDENTITY` 为 `L0_CORE`（身份、中文优先、证据三态、未检查纪律）与 `L0_MAIN_BOOTSTRAP`（L-env/发现/select 引导，仅主代理）；`composeSubagentPrompt` 用 `L0_CORE`。`runSubagentSession` 在 L5 后追加一行现场：实际注入的工具名清单（已算好，`runtime/index.ts:935-955`）+ 派单 `inputs.targets`。不给子代理完整 L-env（省 token、防发现冲动）。
- **改动文件**：`src/prompts/layers.ts`、`src/prompts/roles.ts`、`src/runtime/index.ts`、`test/runtime.test.ts`（断言子代理提示词不含 `ops_list_providers`）。
- **验收**：`composeSubagentPrompt(...)` 输出不含「ops_list_providers / ops_select_tools / L-env」字样；含「可见工具：…」清单。

### R6（P2）per-role 模型接线

- **问题**：诊断 §1.4-9——roleModels 配置链路到 runtime 断头。
- **设计**：`CreateOpsRuntimeOptions.roleModels?: Partial<Record<SubagentRole,{provider,id}>>`；`runSubagentSession` 按 `spec.role` resolveModel（失败回落主模型，注入该 provider 的 key 走既有 `injectApiKey`）。investigator/writer 默认可配便宜模型，executor/verifier 建议跟主模型。
- **改动文件**：`src/runtime/index.ts`、`test/runtime.test.ts`；host 侧已就绪。
- **验收**：配置 `roleModels.investigator` 后，假 hub 记录到的子会话 model 与主会话不同；未配置行为不变。

### R7（P2）派发的有限后台化：`waitMs` 早返 + `ops_check_subagent`

- **问题**：阻塞派发（P1-6）本身是对的（结果经 tool result 单点回灌、无伪 user 消息），但 `tasks[]` 里最慢一个决定整批返回（最长 180s），期间主会话整轮挂起，用户新消息只能 steer 排队；跨插件长取证（如数据库慢查询分析 + 主机巡检）无法边收边推进。
- **设计**：不做自由 fire-and-forget。给 dispatch 增加可选 `waitMs`（缺省=阻塞到底，保持现语义）：超时先返回 `{status:'running', taskId}` 的部分结果；新增只读 `ops_check_subagent {taskId}` 复用 `waitFor`/`statusOf` 收割终态。Claude Code `background:true`+TaskOutput 的最小移植，manager 已有全部原语（`subagents.ts:557-592`），改动集中在工具面。
- **改动文件**：`src/runtime/subagents.ts`（schema + runDispatchToolCall）、`src/runtime/index.ts`（注册收割工具，仅主会话）、`src/prompts/layers.ts`、`test/runtime.test.ts`。
- **验收**：`waitMs:5000` + 假 runner 10s：5s 返回 running；`ops_check_subagent` 阻塞到终态返回同款摘要 JSON；不带 `waitMs` 行为与今日完全一致；子代理仍无收割工具（禁递归不破）。

### R8（P2）payloadCaps 接线或删除 + 主会话空转软顶扩面

- **设计 a**：`runSubagentSession` 的 `executeBusinessTool` 前对 args 过一遍 `injectPayloadCaps(spec.toolPolicy.payloadCaps)`；dispatch schema 不暴露 payloadCaps，由 host 在有 playbook run 时从 yaml defaults 补进 spec。做不动就删 `injectPayloadCaps` 并改 docs/04 §3.2。
- **设计 b**：`discovery-nudge` 目前只对 search/get_tool 的同参数连续空结果计数（`discovery-nudge.ts:58-73`）；对「同一业务工具+同参数连续 ≥3 次相同失败」也附 advisory nudge（不 block），防主会话对故障桥空转。状态同样闭包在 runtime 内。
- **验收**：loki 工具无 limit 派单时子会话实际调用带 `limit:100`；同参数业务工具第 3 次失败的结果 JSON 带 nudge 字段。

---

## 4. 明确不做什么

1. **不做 swarm / handoff**：事故指挥权不可转移（ADR-005），主代理永远是唯一协调者；不引入 Claude Code Teammate/多人协作面。
2. **不做 coding 式 worktree / git 快照 undo**（Kilo Agent Manager、OpenCode Snapshot）：运维动作没有「影子副本」，回滚是走 9 要素审批的正向变更。
3. **不做 NL 正则自动启动 playbook**：`triggers.patterns` 永远只是 whenToUse 提示词（`playbook-tools.ts:5-8` 已固化），是否开链路由模型判断、用户可见。
4. **不做递归子代理**：子会话不注册 dispatch/收割工具（R7 的 `ops_check_subagent` 同样仅主会话）；不做子代理间直接通信，结果一律经主会话合并。
5. **不放开并行上限**：investigator 硬顶 4、executor 恒 1、会话席位 ≤2（`runtimePool.ts:20`）不动；不做「8 卡看板」式多 agent 并跑。
6. **不做 host 自动 spawn parallelGroup**：yaml 候选建议维持 advisory（`playbookLayer.ts:50-69`）；orchestrator 的 `spawnSubagentSpecs` 若 R1–R4 后仍无消费方，降级为 test fixture 或删除。
7. **不 fork pi loop、不自研全局 plan-then-execute 规划器**：OpenCode 的 plan agent 模式对 coding 有价值，对 on-call 是延迟税——playbook 状态机就是我们的「计划」，阶段内保持自由 ReAct。
8. **不把 Jenkins/Nacos 写面 MCP 化、不在 IM 里审批**：GuidedManual 是设计不是欠账（docs/04 §2.2）。

---

### 附：验证基线

本篇结论基于 `b099484` 工作树逐文件核对；所有 file:line 引用以该提交为准。建议 R1/R2 作为下一迭代首批（都不动协议、不动 UI，纯 host/runtime 内改动，测试面已有 `test/playbook-tools.test.ts` / `test/runtime.test.ts` 承接）。
