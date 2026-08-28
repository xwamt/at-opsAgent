# at-opsAgent 架构诊断与整改建议

> 评审范围：`/workspace`，分支 `cursor/ops-redesign-recs-5702`（HEAD `764756c`）。
> 事实基线：`npm run typecheck` 通过、`npm run compile` 通过、`vitest` 301/301 通过。
> **结论先行**：这不是"编译不过"的烂尾，而是「架构骨架基本对、但四条关键闭环没接上」的半成品——
> ① 会话真源分裂导致模型反复失忆；② 首跑模型配置没有可走通的路径；③ 审批闭环在非 playbook
> 会话中是死路；④ policy 的角色规则从未接线。这四点共同造成用户体感「连 LLM 问答配置都完不成」。

---

## 1. 现状诊断：实际代码 vs 文档目标态

### 1.1 布局与分层（大体达标）

文档 `docs/01-architecture.md` §4 描述 `packages/*` 目标态，实际是单包 `src/*` 分目录——这是文档
明确允许的第一期形态（"第一期允许先单包，但 import 规则从第一天就按层执行"）。分层纪律实际执行
良好：`src/runtime`、`src/orchestrator`、`src/policy`、`src/hub-host`、`src/prompts`、`src/protocol`
均无 `import vscode`（AGENTS.md 红线），可独立单测（17 个测试文件、301 个用例均为纯 Node）。

| 模块 | LOC | 实际职责 | 与文档偏差 |
|---|---|---|---|
| `src/host` | 5554 | VS Code 适配 + **业务中枢** | 严重超纲，见 1.3 |
| `src/runtime` | 2352 | pi SDK 封装、工具注册、子代理 runner、截断/compaction | 基本符合 docs/03 |
| `src/orchestrator` | 783 | 状态机 + TaskSpec 工厂 | **一半是死代码**，见 1.4 |
| `src/hub-host` | 487 | `createHubRuntime` 适配（ADR-001） | 符合，质量最好的模块 |
| `src/policy` | 293 | 纯函数策略闸 | 规则完整但**关键参数未接线**，见 3.4 |
| `src/prompts` | 156 | L0–L5 分层提示词 | 符合 docs/04 §5 |
| `src/mcp-client` | 762 | 第三方 MCP 三代理工具 + AT 去重 | 实现完成但被 policy 闸死，见 3.3 |
| `src/webview-*` | 7342 | Vue 3 render-only | 符合 ADR-003 |

### 1.2 关键链路的真实接线

**Chat 主链路**（能跑通的部分）：
`ChatViewProvider.onMessage` (`src/host/chatView.ts`) → `HostController.handleRequest('chat/prompt')`
→ `ensureRuntime()` 懒创建 → `createOpsRuntime` (`src/runtime/index.ts:1119`) → `createPiRuntime`
动态 `import('@earendil-works/pi-coding-agent')` → `createAgentSession({ noTools:'builtin', customTools })`
→ 事件经 `subscribeSessionEvents` → `HostController.onRuntimeEvent` → `StreamBatcher` 合批 → webview。
工具面 = `ops_*` 发现工具 5 个（`discovery-tools.ts`）+ `ops_dispatch_subagent` + `ops_read_skill` +
`ops_list_playbooks`/`ops_start_playbook` + Hub 全量业务工具（注册全量、`setActiveToolsByName` 只激活
暴露集）。这条链路的设计与 ADR-001/002 一致，`AtSeriesHubHost`（`src/hub-host/index.ts`）的
catalog 同步、abort/timeout race（`raceCall`）、At-Database `ok:false` 兼容（`isOkFalseResult`）都实现到位。

**但有三处"文档承诺 vs 代码现实"的断裂**：

1. **热注册的代价是失忆**。pi 0.84.3 的 `AgentSession` 不能事后追加 `customTools`
   （`src/runtime/index.ts:1026-1031` 注释已承认）。于是 `catalogGainedNewBusinessTool` → 
   `handlers.onCatalogNeedsRebuild` → `HostController` 直接 `disposeRuntime()`（`hostController.ts:1225`）。
   文档卖点"装插件 200ms 内工具进下一轮 LLM"，实际实现是"装插件 = 丢弃整个 LLM 会话上下文"。
2. **会话双真源**。`SessionStore`（`src/host/sessionStore.ts`）持有 UI transcript（纯内存，重载即失）；
   pi 的 JSONL 会话写到 `~/.at-series/agent/sessions/`（`SessionManager.create(cwd, dir)`，
   `runtime/index.ts:997`）但**从不读回**——pi 提供的 `SessionManager.continueRecent` /
   `switchSession`（`node_modules/.../session-manager.d.ts:197,331`）零调用。docs/03 §4 承诺的
   "崩溃恢复：重启后加载最近会话"完全没有实现。
