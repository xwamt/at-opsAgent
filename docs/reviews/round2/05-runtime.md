# Round 2 · 05 Runtime 审计（会话工厂 / LLM loop / 审批 / 打包 / 进程模型）

> 评审对象：HEAD `b099484`（分支 cursor/ops-agent-optimization-4391）。
> 对照：OpenCode（headless server + Effect + SSE + permission ruleset）、Kilo（OpenCode server 多客户端）、Codex（Rust core + 队列 JSON-RPC + OS 沙箱 + ToolOrchestrator）、Claude Code（TS 进程 + 29 事件 hooks + 4 阶段压缩 + permission pipeline）。
> 方法：只读**当前**代码；docs/11 视为过期基线。本次实际执行验证（非引用旧结论）：
> - `npm ci` + `npx vitest run` → **487/487 全绿**；`tsc --noEmit` → 0 错误；
> - `npx vitest run test/bundle-smoke.test.ts` → **2/2 绿**（CJS 单文件产物内 pi 真实流式 + Bearer 断言）；
> - `node esbuild.extension.mjs` 实际构建 `dist/extension.js` 并人工检查产物（见 §1.4）。

---

## 1. 现状诊断

### 1.1 Loop 形状：pi 拥有循环，runtime 是「装配器 + 事件桥 + 闸门宿主」——正确

LLM↔tool 循环本体在 pi `AgentSession.prompt()` 内（`@earendil-works/pi-coding-agent` 0.84.3 精确锁定，pin-guard 测试守卫三包同号），我们没有自研 loop，符合 ADR-002。`src/runtime/index.ts` 的 `createPiRuntime` 只做装配：

- **模型层**：`ModelRuntime.create` → `injectApiKey`（只对首选 provider 与实际选中模型的 provider 经 `setRuntimeApiKey` 内存注入，覆盖 models.json 的 `${secret:…}` 占位符；key 不落日志）→ `resolveModel`（显式 provider/id 不命中即抛错，绝不静默换模型）。
- **工具面**：全量注册（discovery 元工具 + `ops_dispatch_subagent` + 常驻 `ops_read_skill`/可选 `ops_read_workspace_file`/playbook 工具/外部 MCP 代理 + 全部业务工具），`setActiveToolsByName` 控暴露；selection ≠ 授权，每次 execute 都过 `applyToolGate`。主/子会话统一 `noTools:'builtin'`——**默认无 bash/write/edit** 的产品红线在两类会话上都成立（子会话在 `runSubagentSession` 同样显式关闭）。
- **steering**：`prompt(text,{mode})` 直通 pi `streamingBehavior`（steer/followUp）；运行中缺省按 steer，避免 pi 抛错。
- **事件桥**：`subscribeSessionEvents` 把 pi 事件收敛为 8 种 `OpsRuntimeEvent`（text/thinking delta、tool start/end、usage、compaction、notice、idle），host 侧 `RuntimeEventRouter` 翻译成协议事件、`StreamBatcher` 40ms 合批。

与四家对照，这个形状最接近 Claude Code（TS 进程内 query loop + 工具 execute 内权限管线），差异只在我们把循环外包给 pi——在「不 fork、不 require pi CLI」约束下是唯一正解。

### 1.2 审批：已从「拒绝-重试」演进为「execute 内挂起」，但存在**悬挂缺口**

链路（P0-D 已落地，代码与注释一致）：

```426:472:src/runtime/index.ts
export async function applyToolGate(
  handlers: OpsRuntimeHandlers,
  toolName: string,
  args: Record<string, unknown>,
  origin: ToolCallOrigin = MAIN_ORIGIN
): Promise<ToolGateResult> {
  if (!handlers.beforeToolCall) return { kind: 'allow' };
  const verdict = await handlers.beforeToolCall({ toolName, args, origin });
  // ... block → throw（pi isError）；needSessionApproval → await handlers.requestApproval
  //     approved → 继续同一调用；rejected → 结构化拒绝 JSON（绝不抛错让模型盲试）
```

