# Round 2 · 03 — MCP Hub 内嵌与 AT 插件按需调用审计

> 审计基线：origin/main `b099484`（docs/11 停留在 `764756c`，其中「mcp_* fail-closed 调不通」等结论已过期，本文以现行代码为准）。
> 范围：Hub 内嵌路径、按需工具暴露、插件热注册 UX、第三方 MCP 并存与 AT 去重、竞品对照。
> 依赖版本：`@at-series/mcp-hub@0.3.3`（node_modules 实测）。
> 本轮在审计环境实跑 6 个在辖测试套件（hub-host / mcp-client / discovery-tools / mcp-proxy / env-snapshot / repeat-nudge）：**98/98 通过**。

---

## 1. 现状诊断

### 1.1 内嵌路径：符合 ADR-001，无红线违规

- **进程内 `createHubRuntime`，非 stdio hub.js**：`src/hub-host/index.ts:211-234`。`start()` 非阻塞（后台 watch + 探测），catalog 经 `scheduleSync` 合并刷新（:437-478），失败保留上一份目录（与 Hub 同策略）。`AGENT_HUB_VERSION = '0.1.0-ops-agent'` 仅作遥测（:36-37），全模块零 `vscode` import、零 `syncHubBundle` / `ensureAtSeriesMcpConfig` / registry 写入——ADR-001 与 ADR-004 的边界全部成立。
- **注册协议唯一**：仓内不存在任何 `extensions.getExtension(...).exports` 注册路径（全局搜索无命中）；插件接入只经 Bridge v1 registry（`~/.at-series/bridges/<hostApp>/*.json`），`detectHostApp` 直接用包内实现（`src/host/activate.ts:32-37`）。
- **风险→注解映射**：包未导出 annotations 模块，本地抄本 `toolAnnotationsForRisk`（`src/hub-host/index.ts:57-64`）经 `normalizeToolRisk` fail-closed 到 exec。docs/02 §7 已把「上游导出」列为增量项，抄本漂移风险仍在（见 §4 P2）。
- **At-Database 兼容**：`isOkFalseResult` 严格限定 `at.database` / `db_` 前缀（:116-135），2xx `ok:false` 规范化为 `OPS_DATABASE_OK_FALSE`（:369-385），不误伤其他插件业务数据里的 `ok` 字段——有单测（`test/hub-host.test.ts` 的 ok-flag payload case）。
- **取消/超时**：`raceCall` 把 `AbortSignal` + `timeoutMs` 与 `runtime.callTool` 竞速（:143-172），USER_CANCELLED 不当成模型错误（`src/runtime/index.ts:557-559` 抛错走 isError）。

### 1.2 工具如何进入 LLM：注册全量、激活暴露集

- `createOpsRuntime` 把 **live catalog 全量业务工具**注册为 pi `customTools`（`src/runtime/index.ts:722-737`），但初始 `setActiveToolsByName` 只激活「发现工具 + 常驻工具 + 当前暴露集」（:1342-1347）；`selection.onDidChange` 即时同步 active 集（:1345-1347）。**模型上下文只见 active 工具的 schema**——没有全量 dump。
- ≤ threshold（默认 20，`atOpsAgent.discovery.threshold`，`src/host/activate.ts:53-60`）且 mode=auto 时 Hub 自动暴露全部 winner，免 select（Hub v2 语义）；六插件全开（约 70+ 声明工具）时进入渐进发现。
- 五个 `ops_*` 发现工具映射 Hub meta-tools（`src/runtime/discovery-tools.ts:267-338`），`at_*` 原名不暴露给模型（`src/hub-host/index.ts:465-469` 过滤 META_TOOL_NAMES），与 Cursor 里 hub.js 的同名工具不混淆。
- **热注册**：桥 publish → `onToolsListChanged` → `scheduleSync` → `toolsEmitter`；已注册工具的上/下线经 `setActiveToolsByName` 即时生效；**全新业务工具**因 pi 0.84.3 无法事后追加 ToolDefinition，走 `catalogGainedNewBusinessTool` → `onCatalogNeedsRebuild`（:763-768、:1374-1391），流式中排队到 idle，host 以 `resumeSessionFile` 续接重建（`src/host/services/chatService.ts:339-341`）——上下文不丢。延迟预算符合 ADR-004 的「publish → 下一轮工具面」。