3. **模块装载器是假抽象**。`src/host/modules.ts` 对 `runtime`/`orchestrator`/`hub-host`/`mcp-client`
   做动态 `import()` + `src/host/fallback/*` 四套兜底（合计 ~700 行）。这是 docs/10 "人力切分、
   模块可能尚未落地" 时代的脚手架——现在四个模块全部存在且被 esbuild 打进同一 bundle，import
   永不失败；兜底只会在**创建期异常**时把真实错误吞进 Output Channel，用户在聊天里只看到
   「模型运行时尚未就绪」的固定文案（`fallbackRuntime.ts:9`）。这是"配置完不成"体感的直接来源之一。

### 1.3 HostController 是 1773 行的 God Object

`src/host/hostController.ts` 同时承担：webview 请求路由（22 种 type）、runtime/orchestrator 懒创建与
重建、policy 装配（`gateToolCall`）、审批闭环（HMAC 令牌签发/校验、briefRuns/briefHashes 两张表）、
playbook 阶段驱动（`advancePlaybookForPrompt`）、L4 注入竞态防护（`stageLayerSeq`）、guidedManual、
models.json/mcp.json 读写与脱敏、SecretStorage 标志位、会话切换、子代理卡片 patch、时间线广播。
文档 `01` §2 说 Host 层"不含 LLM loop 业务"，实际上**编排业务的大脑恰恰在 host 而不在 orchestrator**。
任何一处状态（`activeRun`、`currentApproval`、`selectCountThisTask`、`lastLayerKey`）都是散落的私有
字段，跨会话重置靠 `resetSessionScopedState` 手工枚举，漏一个字段就是幽灵状态。

### 1.4 Orchestrator 一半是死代码

`createOrchestrator`（`src/orchestrator/index.ts`）导出 11 个方法，host 实际只调用
`startPlaybook`/`getRun`/`advanceTo`/`desiredSelect`/`desiredEscalateSelect`/`recordSelect`/
`requestApproval`/`applyApproval`。以下**从未被任何生产代码调用**（仅测试覆盖）：

- `spawnSubagentSpecs`（把 yaml `parallelGroup` 转 TaskSpec + SubagentCard）——host 决策改成
  "由主代理调用 `ops_dispatch_subagent`"后，这条路径整体废弃，但代码与卡片登记逻辑还留着；
- `recordSubagentResult`（失败 retry 阶梯 clone spec）——意味着 docs/04 §3.3 的
  "retry 1 → degrade → escalate" **实际只有 degrade**（`subagents.ts` 的 settle 只标状态，无重试）；
- `mergeEvidence`（证据板冲突归并）——EvidenceNote 只被 `appendEvidenceNote` 单条转成 UI 卡片，
  没有任何"证据板"聚合，`engine.ts` 的 `inConflict`/时间窗归并全是死路；
- `injectPayloadCaps`——Loki limit 的缺省注入从未挂到 invoke 链路上（policy 只做超限拦截）。

同样，TaskSpec 构造在 `orchestrator/index.ts:37-74` 与 `runtime/subagents.ts:109-189`（`buildTaskSpec`）
**双实现**，`OUTPUT_CONTRACT_BY_ROLE`、`DEFAULT_BUDGET` 等常量各复制一份。

### 1.5 三层子代理簿记

子代理状态同时存在于：① `runtime/subagents.ts` 的 `SubagentManager.records`（真调度）；
② `orchestrator` 的 `run.subagents` Map（死代码路径）；③ `SessionStore._subagents` + host 的
`activeSubagentTaskIds`（UI 卡片）。三者靠事件字符串松耦合，没有单一 owner。

---

## 2. 与 OpenCode / Kilo Code / Cline / Roo Code 的架构差距