- `ApprovalService.resolveSessionApproval` 装配 9 要素简报（有 playbook run 走 orchestrator，无 run 走 host 本地简报——审批**不再依赖 playbook**），同会话同命令集共享同一决议 promise；批准即签发 HMAC 令牌（绑定 sessionId，只存 host 内存），后续同命令集重试经 `deriveCommandSetHash` 一致性校验（篡改 → `OPS_APPROVAL_STALE`）。`approvalGate.buildApprovalCommandSet` 与 policy 侧推导对齐并有 `approval-loop.test.ts` 双向锁定。**双闸成立**：① 会话策略/简报 + ③ 插件确认弹窗互不替代；investigator read 硬顶、executor 无 briefId 必拒（`buildTaskSpec` + policy 规则 7 双层拦截）。
- 与 Claude Code 的 ask 挂起、OpenCode 的 permission ask 同构，优于 docs/11 时代的「拒绝-重试」（模型不再需要凭提示语重试）。旧的非阻塞兜底仍保留（`applyApproval` 发现无 waiter 且 approved → followUp 提示模型重试，approvalService.ts:352），属合理的兼容残留。
- **缺口 A（悬挂无 TTL）**：`approvalWaiters` 永不超时。工具卡在审批等待时该 turn 不结束、`agent_end` 不来 → 席位永久 busy、`pendingRebuild` 永不释放；两席都挂审批时 `SessionPoolExhaustedError`，整个产品只剩「停止」一条路。
- **缺口 B（软停不解挂）**：`chatService.abort('stop')` 会 `rejectWaitersFor`，但 `abort('cancel')`（软停，webview 已暴露）只等 in-flight 工具结束——被审批阻塞的工具调用属于 in-flight，软停将**永不完成**且 UI 无解释。

### 1.3 FallbackRuntime：仍在，语义已修正，定位正确

`createOpsRuntime` 的 catch-all fallback 仍存在（host 侧 `chatService.createRuntime` 还有第二层 catch），这是对的——VS Code 扩展激活不可失败。P0-A 后文案已分流：`looksLikeMissingModelConfig` 判定「缺 key/无可用模型」→ `FALLBACK_NOTICE` + notice 事件带「打开设置」action；其它创建期失败 → 「模型运行时初始化失败：<reason>」。bundle 修复后 fallback 不再掩盖 CJS 崩溃（docs/11 §2.1 的「测试绿、产物死」根因已消除）。残留小债：`MISSING_MODEL_CONFIG_PATTERN` 把 401/unauthorized 也归为「未配置」——运行期 key 被吊销后重建 runtime 会提示「未配置模型」而非「凭证失效」，误导排障方向。

### 1.4 CJS bundle：**已验证真修复**（7f02f86 的声明成立）

三重实证（本次评审实际执行）：

1. `test/bundle-smoke.test.ts` 2/2 绿：用 `esbuild.extension.mjs` 导出的**同一份** `sharedBundleOptions`（bundle+cjs+external:vscode+importMetaUrlShim）把 harness 打成单文件 CJS 并 spawn 执行，断言流式正文来自 mock SSE chunks、`Authorization === Bearer <注入 key>`（而非 models.json 占位符）；第一个用例还断言 shim **真的混入**共享配置（防「导出了但没用」的漂移）。
2. 实际构建 `dist/extension.js`（minify）：banner `const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;` 在产物首行；`__importMetaUrl` 替换 8 处；残余 4 处 `import.meta` 字样全部是内联 acorn/babel 的**错误提示字符串**，不是可执行代码。
3. 全量 487/487 + tsc 0 错误。

残余保真度缺口（不影响「已修复」结论，但要防复发面变化）：
- harness 打包 `minify:false`，产物 `minify:true`——minify 破坏 pi 的类名/函数名依赖这一类故障不被覆盖（一行改动即可对齐）；
- harness 入口是 `src/runtime/index.ts` 而非 `src/extension.ts`——激活路径（vscode API 接线、skills 目录随 VSIX 布局）没有 E2E，需 `@vscode/test-electron` 才能补齐。

### 1.5 runtimePool 两会话（7606910）：语义完整、测试扎实