### 1.3 select / clear 纪律：闸门在 policy，不在暴露面

- `ops_select_tools` → `SelectionController.select` → `at_select_tools`（`src/hub-host/index.ts:400-422`）；select 计数按会话分席（`src/host/services/playbookService.ts:130-136`），playbook 进 selecting 时由 orchestrator **代发** select 并计数（:182-196、:344-358），L2 明示「已代发就别重复 select」（`src/prompts/layers.ts:51-52`）。
- policy 规则（`src/policy/index.ts:291-314`）：investigating/selecting/synthesizing 禁 clear；本任务已 select 过一轮后禁二次 replace（add 放行）。`selection ≠ ACL` 在发现层文件头就锁死（`src/runtime/discovery-tools.ts:8-9`）——真正权限在 `beforeToolCall`（`src/host/services/approvalService.ts:70-126`）+ 9 要素审批双闸。
- escalateSelect 只在用户/模型显式请求时应用 mode=add（`playbookService.ts:264-291`），host 不静默扩面。

### 1.4 ffefa91（live client context / 发现死锁修复）之后已经成立的东西

docs/13 记载的实录死锁（`healthy:false` → live catalog 空 → search/get_tool 全空 → 模型永不 select）在当前代码已被四层围堵，且全部有回归测试：

| 层 | 实现 | 证据 |
|----|------|------|
| L-env 现场注入 | 每条 prompt 前 `await hub.refresh()` + `syncLivePrompt` 合成 L-env（声明 vs live、healthy、exposed、hint），经 `buildSystemPrompt` 与 L4 共存不擦层 | `chatService.ts:170-181`、`stageLayers.ts:28-45,83-129`、`env-snapshot.ts:43-82`；`test/env-snapshot.test.ts` 8 例 |
| 发现层 stub 回退 | search 未命中回退声明清单（`live:false` + 「请 select 别 get_tool」）；get_tool 对声明未 live 的名字返回 `NOT_IN_LIVE_CATALOG` + `next:{tool:'ops_select_tools',mode:'add'}`；listProviders 附 `catalogLiveToolCount`/`liveToolCount`/顶层 hint | `discovery-tools.ts:63-104,141-177,185-206`；`test/discovery-tools.test.ts` 14 例 |
| 空转软顶 nudge | 同一工具+规范化参数连续 ≥2 次空结果，在结果 JSON 附 `nudge`（advisory 不 block），状态随 runtime 闭包 | `discovery-nudge.ts:11-19,58-113`；`test/repeat-nudge.test.ts` 14 例 |
| 提示词改写 | L0「先读 L-env、声明工具直接 select」、L2 删除「调用前先 get_tool」、healthy:false ≠ 没插件、连续 2 次空结果停止换词重搜 | `layers.ts:12-23,38-67` |

结论：**「forbid get_tool spin」在主会话路径上已闭环**；子代理根本没有发现工具（`runtime/index.ts:935-955`，只注入业务工具交集），无空转面。

### 1.5 第三方 MCP 并存与 AT 去重

- **去重单一真源** `shouldSkipAtSeriesMcpServer`（`src/mcp-client/atSeriesDedup.ts:26-45`）：名字 `AT Series` 或 command/args 指向 `**/.at-series/**/hub.js` 一律跳过 spawn；legacy 名（AT Terminal 等）只报告不删（:52-57）。`filterMcpServers` 是外部代理连接前的**强制闸**（`external.ts:473-476`），skipped 项在 `mcp_search_tools`/`mcp_call_tool` 返回 `SERVER_SKIPPED` 并把模型引回 `ops_*`（:547-551,641-645）。测试 `mcp-client` 20 例 + `mcp-proxy` 16 例覆盖 posix/windows 路径、改名条目。
- **双读者并存**：内嵌 Hub 与 Cursor 的 hub.js 同读 registry，互不写对方状态；选择态每进程独立（ADR-001 后果节）。诊断命令扫 `~/.cursor/mcp.json` 与 agent `mcp.json` 双份并打 `OPS_PROVIDER_SKIPPED` 提示（`src/host/diagnose.ts:112-159`）。
- **防爆炸**：第三方工具经 `mcp_list_servers / mcp_search_tools / mcp_call_tool` 三代理（pi-mcp search+call 模式），惰性连接、5 分钟 idle 断开、结果 8KB 硬顶、env/header/bearer 永不回给模型（`external.ts:355-448,492-667`）；与 Hub 渐进发现是**两套机制**，未合成一套 meta-tool（docs/02 §5 要求）。
- **凭证**：`mcp.json` 读回 webview 一律脱敏 `***`，save 时占位值从磁盘回填、0600 落盘、坏 JSON 拒绝回传原文（`configService.ts:227-290,327-396`）。Agent 不读任何插件 SecretStorage（全仓无该 API 调用）。