| 维度 | OpenCode / Kilo | Cline / Roo | at-opsAgent 现状 | 差距评估 |
|---|---|---|---|---|
| **进程模型** | client-server：`opencode serve` 暴露 OpenAPI 3.1 + SSE，TUI/IDE/Web 都是客户端；Kilo VS Code 扩展打包 CLI 二进制，spawn 一个共享 `kilo serve` 子进程，经 `@kilocode/sdk` HTTP+SSE 驱动 | 扩展进程内 Controller→Task 循环，webview 经消息协议 | 扩展进程内 loop（ADR-001 有充分理由：Hub 热注册、loopback invoke） | 进程内**选择本身正确**（ops 场景无 CLI 资产、要 fs.watch 低延迟），差距在于没有像 OpenCode 那样把 core 收敛成**单一 API 面**——host 直接摸 runtime/orchestrator/hub 三个对象的内部方法 |
| **会话** | OpenCode：session 是一等 REST 资源（`POST /session`、resume、fork、share），全部状态在 server 侧持久化，客户端可随时重连；Kilo：CLI/VS Code/Cloud 同一会话可接力 | Cline：任务历史落盘、checkpoint 可恢复 | UI transcript 内存态 + pi JSONL 写不读；runtime 重建（换模型/新插件/切会话/保存配置）= LLM 全失忆；VS Code 重载 = UI 历史也没了 | **最大差距**。竞品的会话是系统的中心资源，本项目的会话是两份互不认账的副产品 |
| **工具循环** | 工具结果同步作为 tool result 回给模型；权限请求是"挂起等待用户"（OpenCode permission ask、Cline 的 approve 按钮挂起当前工具调用） | 同左；Cline `ask` 机制把审批做成工具调用内的 await | 审批 = `beforeToolCall` 抛错拒绝 + 期望模型"批准后重试同一调用"（`hostController.requestSessionApproval`）；一次审批消耗 2 个完整模型轮次，且重试时 args 略有变化 → 哈希不匹配 → `OPS_APPROVAL_STALE` 再来一轮 | 差距明显：拒绝-重试模式浪费 token、易抖动；pi 的 `execute(toolCallId, params, signal)` 完全允许在 execute 内 await 用户决策 |
| **子代理** | OpenCode/Kilo：task/subagent 是**阻塞式工具调用**，父会话拿到 tool result 才继续；Kilo Agent Manager 做多会话并行 + git worktree 隔离 | Roo：`new_task` 委派模式，父任务挂起等子任务 | `ops_dispatch_subagent` 立即返回 `{taskId,status:'queued'}`，结果完成后经 `deliverToMain` 用 `mainSession.prompt()` **以 user 角色回灌**（`runtime/index.ts:837-844`） | fire-and-forget + user-role 注入是最脆的方案：角色污染、与真实用户输入竞争 steer/followUp、模型无法把结果与 taskId 对齐、3 个 investigator = 3 个额外完整轮次 |
| **skill** | OpenCode/Claude Code 式 skills：frontmatter 索引进 prompt，命中后按需读正文；Kilo 继承 | Roo modes ≈ 角色化 prompt 包 | `skills/` 打包 + `OpsResourceLoader`（additionalSkillPaths 白名单）+ `ops_read_skill` 渐进披露——**方向正确**，是本项目做得较好的部分 | 小差距：无用户级 skill 管理 UI（settingsSnapshot 里 `skills: []` 硬编码为空）、vendor 镜像无版本校验 |
| **权限** | OpenCode：`permissions` 配置（allow/ask/deny + glob 模式，per-agent）；Cline：auto-approve 矩阵按操作类别、UI 直接可调 | 同左 | `evaluatePolicy` 规则硬编码；唯一用户旋钮 `approval.sessionRequiredFor` 三档；**role/riskCeiling 参数从未被调用方传入**（见 3.4） | 规则本身贴合 ops（risk 三级、命令哈希绑定、payload caps 都是竞品没有的好东西），但接线断了、可配置性为零 |
| **配置/模型** | OpenCode：`opencode.json` + models.dev 目录数百 provider 预设 + `/connect` 引导；Kilo：登录即用 500+ 模型、零 key 起步；Cline：provider 下拉 + 每 provider 独立凭证字段 | 同左 | 手写 `~/.at-series/agent/models.json`（或 `modelsView.ts` 的单 provider OpenAI-兼容表单）；**全局唯一一个** SecretStorage key（`atOpsAgent.llmApiKey`），启发式注入 `options.model?.provider ?? getRegisteredProviderIds()[0]`（`runtime/index.ts:812`） | **第二大差距**，直接对应用户抱怨。pi 的 ModelRuntime 本身自带内置 provider 目录 + per-provider 凭证（`setRuntimeApiKey(providerId, key)`、OAuth `login`），本项目只用了 1% |

---

## 3. 致命问题（会让 LLM 问答 / agent loop 跑不起来的架构缺陷）

按对"第一次聊天"杀伤力排序：

### 3.1 首跑配置没有可完成的路径 ★体感元凶

- 空安装 → `models.json` 不存在 → `resolveModel` 抛「没有任何配置了有效凭证的模型」
  （`runtime/index.ts:621`）→ `createOpsRuntime` 吞异常返回 `createFallbackRuntime` → 聊天永远回复
  `FALLBACK_NOTICE`「未配置模型，请在设置中写入 API key」。
- 用户去设置页：`modelsView.ts` 表单只支持「第一个 provider + OpenAI 兼容 baseUrl + 单模型 + 单 key」。
  想用 Anthropic/DeepSeek 官方端点？必须手写 models.json 并理解 pi 的 `api`/`compat` 字段语义——
  文档在 `docs/03 §3`，产品里没有。