`SessionRuntimePool`：maxParallel 硬顶 2、LRU 只驱逐**空闲**席（忙席不可驱逐 → `SessionPoolExhaustedError` 上屏不排队）、并发 `ensure` 去重、创建期被驱逐的 runtime 到货即释放不入池、abort/rebuild 按 sessionId 定向、运行中 rebuild 挂起等 idle（P1-15）后带 `resumeSessionFile` 续接重建（P0-C 不失忆，`SessionManager.open` 失败 → create → inMemory 三级降级）。审批/playbook/read 免审名单全部按 sessionId 分席，HMAC 令牌绑定 sessionId 不跨席（`briefSessions` 反查 + 驱逐时 `clearSession` 全清）。`runtime-pool.test.ts` 覆盖以上全部语义。边界与 §1.2 同根：rebuild 依赖 idle 事件，审批悬挂时 pendingRebuild 永不释放。

### 1.6 错误分类：工具级成熟，prompt 级偏薄

- **工具级（好）**：policy block → throw（pi isError）；审批拒绝/未接线 → 结构化 JSON（`OPS_APPROVAL_REJECTED` / `OPS_APPROVAL_REQUIRED`，指示模型「勿原样重试」）；`USER_CANCELLED` → throw 走 isError（UI 不显示成功）；hub invoke 超时/传输错误带 `attemptCount`；结果 >8KB 截断 + 全文落盘 `tool-results/<toolCallId>.json` 并在提示里给路径。
- **prompt 级（薄）**：溢出正则 → compact 一次 + retry 一次 → 「开新会话」（§1.8）；**其余一切错误**（429、5xx、网络抖动、凭证吊销）统一 `text_delta「模型调用失败：…」+ idle`——无退避重试、无结构化 notice/action、错误文本未过脱敏（`sanitizeErrorText` 在 modelsProbe 里现成，runtime 没用）。对照 Codex ToolOrchestrator 的 approval+sandbox+retry 三合一与 OpenCode provider 层重试，我们的自动恢复只覆盖「上下文溢出」一种。
- **小漂移**：`OPS_APPROVAL_REJECTED` 是散字符串，不在 `src/protocol` 的 `OPS_ERROR` 常量表里。

### 1.7 Abort：两档语义 + 级联完整

`stop` = rejectWaiters（host 层）+ 子代理 `abortAll` + `session.abort()`；`cancel` = 软停（`inflightToolCalls` 计数，等 `tool_execution_end` 全清再 hardAbort，保在途证据）。子代理侧：manager 的 AbortController → 子 `session.abort()` → hub.invoke 的 signal 逐层级联；`maxWallMs` 定时器超时中止标 failed、`maxToolCalls` 超预算中止标 degraded（`subagents.ts` settle 状态机 + 终态守卫防竞态，测试覆盖）。唯一缺口即 §1.2 缺口 B。

### 1.8 Compaction：三层齐备，符合 docs/03 §5

L1 工具结果 8KB 截断+落盘（`executeBusinessTool`）；L2 pi 自动 compaction（`compaction_end` 事件转 UI 系统条目，manual 由发起方发避免重复）；L3 prompt 溢出 → `recoverFromPromptError` 严格「compact 一次 + retry 一次」→ 仍败抛中文「开新会话」（测试锁定绝不无限重试；onCompaction 在 retry 前回调，重试失败用户也看得到「已压缩」）。证据便签存 orchestrator/store，不进 LLM 上下文、不受 compact 影响。对照 Claude Code 4 阶段：我们没有 pre/post-compact hook，也没有「哪些证据被摘要」的呈现——够用，但可加厚（P2）。

### 1.9 其它诊断点