---

## 2. 按需调用缺口

### 2.1 【最重要】Hub 的 selection 120s idle 自动清除 与「任务结束才 clear」冲突

嵌入路径把 `selectionIdleMs` 留给包默认值（`src/hub-host/index.ts:223`，`DEFAULT_TOOL_SELECTION_IDLE_MS = 120_000`，包 `protocol/index.js:73`）。Hub 引擎在 `refreshCatalog` / `listToolsForMcp` / `callTool` 入口都会 `maybeAutoClearSelection`（包 `hub/server.js:280-292,455,506,516,713-714`）：**120 秒无任何 callTool 活动即整体清空选择**。

运维会话里这非常常见：用户读输出 3 分钟再说「继续」、write/exec 审批挂起等待（审批期间闸门拦在 `hub.invoke` 之前，不产生 selection activity）。后果链：

1. 下一条 prompt 的 `ctx.hub.refresh()`（`chatService.ts:173`）先触发 idle-clear → L-env 合成时 `exposed: 无`；
2. 模型被 hint 引导重新 select；若在 investigating 且本任务已 select 过，`mode=replace` 会被 policy 规则 2 拒绝（`policy/index.ts:303-314`），只能靠模型自己想到 `mode=add`——一次纯浪费的往返，最坏时模型对着 SELECTION_FORBIDDEN 困惑；
3. **状态撒谎**：hub 侧自动清除不经过 `AtSeriesHubHost.clearSelection`，adapter 的 `selectedNames` 只在自己的 select/clear 里更新（`hub-host/index.ts:414-434`），此后 `selection.state().selected` 与真实暴露面脱节；`configService.handleToolCatalogChange` 还会基于这份陈旧 state 做 autoEnableNew 剔除判断（`configService.ts:109`）。

docs/02 §3.1 写「嵌入路径用运行时默认，不用 installer 的 0」——该结论写在 Agent 侧还没有 policy/审批接管纪律的时期，现在 select 纪律已由 policy + playbook 状态机全权负责，Hub 侧 TTL 变成了第二只互相打架的手。这直接违反产品约束「clear only at task end」。

### 2.2 外部 MCP 代理的 risk 声明没接线：只读代理被当 exec 审批

`RISK_BY_PROXY_TOOL`（`external.ts:367-373`：list/search=read，call=write）**全仓无人消费**。闸门 `gateToolCall` 只查 hub catalog，未知非 `ops_` 工具 fail-closed 成 exec（`approvalService.ts:78-80`）；UI 侧 `runtimeEvents.ts:63-67` 同样逻辑，`mcp_list_servers` 在聊天里挂红色 exec 徽章。后果：每次列服务器/搜工具都要走 9 要素审批（sessionRequiredFor=write-exec 默认值下），第三方 MCP 的「按需发现」流程实质被审批打断——方向安全但违背 external.ts 自己声明的契约，也是 docs/11 遗留问题的残留一半（当年是「调不通」，现在是「读也要审批」）。`ops_read_skill` / playbook 工具靠 `ops_` 前缀豁免，不受影响。

### 2.3 任务结束没人 clear

docs/02 §3.2 的表写明「任务 Closed 时 Orchestrator 调用 `selection.clear()`」。现实：`closePlaybook` 只重置 selectCounts（`playbookService.ts:253-255`），会话驱逐（`chatService.onSessionEvicted`）也不清 hub 选择。`selection.clear()` 全仓唯一调用方是模型的 `ops_clear_tool_selection`（`discovery-tools.ts:238`）。于是「调查中禁止 clear」有闸（✓），「任务结束清空」全靠模型自觉（✗）——上一任务的暴露面会静默漂进下一任务（直到 2.1 的 idle TTL 把它随机清掉，两个 bug 互为遮掩）。

### 2.4 schema dump / get_tool 空转 / select 乱抖的现状评估