- 就算填对了：key 存进**全局唯一** `atOpsAgent.llmApiKey`；`createPiRuntime` 把它注入
  `options.model?.provider ?? getRegisteredProviderIds()[0]`——首次没有 modelSelection 时注入的是
  pi 内置 provider 列表第一个（通常 anthropic），不是用户配置的 `internal-gateway` → 占位符
  `${secret:…}` 被当 bearer token 发出去 → 401。（代码在 `runtime/index.ts:805-831` 有二次补注入，
  但依赖 `resolveModel` 成功选中该 provider，鸡生蛋。）
- 所有失败细节只进 Output Channel（`modules.ts`、`hostController.log`），聊天里是固定文案。
  用户没有任何可操作的错误信息。

### 3.2 会话真源分裂 + runtime 重建即失忆

触发 `disposeRuntime()` 的路径：`model/set`（换模型）、`models/save`（保存配置）、
`onCatalogNeedsRebuild`（**任何新插件工具上线**）、`session/new`、`session/switch`。
重建后 `SessionManager.create` 开新 JSONL，pi 侧上下文归零；而 `SessionStore` 的 UI transcript
还在，用户看到完整历史、模型却完全不记得——这是"agent 很傻"的直接机制。
附带 UI bug：`subscribeSessionEvents` 的 `messageCounter` 每次重建归零，新会话第一条 assistant 事件
id 又是 `msg-1`，`onRuntimeEvent` 的 `store.findItem('msg-1')` 命中**旧条目**，新回复文本会追加到
历史上第一条消息里（transcript 串写）。

### 3.3 审批闭环在非 playbook 会话中是死路

`gateToolCall` → `needSessionApproval` → `requestSessionApproval` 需要 `this.activeRun`
（`hostController.ts:1421-1422`）。纯问答会话（没启动 playbook）里：
- 任何 write/exec 业务工具 → 永久 block，返回「请先产出 9 要素审批简报」——但**简报只能由
  orchestrator 在 run 里产生**，模型没有任何工具能产生它。死循环。
- 更糟：`descriptor` 查不到的工具 risk 一律 fail-closed 为 `exec`（`hostController.ts:1338`），
  而 `mcp_list_servers`/`mcp_search_tools`/`mcp_call_tool` 三个外部 MCP 代理工具**不在 hub 目录里**
  → 全部按 exec 走审批 → 全部死路。第三方 MCP 功能（762 行 `src/mcp-client`）在真实会话中
  一次也调不通。

### 3.4 policy 的角色规则从未接线（防御层丢失）

`OpsRuntimeHandlers.beforeToolCall` 的 ctx 只有 `{ toolName, args }`（`runtime/index.ts:159-162`）。
主会话与**子代理子会话**共用同一个 `handlers`（`runSubagentSession` → `executeBusinessTool` →
`applyToolGate(handlers,…)`），host 的 `gateToolCall` 构造 `PolicyContext` 时 `role`/`riskCeiling`
**永远是 undefined**。结果：`evaluatePolicy` 的规则 3（investigator read 硬顶）、规则 4（writer 无
业务工具）、规则 7（executor 无 token 拒绝）全部是死代码。子代理越权唯一防线是
`filterToolsForSubagent` 的注册期过滤——单层防御，且 hub 暴露集中途扩面（escalateSelect）后新工具
对在跑子代理立即可见。docs/07 承诺的"三道闸"第①道对子代理实际不存在。

### 3.5 playbook 状态机必然死锁

- `advancePlaybookForPrompt`（`hostController.ts:891`）按**用户消息数**推进：第一条消息
  triage→selecting→investigating。之后没有任何路径前进：到 `synthesizing` 只能靠
  `requestSessionApproval` 顺带 `tryAdvance`（`:1436-1438`）；到 `reporting`/`closed` 没有任何
  调用方（模型没有 `ops_advance_stage`/`ops_close_playbook` 工具，UI 没有按钮，host 没有超时）。
- 卡死在 `investigating` 的后果：policy 规则 1/2 让 `ops_clear_tool_selection` 与二次
  `replace` select **永久**被拒（`TASK_BOUNDARY_STAGES` 只认 closed/triage）；`activeRun` 永不清空，
  主代理 `ops_start_playbook` 第二条链路被「已有进行中的 playbook 不要叠加启动」拒绝。
  一次 playbook = 整个会话被单向阀锁死。

### 3.6 子代理结果以 user 角色回灌 + Executor 令牌是"表演性校验"

- `deliverToMain` 把子代理摘要作为用户消息 `prompt()` 进主会话：角色污染、taskId 对不上工具调用、
  3 个并行 investigator 结束 = 3 次额外完整推理轮次、若用户恰好在打字则互相 steer。