- **目录热更新**：下线/复活工具 `setActiveToolsByName` 即时生效；**全新**业务工具因 pi 0.84.3 无追加 customTools 的公开 API，走「排队到 idle → host 重建 + resume」——没有 fork、没有 monkey-patch，是绕开 SDK 限制的正解（应向上游提 addTool API）。
- **roleModels 是哑接线**：`chatService.createRuntime` 读 settings 并塞进 options，但 `CreateOpsRuntimeOptions` 没有该字段、runtime 忽略——docs/03 §3 的 per-role 模型路由（investigator 降级省钱）实际未实现，子代理恒用主模型。
- **分层红线**：实测 `src/runtime` / `orchestrator` / `hub-host` / `policy` / `core` / `mcp-client` **零 vscode import**（grep 验证）。
- **测试保真度**：runtime.test.ts（1909 行）大多测纯函数 + 假 hub，真 pi 只在 bundle-smoke 以 E2E 跑通（mock SSE），加上 pin-guard/exports-smoke，两端夹住了「SDK 真活着」与「API 面没漂」。缺的是 §1.4 所列 minify 与激活路径。

---

## 2. 进程模型

### 2.1 留在 in-process：对 Bridge 架构仍是正解，不抄 kilo serve

OpenCode/Kilo 抽 headless server 是因为**多客户端**（TUI/桌面/IDE/CI 共用一个 core）；Codex 抽 Rust core 是因为**跨宿主 + OS 沙箱**必须独立进程。我们两个前提都不存在：唯一客户端是 VS Code 侧边栏；核心卖点是 Bridge 热注册（`fs.watch` → 下一轮 LLM 可见，200ms 级），Hub 与 loop 同进程是该延迟的前提；工具执行本来就在插件进程（loopback HTTP），崩溃面已经隔离。ADR-001 的判断在当前代码下依然成立——**现在抽 serve 进程是纯开销**（多一层 transport、审批闭环要跨进程、SecretStorage 注入要过 IPC）。

### 2.2 OpsCore facade：已落地，残余债在类型双轨

`src/core/index.ts` 把 runtime/orchestrator/policy/hub-host/mcp-client 收成零 vscode 的单一 API 面，动态 import 装载器与四套 fallback 已删（P1-8 完成）；将来第二客户端出现时给 facade 套 HTTP/SSE 壳即可。残余债：

1. **类型双轨**：`src/host/hostTypes.ts` 手工维护 `RuntimeLike`/`RuntimeHandlers`/`RuntimeEventLike` 等「最小面」，与 `src/core` 重导出的真类型平行存在，且大量「D-runtime 落地前…」「runtime 后续开始发送…」注释描述的能力（sessionFile、usage、requestApproval、goal/visibleTools）**均已落地**——过期注释 + 可选标注让形状漂移只会在运行期暴露。
2. **runtime/index.ts 仍 1526 行**：约 150 行 re-export + 200 行闸门/截断 + 90 行 fallback + 430 行工厂 + 事件桥/子会话混在一文件；不是功能问题，是演进摩擦（每次改闸门都要在 1500 行里定位）。

---

## 3. 竞品对照

### 3.1 沙箱：不做 OS 沙箱是**架构正确**，但命令分类器有两套平行实现

Codex 的 seatbelt/bubblewrap、Claude Code 的沙箱 bash 保护的是「本地任意命令执行」。我们默认**零本地执行面**：无 bash/write/edit，唯一文件面是两个 64KB 只读白名单工具（`resolveUnderRoot` 拒绝 `..`/绝对路径/反斜杠，`workspaceShellEnabled` 默认关且开了也只读）；exec 发生在**远端**，由插件确认弹窗 + 服务器信任分级 + `@at-series/command-policy` 权威判定兜底。OS 沙箱在此架构下保护错了对象——**正确不做**。

真正的问题在 Agent 侧预判：`src/policy/index.ts` 的 `inferEffectiveRisk` 手写了一套只读命令分类表（READ_ONLY_LEADING_COMMANDS + systemctl/journalctl/ip/docker/kubectl/iptables/sed/sysctl 专项规则，保守方向正确），而 docs/01 §5.1 与 docs/07 §5 承诺 Agent 侧用 **`@at-series/command-policy`** 做预判——package.json 里**没有**这个依赖。两套分类器必然漂移：Agent 放行面与 Terminal 插件权威判定不一致时，要么 investigator 只读巡检被误拦，要么审批简报缺 allow/review/deny 证据坐标。

### 3.2 Hooks：不抄 29 事件，出站通知面可小步加厚