- **不再全量 dump**：active 集控制模型可见 schema（§1.2）；L-env 每插件只列前 8 个声明名（`env-snapshot.ts:40,60-65`）。遗留小项：`ENV_SNAPSHOT_MAX_LINES = 40` 声明了但没 enforce（:37）。
- **get_tool 空转**：主会话已被 stub 回退 + nudge + L2 围堵（§1.4），无 playbook 的普通会话同样生效（nudge 状态在 runtime 闭包）。
- **select 乱抖**：playbook 会话被规则 2 限住；**无 playbook 的普通会话 stage=undefined 恒算任务边界，replace 无限次放行**（`policy/index.ts:305-306`，`test/policy-gaps.test.ts:66-76` 把它测成了特性）。纯聊天里的 select 纪律只剩提示词约束——可接受，但与 SuperOps 第 8 条的措辞有距离，建议至少在 nudge/文案上对连发 replace 做软顶。

### 2.5 插件热注册 / 离线 UX 缺口

- **Capabilities 页远低于 docs/02 §8 规格**：`CapabilitiesTab.vue`（65 行）只有 displayName、healthy 徽章、pluginId、toolCount、bridgeCount。缺：每插件工具展开列表 + risk 徽章、`connectedTargets`、declared vs live 计数对比、unhealthy 的行动入口（「打开插件」/一键诊断——诊断有命令但在按钮区不区分场景）、`plugins.autoEnableNew=false` 的「待启用」态。数据侧 `settingsSnapshot.capabilities` 用裸 `getProviders()`（`configService.ts:73-79,137`），没复用发现层 `listProviders` 的 live 注解——UI 想显示也拿不到。
- **autoEnableNew=false 半实现**：`handleToolCatalogChange`（`configService.ts:86-123`）只在「已有显式选择」时剔除新插件工具；发现模式下只记日志，新插件声明名照样进 L-env 被模型 select——「待启用，用户点一次才 select 得上」（docs/02 §6）没有落地，也没有任何 UI 通知。
- **discovery.mode/threshold 改了不生效**：Hub 在 activate 一次性创建（`activate.ts:53-60`），`patchConfig` 能写这两个键（`configService.ts:17-18`）但无人监听重建——静默 no-op 直到 reload window，设置页也没提示。
- **allowBackgroundAccess**：插件侧 `UNAVAILABLE` 错误文案经 `normalizeCallResult` 原文透传（`hub-host/index.ts:358-365`），docs/07 与 vendor skill 附录有纪律，但 L1/L2 常驻层没有一句「把该文案原样告知用户、不要发明 instanceId」（只有 docs/05 §159 的 UI 规范提过）；无单测锁「UNAVAILABLE 原文不丢」。
- **插件中途离线**：下线工具经 `setActiveToolsByName` 即时消失、Hub 有 90s winner-grace 防抖（包 `server.js:reconcileSelection`）——机制对；但聊天侧没有任何「插件 X 桥已断开」的 notice，模型下一次调用直接吃 unknown-tool，用户只能从下一轮 L-env 里推断。

### 2.6 其他小项

- `mcp_search_tools` 空 query 会惰性连接**全部** keep 服务器（`external.ts:565-591`）——规模小无碍，服务器多时应并发上限或先列 server。
- `directTools` 解析后仅回显（`external.ts:46-53`），既没首类注册（声明为后续阶段，OK）也没在代理内当白名单 enforce——配置了等于没配。
- L2/L-env 完全不提 `mcp_*` 三代理，模型只能靠工具描述自己发现第三方 MCP 面。

---

## 3. 竞品对照

### 3.1 延迟加载工具 schema

| | 机制 | 触发 | 粒度 | 失效/重载 |
|---|---|---|---|---|
| **Claude Code / Agent SDK ToolSearch**（2.1.x 默认开） | 编排层持有全量 schema，模型只见目录摘要 + ToolSearch 工具；`tool_reference` 命中后**下一轮**才把 3–5 个 schema 注入 tools 数组 | MCP 工具描述 >10K token（auto 档为上下文 10%） | 单工具 | compaction 后需重新 search；`alwaysLoad` 白名单常驻 |
| **Codex CLI** | 无延迟加载；`enabled_tools`/`disabled_tools` 静态白/黑名单裁剪暴露 | 配置期 | 单工具 | 每会话固定，约 5K token 起步税 |
| **OpenCode v2** | `codemode` 默认开：工具经 Code Mode 间接暴露（非直出 schema）；`codemode:false` 才直出 | 配置期 | 每 server | — |
| **at-opsAgent（本仓）** | Hub 渐进发现：≤20 直出，>20 只出 5 个 `ops_*` 元工具 + 已选集；`setActiveToolsByName` 控制模型可见 schema；L-env 注入目录摘要 | threshold=20（工具数而非 token 数） | pluginId 为主，names 可选 | **selection 120s idle 被 Hub 清掉（缺陷 2.1）**；compaction 不清选择（优于 Claude） |