- L3 提示词要求模型「计算 commandSetSha256」（`prompts/layers.ts:52`）——LLM 不可能正确计算 SHA-256。
  `buildTaskSpec` 对 `approvalToken` 只查非空字符串（`subagents.ts:127-140`），不对照
  `briefHashes`。真正的哈希校验在 invoke 期 `deriveCommandSetHash` 与 host 内存 `currentApproval`
  比对——但那与 dispatch 的 token 无关。Executor 链路要么因模型编不出哈希而永远派不出去，
  要么派出去的 token 是装饰品。

### 3.7 兜底体系放大而非缓解故障

四套 fallback（`fallbackHub`/`fallbackRuntime`/`fallbackOrchestrator`/`fallbackDedup`）在模块必然
可加载的现实下，唯一作用是把创建期错误静默降级：`FallbackOrchestrator.advanceTo` 甚至**不校验
迁移表**，`applyApproval` 不发 token 却返回 resolved 事件——一旦真 orchestrator 创建失败，审批 UI
看起来在工作、令牌却永远不会签发，属于"安静地假装成功"，比 crash 更难排查。

---

## 4. 整改建议（P0 / P1 / P2）

### P0-1 会话单真源：pi JSONL 为中心，runtime 可续接（不失忆）

- **问题**：3.2。双真源 + 五种触发的重建失忆 + transcript 串写。
- **目标态**：pi 会话文件是唯一会话真源。`OpsRuntime` 增加 `sessionFile` 概念：重建（换模型/新工具）
  时用 `SessionManager.create` 的 resume 能力（`switchSession`/`continueRecent`，pi 0.84 已提供）
  接续同一 JSONL；VS Code 重载后 `SessionStore` 从 sessions 目录反序列化历史；换模型优先探测
  pi `AgentSession` 的运行期 setModel 能力，探测不到再重建+续接。事件 id 用 `randomUUID` 而非
  `msg-${counter}`。
- **改哪些文件**：`src/runtime/index.ts`（`createPiRuntime` 增 `options.resumeSessionFile`、导出当前
  sessionFile；修 `subscribeSessionEvents` id 生成）；`src/host/hostController.ts`
  （`disposeRuntime`→`rebuildRuntimePreservingSession`；`setModel`/`onCatalogNeedsRebuild`/`switchSession`
  三处改走续接）；`src/host/sessionStore.ts`（增加从 JSONL hydrate 的加载器，UI transcript 变缓存）。
- **为何**：OpenCode/Kilo 的核心竞争力就是"会话是一等资源、随处可续"；ops 场景一次故障排查动辄
  几十分钟，中途装个插件就失忆是不可接受的。
- **风险**：pi JSONL v3 的 fork/checkpoint 语义需要摸清；续接后 `setActiveToolsByName` 与新工具面的
  一致性要补一轮测试；transcript 反序列化要处理 interrupted tool_call。

### P0-2 首跑模型配置向导 + per-provider 凭证

- **问题**：3.1。
- **目标态**：聊天空态出现「配置模型」引导卡（不是 Output Channel 文案）。设置页提供 provider
  预设目录（anthropic / openai / deepseek / qwen / kimi / zhipu / openai-compatible 自定义），每个
  provider 独立 SecretStorage 键（`atOpsAgent.apiKey.<providerId>`）；`createPiRuntime` 按 provider
  精确注入（pi `ModelRuntime.setRuntimeApiKey(providerId, key)` 天然支持多 provider），删除
  `getRegisteredProviderIds()[0]` 启发式。`createOpsRuntime` 失败时把 `describeError` 结果作为
  assistant 消息进聊天（含「打开设置」命令链接），而不是只写日志。
- **改哪些文件**：`src/host/secrets.ts`（键空间改 per-provider）、`src/host/modelsView.ts` +
  `src/webview-settings/*`（provider 目录表单）、`src/host/modelsCatalog.ts`（合并 pi 内置目录 +
  models.json）、`src/runtime/index.ts:805-831`（凭证注入改精确匹配）、
  `src/host/hostController.ts:createRuntime`（失败上屏）。
- **为何**：这是用户抱怨的字面问题。pi 已经内置了 Cline 级别的 provider 目录与 OAuth，本项目
  只是没把它暴露出来；不需要自研，只需要接线。
- **风险**：SecretStorage 键迁移（老 `atOpsAgent.llmApiKey` 要做一次性搬移）；models.json 里
  `${secret:…}` 占位符语义要与新键空间对齐。

### P0-3 审批改为"工具调用内挂起等待"，且不依赖 playbook run

- **问题**：3.3。拒绝-重试模式 + activeRun 依赖 = 非 playbook 会话 write/exec 永久死路。
- **目标态**：`beforeToolCall` 返回 `needSessionApproval` 时，runtime 在该工具的 `execute` 内
  `await host.requestApproval(brief)`（pi 的 execute 是 async + AbortSignal，天然支持挂起；Cline/
  OpenCode 皆此模式）：批准→继续 invoke 同一调用；拒绝→返回结构化拒绝结果给模型（不是抛错）。
  审批简报生成从 orchestrator 剥出独立 `ApprovalService`（brief 构造 + HMAC 签发 + briefHashes），
  playbook run 存在时仅额外做阶段推进。