Claude Code hooks 的本质是「用户 shell 代码挂进 loop」——在 ops 产品里等于新增一个**未审计执行面**，与三道闸叙事冲突，不该抄。我们的等价物：policy 纯函数闸（进程内、可测）+ 审批 IM webhook（approvalNotify 脱敏推送）。值得借鉴的只有事件面的**出站**半边：turn 结束、evidence-note 产出、compaction 发生等事件推 webhook（值班群联动），不提供入站改写。

### 3.3 流式：合批 + 会话定向广播够用，id 拆分应上移

pi 事件 → `OpsRuntimeEvent` → `RuntimeEventRouter`（按 sessionId 写 store + 只对活动会话广播，后台席位靠 hydrate 回放）→ `StreamBatcher` 40ms 合批 postMessage。webview 常驻同进程，不需要 OpenCode 的 SSE 重连语义；usage/cost/context 水位已随 `message_end` 上报。一处结构瑕疵：runtime 对同一 assistant 消息的 thinking/text 共用一个 id，靠 host 侧 `:thinking`/`:assistant` 后缀拆分（P0-id 修在消费端）——产生端就该拆，host 保留幂等防御即可。

### 3.4 Provider 层：pi ModelRuntime + 本地 models.json 是对的定位

对照 OpenCode 的 models.dev 云目录 / Kilo 的网关目录：我们的目标用户是**内网网关**（docs/03 §3），本地 `models.json`（compat/thinkingFormat）+ HTTP `/models` 拉取（`modelsProbe.fetchModelCatalog`）+ 1-token 连通性探测（`probeOpenAiCompatible` 与 runtime `probeModel` 双路径，错误分类中文化且脱敏）+ per-provider SecretStorage 键（旧键迁移）+ OAuth 走 pi `ModelRuntime.login`（auth.json 0600，token 不落日志/webview）——docs/11 时代的 P0-B/P1-1 均已闭环。缺口就是 §1.6 的 prompt 期 transient 重试与 §1.9 的 roleModels 哑接线。

---

## 4. 整改建议

### P0（值班中会真实伤人，先做）

| # | 问题 | 落点 | 验收 |
|---|------|------|------|
| P0-1 | 审批等待悬挂：waiter 无 TTL；软停不解挂（§1.2 缺口 A/B） | `src/host/services/approvalService.ts`（`resolveSessionApproval` 的 waiter 加可配超时，默认如 10–15min，到期按 rejected 决议并在拒绝 JSON 里注明「审批超时」）；`src/host/services/chatService.ts`（`abort('cancel')` 也 `rejectWaitersFor`，或至少 UI 提示「有工具在等审批，软停将等待」） | 挂起简报无人处理 N 分钟后该 turn 自行结束、席位释放；软停在审批挂起时可预期完成 |
| P0-2 | prompt 期错误裸文本：无脱敏、无 action、transient 无重试（§1.6） | `src/runtime/index.ts` prompt catch：错误过 `sanitizeErrorText`（从 `modelsProbe.ts` 提到共享模块）；401/403 → notice + 「打开设置」action；429/5xx/网络类做**一次**退避重试（复用溢出路径的「严格一次」纪律），仍败发 notice 带「重试」action | 凭证片段永不上屏；吊销 key 引导到设置而非「模型调用失败」裸串 |

### P1（架构债与保真度，本轮内做完）