结构上本仓与 ToolSearch 同构且各有胜负：L-env 的「host 先注入现场」比 Claude 的纯 search 起步更快；但 threshold 按条数不按 token、selection 有一个对手没有的隐性 TTL。**不需要引入 ToolSearch 式新机制，把 2.1/2.3 修掉即达到同等按需水位。**

### 3.2 接入形态：marketplace / 配置向导 vs 零配置 Bridge

- Kilo：Settings→MCP 图形化增删/开关 server + Marketplace 现成配置 + CLI `kilo mcp add|list|auth`；OpenCode：`opencode mcp add|auth` + 远端 `.well-known/opencode` 组织级配置 + OAuth（含 PKCE 动态注册）；Codex：`codex mcp add|list|login`。
- 本仓 AT 系列走 Bridge v1 **零配置**（装插件即出现），这是对手都没有的体验，必须保持；第三方 MCP 侧则明显弱：只有脱敏 JSON 文本框 + 卡片列表（`McpTab.vue`），无 add-server 表单、无连接状态/工具数、无 OAuth（`bearerToken` 静态配置而已）。差距按 P2 排（运维场景第三方 MCP 是 phase-4 增强，不值当先做 OAuth）。

### 3.3 权限映射

- Kilo：`{server}_{tool}` 三态 allow/ask/deny + 通配 + 「Approve Always」落盘；Codex：`enabled_tools`/`disabled_tools` + `default_tools_approval_mode`；Claude Code：permission prompt + allowedTools。
- 本仓是**风险分级制**（read 放行 / write-exec 双闸 + 命令内容只读推断 `inferEffectiveRisk`，`policy/index.ts:241-256`）+ 会话级 read 免审名单（`approval.sessionReadAllowlist`）。对 AT 插件这套优于对手（risk 是插件声明的一等字段，对手都没有）；对第三方 MCP 则退化成「一律 exec」（缺陷 2.2），连 Codex 的静态白名单都不如。映射建议：`RISK_BY_PROXY_TOOL` 接线（P0）+ `directTools` 当代理白名单 enforce（P1），**不要**照搬 Kilo 的 per-tool 三态大表——AT 侧 risk 语义更强，重复建一套 ACL 反而稀释审批语义。

---

## 4. 整改建议

### P0

| # | 事项 | 文件 | 验收 |
|---|------|------|------|
| P0-1 | **嵌入路径关闭 selection idle TTL**：`createHubRuntime` 传 `selectionIdleMs: 0`（保留 `selectionMaxCalls: 0`）；改 docs/02 §3.1 的过期论述。配套：hub 侧任何暴露面收缩时对账 adapter 的 `selectedNames`（`syncOnce` 里 exposed 业务工具为空且 selectedNames 非空 → 清空并 fire selectionEmitter），消掉状态撒谎 | `src/hub-host/index.ts:217-228,453-478`；`docs/02-capability-hub.md` | 新单测：select 后注入 >120s 时钟（或注入 idleMs）再 refresh，exposed 不缩水、`selection.state().selected` 与暴露面一致；现有 98 例不回归 |
| P0-2 | **任务边界统一 clear**：`closePlaybook` 成功收尾后与 `onSessionEvicted` 时 host 调 `ctx.hub.selection.clear()`（失败只记日志）；写 timeline 事件保持可审计 | `src/host/services/playbookService.ts:231-257`、`chatService.ts:240-246` | closePlaybook 后 `selection.state().selected` 为空；investigating 中 clear 仍被闸拒（既有 policy 测试） |
| P0-3 | **外部 MCP 代理 risk 接线**：`gateToolCall` 与 `runtimeEvents.tool_start` 对 `EXTERNAL_MCP_PROXY_TOOL_NAMES` 查 `RISK_BY_PROXY_TOOL`（list/search=read，call 维持 write）；其余未知工具继续 fail-closed exec | `src/host/services/approvalService.ts:78-80`、`src/host/services/runtimeEvents.ts:62-73` | `mcp_list_servers`/`mcp_search_tools` 不再触发审批、UI 徽章为 read；`mcp_call_tool` 仍走 write 审批；`test/policy-gaps.test.ts` 补 3 例 |