- **改哪些文件**：`src/runtime/index.ts`（`applyToolGate` 改为可返回 `waitApproval` 回调、
  `OpsRuntimeHandlers.beforeToolCall` 签名扩展）；`src/host/hostController.ts`
  （`requestSessionApproval` 去掉 `!run` fallback、抽 `ApprovalService`）；`src/policy/index.ts` 不变。
- **为何**：一次审批一次轮次；哈希绑定在同一调用内天然成立（不存在"重试 args 漂移导致 STALE"）；
  外部 MCP / 无 playbook 场景立即可用。
- **风险**：挂起期间用户切会话/关窗口需要超时与 abort 级联（复用现有 `raceCall` 模式）；
  需防模型并发发起多个待审调用（限流 1 个 pending brief）。

### P0-4 把 role/riskCeiling/session 身份接进 policy 闸

- **问题**：3.4。角色规则死代码，子代理单层防御。
- **目标态**：`OpsRuntimeHandlers.beforeToolCall` ctx 扩展为
  `{ toolName, args, origin: { kind: 'main' } | { kind: 'subagent', taskId, role, riskCeiling, approvalToken } }`；
  `runSubagentSession` 构造 per-task 的 gate 包装注入 spec 上下文；host `gateToolCall` 把 origin
  透传给 `evaluatePolicy`。同时删除 L3 "模型计算 commandSetSha256" 的要求，`ops_dispatch_subagent`
  的 executor 分支由 host 从 `currentApproval` 自动附上真实 token（模型只提供 briefId）。
- **改哪些文件**：`src/runtime/index.ts`（handlers 类型、`executeBusinessTool` 增 origin 参数、
  `runSubagentSession` 闭包注入）；`src/host/hostController.ts:gateToolCall`；
  `src/prompts/layers.ts` L3、`src/runtime/subagents.ts:buildTaskSpec`。
- **为何**：docs/07 三道闸的第①道必须对子代理真实生效；executor 令牌必须由 host 补全而非模型幻觉。
- **风险**：低。纯接线 + 类型扩展，policy 测试已覆盖规则本身。

### P1-1 Playbook 状态机瘦身 + 显式完结通道

- **问题**：3.5 死锁；11 状态的 mermaid 图是文档产物，代码里只有 3 个状态被真实驱动。
- **目标态**：两选一。(a) 保守：保留状态机，但给模型 `ops_advance_stage`（校验走 `assertTransition`）
  与 `ops_close_playbook` 工具，reporting/closed 后自动 `selection.clear()` + 清 `activeRun`；
  (b) 推荐：把 playbook 降级为「L4 注入的阶段化 checklist + select 代发指令」（模式而非状态机），
  policy 的 select/clear 限制改按"任务开始以来的轮数与显式完结"判定。删除 orchestrator 死代码
  （`spawnSubagentSpecs`/`recordSubagentResult`/`mergeEvidence` 或接线或删）。
- **改哪些文件**：`src/runtime/playbook-tools.ts`（新工具）、`src/orchestrator/engine.ts`/`index.ts`
  （砍状态或砍死代码）、`src/host/hostController.ts`（`advancePlaybookForPrompt` 删除按消息数推进）、
  `src/policy/index.ts`（边界判定）。
- **为何**：OpenCode/Roo 的经验是"模式 + 提示词 + 权限差异"远比硬状态机可靠；模型驱动阶段
  推进与 ADR-005"模型只在阶段内决策"并不矛盾——迁移合法性仍由 `assertTransition` 把关。
- **风险**：(b) 改动面大，需重写 policy 的 stage 相关规则与 8 条 yaml；先做 (a) 可小步止血。

### P1-2 子代理改阻塞式工具调用

- **问题**：3.6 角色污染与轮次浪费。
- **目标态**：`ops_dispatch_subagent` 的 execute 内 `await` 到终态，工具结果 = 摘要 + evidenceNote
  JSON（UI 事件流不变，卡片照常实时更新）；并行场景提供 `tasks[]` 数组参数一次派发一组、聚合返回
  （对齐 OpenCode task / Claude Code Task 的并行块语义）。删除 `deliverToMain`。
- **改哪些文件**：`src/runtime/index.ts`（dispatch execute、删 deliverToMain）、
  `src/runtime/subagents.ts`（manager 增 `waitFor(taskId)`）、`src/prompts/layers.ts` L2 措辞。
- **为何**：pi 工具 execute 支持长 await + AbortSignal；同步返回让模型天然获得 taskId↔结果对应，
  省掉每个子代理一整轮"消化回灌"的推理。