| # | 问题 | 落点 |
|---|------|------|
| P1-1 | 命令分类双轨：policy 手写只读表 vs 插件侧 `@at-series/command-policy`（§3.1） | package.json 加 `@at-series/command-policy ^0.1.1`；`src/policy/index.ts` 的 `inferEffectiveRisk` 优先调用库分析器（allow→read、review/deny→维持申报风险），手写表降为库不可用时的兜底；`approvalGate.buildApprovalElements` 附 allow/review/deny 预判结果进简报（docs/07 §5 的承诺） |
| P1-2 | bundle-smoke 与产物 minify 不一致；激活路径无 E2E（§1.4） | `test/bundle-smoke.test.ts` harness 改 `minify:true` 对齐产物（一行）；新增 VSIX 布局断言（skills/ 随包、package.json main 指向 dist）；排期 `@vscode/test-electron` 激活冒烟 |
| P1-3 | `src/runtime/index.ts` 1526 行（§2.2） | 拆 `session-factory.ts`（createPiRuntime + 子会话 env）、`tool-gate.ts`（applyToolGate/executeBusinessTool/truncate）、`fallback.ts`、`session-events.ts`（subscribeSessionEvents + toUsageView）；index 只留装配与 re-export，每件 <400 行；纯搬移不改行为，现有 487 测试即回归网 |
| P1-4 | roleModels 哑接线（§1.9） | 二选一：`CreateOpsRuntimeOptions.roleModels` 真落地（`runSubagentSession` 按 role `resolveModel` + `injectApiKey`）；或删掉 `chatService`/`normalizeRoleModels` 的死代码与设置项，别让配置界面撒谎 |
| P1-5 | 错误码散串（§1.6） | `OPS_APPROVAL_REJECTED` 收进 `src/protocol` 的 `OPS_ERROR`；runtime 侧引用常量 |
| P1-6 | thinking/text 同 id（§3.3） | `subscribeSessionEvents` 在产生端拆 `:assistant`/`:thinking` 后缀；`runtimeEvents.ts` 的后缀拼接已幂等，保留为防御 |

### P2（加厚与清理）

| # | 内容 | 落点 |
|---|------|------|
| P2-1 | hostTypes 类型双轨收敛：`RuntimeLike`/`RuntimeHandlers` 改为从 `src/core` re-export（或 Pick），删除「D-runtime 落地前」类过期注释 | `src/host/hostTypes.ts` |
| P2-2 | 出站事件通知面：turn_end / evidence-note / compaction 推 IM webhook（复用 approvalNotify 脱敏管道），替代 Claude 式本地 hooks | `src/host/services/approvalNotify.ts` 泛化 |
| P2-3 | compaction 可见性：`compaction` 事件透传 pi result 细节（保留/丢弃了什么），UI 告知「哪些证据被摘要」；评估把证据便签 pin 进 retained tail | `src/runtime/compaction.ts`、`runtimeEvents.ts` |
| P2-4 | `resolveModel` 无首选 provider 时先 `getAvailable` 后注 key 的顺序复核（占位符使 provider「看似有凭证」，当前实害面窄，host 恒传 pref）；给该分支加日志 | `src/runtime/index.ts` |
| P2-5 | 子会话构造成本：每个子代理任务 new `DefaultResourceLoader` + `reload()`，4 并行 investigator 时冷启动叠加；可按 runtime 生命周期缓存 | `src/runtime/index.ts` runSubagentSession |
| P2-6 | 401 类创建期失败被归为「未配置模型」（§1.3）：`looksLikeMissingModelConfig` 把 unauthorized/401 单列为「凭证失效」文案 | `src/runtime/index.ts` |

### 不该做（明确否决，防跑偏）

1. **OS 沙箱（seatbelt/bubblewrap/landlock）**：本地无执行面，保护对象在远端；投入换不来安全增益。若将来真开「受限工作区 shell」，按 docs/03 §2 走受限 bash + command-policy 预判 + 会话审批，而不是 OS 沙箱优先。
2. **Fork pi / 私有补丁**（比如为了「事后追加 customTools」）：rebuild + resumeSessionFile 已是无损绕法；正确动作是保持三包精确锁定（pin-guard 已守）并向上游提 addTool/replaceTool API。
3. **把 Hub 确认弹窗 / 审批 UI 拉进 runtime（agent 进程侧）**：三道闸边界是产品命门，runtime 只应看到 `approved | rejected` 二值；任何「runtime 自己弹窗/自己判定」的便利化都在瓦解 ①③ 互不替代。
4. **现在抽 kilo/opencode 式 serve 进程**：无第二客户端需求；OpsCore facade 已是套壳预留位，第二客户端立项那天再谈 transport。
5. **Claude Code 全量 29 hooks**：入站可执行 hook = 新增未审计执行面；只做 P2-2 的出站通知子集。