### P1

| # | 事项 | 文件 | 验收 |
|---|------|------|------|
| P1-1 | **Capabilities 页对齐 docs/02 §8**：settingsSnapshot 改用发现层 `listProviders` 注解（liveToolCount/catalogLiveToolCount/connectedTargets）；卡片可展开工具列表 + risk 徽章；unhealthy 行加「运行诊断」按钮；autoEnableNew=false 时新插件显示「待启用」+ 一键 select | `configService.ts:128-144`、`CapabilitiesTab.vue`、`webview-settings/helpers.ts:750-780` | `test/settings-ui.test.ts` 断言 live 计数、待启用态、诊断按钮 |
| P1-2 | **discovery.mode/threshold 热生效**：监听 `onDidChangeConfiguration`，变更时销毁重建 HubHost（runtime 经既有 rebuild 通道续接）；短期最少在设置页提示「需重载窗口」 | `src/host/activate.ts:52-67`（或下沉 configService） | 改 threshold 后无需 reload，下一轮 L-env 的暴露口径变化 |
| P1-3 | **插件离线 notice**：`onDidChangeTools` 的 removed 非空且属于当前暴露集时，向活动会话发一条 `notice`（「AT Terminal 桥断开，N 个工具暂不可用」），恢复时同理 | `hostController.ts:110-113` 或 `configService.handleToolCatalogChange` | 手测拔桥；单测 removed→notice 事件 |
| P1-4 | **directTools 在代理内 enforce**：配置了 directTools 的 server，search/call 只允许名单内工具（越界返回结构化错误），首类注册仍不做 | `src/mcp-client/external.ts` | `test/mcp-proxy.test.ts` 补白名单越界 case |
| P1-5 | **allowBackgroundAccess 透传锁死**：单测断言 Bridge `UNAVAILABLE` + 引导文案原文到达模型结果；L2 加一行「UNAVAILABLE 引导原文告知用户，禁止发明 instanceId」 | `test/hub-host.test.ts`、`src/prompts/layers.ts` | 单测 + L2 文案断言 |

### P2

| # | 事项 | 文件 |
|---|------|------|
| P2-1 | L-env enforce 40 行硬顶 + 追加一行第三方 MCP 摘要（keep 数量 / mcp_* 三代理存在） | `env-snapshot.ts`、`stageLayers.ts` |
| P2-2 | 向上游 `@at-series/mcp-hub` 要 `getSelectionState` / annotations 导出（docs/02 §7 表 1、3 项），删本地抄本 | 上游 issue + `hub-host/index.ts` |
| P2-3 | 无 playbook 会话的连发 replace select 软顶（nudge 式提醒，不 block） | `discovery-nudge.ts` 或 policy |
| P2-4 | McpTab 增加连接状态/工具数列（复用 `mcp_list_servers` 的 `connected` 字段）与 add-server 表单；OAuth 远期再议 | `McpTab.vue`、`configService.ts` |

### 明确不该做

1. **不做 per-plugin MCP server**（每插件一个 MCP 入口 / InMemoryTransport 再包一层）——ADR-001 已论证：丢 pluginId/risk/审计一等字段，重复渐进发现。
2. **不把 selection 当 ACL**——select 只管暴露面；权限永远在 policy 双闸 + 插件确认弹窗（`discovery-tools.ts:8-9` 注释即红线）。
3. **不给 Jenkins / Nacos / Grafana 造写 MCP 工具**——触发构建、发配置是 GuidedManual（docs/02 §2、docs/11 反模式 7）；同理不绕过 `allowBackgroundAccess`。
4. **不把第三方 MCP 与 Hub 发现合成一套 meta-tool**、不把外部工具与 AT Bridge 一等并列（docs/02 §5、凭据边界）。
5. **不由 host 静默全选插件**（tools 税，docs/13 §4.5）；harness 预选必须落 timeline 可审计。
6. **不恢复 extension exports 注册**（ADR-004）；不写 registry、不 spawn hub.js。