- **风险**：主会话工具调用超时预算要放宽到子代理 `maxWallMs`；用户中止需从 signal 级联（已有）。

### P1-3 删除模块装载器与 fallback 四件套，错误显式上屏

- **问题**：1.2/3.7。假抽象吞错。
- **目标态**：`activate.ts`/`hostController.ts` 静态 import 四个模块；创建期失败 = 聊天内错误卡
  （含原因与修复动作按钮）+ Output Channel 详情。保留唯一合理的兜底：`createFallbackRuntime`
  （runtime 内部，缺 key 场景），但其文案带上 `reason`（已实现）并附「打开设置」深链。
- **改哪些文件**：删 `src/host/modules.ts`、`src/host/fallback/*`（约 -700 行）；
  `src/host/hostTypes.ts` 的 `*Like` 鸭子类型替换为真类型 import。
- **为何**：多团队并行施工期已结束；每层 fallback 都是一处行为分叉与测试负担，且是"配置完不成
  但没人知道为什么"的元凶之一。
- **风险**：低。`hostTypes.ts` 类型收紧可能暴露一些隐藏的 optional 调用，正好清理。

### P1-4 外部 MCP 工具的 risk 声明与 gate 白名单

- **问题**：3.3 后半。`mcp_*` 代理工具被 fail-closed 成 exec。
- **目标态**：`ProxyToolSource` 增加 `risk` 字段（`mcp_list_servers`/`mcp_search_tools` = read，
  `mcp_call_tool` = 按目标工具 annotations，缺省 write→走审批）；`gateToolCall` 对非 hub 工具改查
  runtime 注册表而非一律 exec。
- **改哪些文件**：`src/mcp-client/external.ts`、`src/runtime/index.ts`（proxy 注册处）、
  `src/host/hostController.ts:gateToolCall`。
- **风险**：`mcp_call_tool` 的目标工具风险未知——保守按 write 并复用 P0-3 的挂起审批即可，不再死锁。

### P1-5 工具热更新不再整体重建

- **问题**：1.2-①。新插件 → dispose runtime。
- **目标态**：短期：结合 P0-1 的会话续接，重建成本降为"续接 + 重注册"，且把重建时机推迟到会话
  idle（`agent_end` 后）而非事件到达即刻；长期：向 pi 上游提 `session.addTools(defs)` API（或本仓
  维护一个"通用桥工具" `ops_call_tool {name,args}` 作为未注册新工具的兜底通道，直到下次自然重建）。
- **改哪些文件**：`src/runtime/index.ts`（`onCatalogNeedsRebuild` 触发条件与时机）、
  `src/host/hostController.ts:1225`。
- **风险**：`ops_call_tool` 兜底会绕过 per-tool schema 校验，需在 gate 里补参数校验。

### P2-1 收敛出 `OpsCore` facade（为 server 化预留，不现在抽进程）

- **目标态**：`runtime + orchestrator + hub-host + policy + mcp-client` 之上收一个
  `createOpsCore(options): { sessions, tools, approvals, playbooks, events }` 单一 API，host 只依赖
  它与 `src/protocol` envelope。将来若要 OpenCode 式多客户端（CLI 值班脚本、Web 值班台），
  只需给 facade 套 HTTP/SSE 壳。
- **改动**：新 `src/core/index.ts`；`hostController` 按 P2-2 拆分后逐步迁移。
- **风险**：纯重构，需要 P0/P1 落地后做，否则是在流沙上砌墙。

### P2-2 拆分 HostController

- ChatService（prompt/事件桥）、ApprovalService（P0-3 已剥）、PlaybookService、ConfigService
  （models/mcp/settings 读写）、CapabilitiesService。每个 ≤300 行，`handleRequest` 变路由表。

### P2-3 历史会话 UI 接真源

- 历史抽屉列表从 `~/.at-series/agent/sessions/*.jsonl` 扫描（标题取首条 user 消息），点击 =
  P0-1 的续接；删除 `SessionStore` 的内存 `_bags` 兜底。

### P2-4 Skill 管理与证据板补完

- 设置页恢复 skills 页签（用户目录 `~/.at-series/agent/skills` 的增删 + 查看）；把
  `mergeEvidence` 接到 host 的 evidenceNote 聚合路径，Ops 看板显示冲突便签——否则删掉这 130 行。

### P2-5 Playbook 回归 evals

- 用 `test/fixtures` 的 fixture Bridge 跑 8 条 yaml 的端到端脚本（真模型可选、record/replay 优先），
  作为升级 pi / mcp-hub 版本的守门员（docs/10 阶段 3 验收从未落地）。

---

## 5. 推荐目标架构图

```text
┌────────────────────────── VS Code / Cursor 扩展宿主 ──────────────────────────┐
│                                                                               │
│  Webviews (Vue3, render-only)          TreeView-less UI (Cline 式单视图)      │
│   chat / settings / board                                                     │
│        ▲  Envelope(host-protocol) SSE 风格事件 + req/res                      │
│        │                                                                      │
│  ┌─ Host 适配层（薄）───────────────────────────────────────────────────┐    │
│  │ ChatService · ConfigService · CapabilitiesService · commands/statusbar │    │
│  │        │ 只依赖 OpsCore 单一 API（P2-1）                               │    │
│  └────────┼──────────────────────────────────────────────────────────────┘    │
│           ▼                                                                   │
│  ┌─ OpsCore（无 vscode import，可测试，可未来 server 化）────────────────┐    │
│  │                                                                        │    │
│  │  SessionService ──── pi JSONL = 唯一会话真源（resume/fork，P0-1）      │    │
│  │       │                                                                │    │
│  │  AgentRuntime (pi createAgentSession)                                  │    │
│  │       │  customTools = ops_* + hub 业务工具 + mcp_* 代理               │    │
│  │       │  execute 内挂起式审批（P0-3）/ 阻塞式子代理（P1-2）            │    │
│  │       ├── SubagentManager（in-memory 子会话，role gate 注入，P0-4）    │    │
│  │       ├── ApprovalService（brief + HMAC token，独立于 playbook）       │    │
│  │       ├── PolicyGate evaluatePolicy(ctx + origin{role,riskCeiling})    │    │
│  │       └── PlaybookService（阶段化 checklist + select 代发 + L4 注入，  │    │
│  │            模型经 ops_advance/close 显式完结，P1-1）                   │    │
│  │       │                                                                │    │
│  │  ToolProviders                                                         │    │
│  │   ├─ AtSeriesHubHost（createHubRuntime，热注册→idle 时增量重注册）     │    │
│  │   └─ ExternalMcp（mcp_* 三代理，风险声明，P1-4）                       │    │
│  └────────┬───────────────────────────────────────────────────────────────┘    │
│           │ fs.watch + 127.0.0.1 HTTP (Bridge v1，不变)                        │
│           ▼                                                                   │
│  ~/.at-series/bridges/<hostApp>/*.json      ~/.at-series/agent/{models,auth,  │
│  at.terminal · at.grafana · at.jenkins …      mcp}.json + sessions/*.jsonl    │
│  （凭据与确认弹窗留在插件内，三道闸不变）    per-provider SecretStorage(P0-2) │
└───────────────────────────────────────────────────────────────────────────────┘
```

要点：**进程模型不变**（ADR-001 维持），变的是①会话真源收敛到 pi JSONL、②审批/子代理改为
工具调用内同步语义、③policy 拿到调用方身份、④host 退回纯适配层、⑤OpsCore 成为未来
server 化（OpenCode/Kilo 路线）的唯一切口。

## 6. 明确「不要抄」的点（ops ≠ coding agent）

1. **不抄默认工具四件套**（bash/write/edit/read 全盘）。现有 `noTools:'builtin'` + AT 插件为唯一
   变更通道是正确的产品边界，Cline/OpenCode 的文件编辑循环、diff 视图、checkpoint 对 ops 无意义。
2. **不抄 OpenCode 的独立 server 进程**（现在）。ops 卖点是 Bridge registry 的 fs.watch 热注册与
   loopback invoke，同进程延迟与部署复杂度都占优；先收敛 OpsCore facade，等出现第二客户端
   （CLI 值班脚本/Web 值班台）再套 HTTP 壳。
3. **不抄 Kilo Agent Manager 的多会话并行 + git worktree**。事故指挥必须单指挥链（ADR-005 拒绝
   handoff/swarm 是对的）；并行只发生在 investigator 子代理层，不要做"8 个平行事故 tab"。
4. **不抄 auto-approve / YOLO 模式**。Cline 的 autoApprove 矩阵可以借"按类别配置"的 UI 形态，
   但 write/exec 的 9 要素简报 + 命令哈希绑定 + 插件二次弹窗是 ops 的不可妥协项，不给"全自动"开关。
5. **不抄 checkpoint/rewind 文件快照**。ops 的"回滚"是被审批的生产动作（新简报），不是本地文件
   恢复；把 rewind UI 搬过来只会诱导用户误解回滚语义。
6. **不抄 coding agent 的上下文策略**（把 repo map/文件树塞进 system prompt）。ops 的上下文预算
   应留给证据便签与工具结果；现有 L0–L4 常驻 30–40 行 + skill 渐进披露的设计优于竞品默认值，保持。
7. **不抄 MCP marketplace 直连一切**。AT 插件必须走 Bridge（凭据隔离、确认弹窗、审计），
   外部 MCP 保持 search/call 代理 + 白名单，不给第三方 MCP 工具与 AT 工具同等的一等注册待遇。
