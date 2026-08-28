# Round 2 · 07 竞品对照（含 Codex / Claude Code）与「其他方向」审计

> 评审对象：`main` HEAD `b099484`（P0–P2 整改后），`npm run vitest` 487/487 全绿。
> 上一轮基线：docs/11-redesign-recommendations.md 与 docs/reviews/competitive.md（HEAD `764756c`，仅对照 OpenCode / Kilo / Cline，**已过期**）。
> 本轮对照：OpenCode（V2 beta）、Kilo Code（OpenCode server 重建版）、OpenAI Codex（CLI/IDE/Cloud，v0.150.x）、Claude Code（含企业 managed settings 与 OTel）。资料为 2026-08 官网/文档实况检索；本方以仓库代码实况为准。
> 分工边界：编排 / UI / MCP / 记忆 / runtime / UX 文档由其他分项报告覆盖；本文负责**竞品矩阵**与**其余方向**（安全审计、Agent 可观测、调度、IM、多窗口多主机、评测、企业化、技能版本、可访问性、生态位）。

---

## 1. 相对 docs/11 的变化：哪些已落地、哪些仍欠

docs/11 是对 `764756c` 的诊断。逐条 spot-check 当前代码后结论：**P0 全部落地，P1 绝大部分落地，P2 落地过半**。docs/11 不应再作为待办清单使用，其残留项收敛为下表「仍开放」一节。

### 1.1 已落地（代码坐标验证过，非文档自述）

| docs/11 条目 | 证据（b099484） |
|---|---|
| P0-A CJS 产物修复 | `esbuild.extension.mjs` 的 `importMetaUrlShim`（define + banner）与共享配置；`test/bundle-smoke.test.ts` 用同一配置打 harness 断言流式 + Bearer 注入 |
| P0-B 向导 + 验证 | `src/host/modelsProbe.ts`（`GET /models` 404/405 回退 1-token 探测；401/404/429/5xx 人话；**key 绝不出现在错误文本**）；`modelsView.ts` 的 `keyMissingWarning`（无 key 禁报已保存）；Composer 未配置态拦截 + 「配置模型」CTA |
| P0-C 会话单真源 | `sessionStore.ts` 持久化 `~/.at-series/agent/ui-sessions.json`（0600、上限 50、400ms debounce），每会话记 pi JSONL `sessionFile` 供 runtime 续接；审批令牌刻意不持久化（跨重载作废，正确） |
| P0-D 审批不依赖 playbook | `src/host/approvalGate.ts` + `test/approval-loop.test.ts`；policy `role`/`riskCeiling`/`sessionReadAllowlist` 全部接线并有 `policy-gaps` 边界测试 |
| P0-E 表层三件 | `MarkdownBlock.vue`（markdown-it）、`@vscode/codicons` 全库替换 emoji、`@资产` 走 host QuickPick（证据便签 + 工作区文件）、`package.nls.zh-cn.json` |
| P1-1 多 provider | per-provider 密钥 `atOpsAgent.apiKey.<id>`、模型目录拉取、表单写 `reasoning`（读端兼容旧 `thinking`）、`thinkingFormat` 兼容 deepseek/qwen/zai |
| P1-2 工具卡折叠 | `ToolCallCard.vue` 默认折叠、单行摘要头 + aria-expanded |
| P1-4 水位/用量 | 协议 `UsageView` + `usage` evt、`usagePercent`、Composer 水位 |
| P1-5 失败重试 | `ChatTranscript.vue` `retryable` → Retry 按钮 |
| P1-6 阻塞式子代理 | `runtime/index.ts` 注释与实现：dispatch 即阻塞工具结果，`deliverToMain` 伪 user 回灌已删 |
| P1-7 Playbook 完结通道 | `ops_advance_stage` / `ops_close_playbook`（runtime playbook-tools + orchestrator + host service 全链） |
| P1-8 删死代码 | `src/host/fallback/`、`src/host/trees/`、`showModelsPanel`、`modules.ts` 均不存在 |
| P1-9 只读免审记忆 | `policy/index.ts` `sessionReadAllowlist`（仅 read 生效，write/exec 双闸不受影响）+ 配置项 |
| P1-10 值班报告导出 | `exportReport.ts`：对话/工具/证据/审批（含未决）/阶段轨迹 → Markdown；**令牌与凭证保证不出现**；`atOpsAgent.exportReport` 命令 |
| P1-13 / P1-15 | 双语 nls + webview i18n；重建推迟到该会话 idle（runtimePool 逐会话生效） |
| P2 OpsCore facade | `src/core/index.ts`：runtime+orchestrator+hub-host+policy+mcp-client 无 vscode 单面 API |
| P2 拆 HostController | `hostController.ts` 306 行 + `src/host/services/` 14 个服务件 |
| P2 并行会话 ≤2 | `services/runtimePool.ts`（硬顶 2、忙/闲逐会话、驱逐最久空闲） |
| P2 软停/硬停 | Composer `abortRun('cancel'/'stop')` 两档 |
| P2 per-角色模型 | `modelsView.ts` `ROLE_MODEL_ROLES`（investigator/executor/writer/verifier → provider+model） |
| P2 walkthrough | `contributes.walkthroughs` 三步（配模型→装插件→跑 playbook）；`Ctrl+Esc` / `Shift+Esc` keybindings |
| P2 定时巡检 | `activate.ts`：`inspection.intervalMinutes` 到点弹提醒、**人点才启动**，绝不静默执行 |
| P2 IM 摘要 | `services/approvalNotify.ts`：待审批 POST 脱敏 JSON（无令牌/无凭证/无完整命令集）到 `im.webhookUrl`，提示回 IDE 批准 |

**docs/11 之外的增量**（docs/12–14，对手实录驱动，属本轮新差异化）：先认客户端再动手（L-env 现场层注入、`pb.inspection` 首轮 select 锁 `at.terminal` 并有 eval 回归）、`inferEffectiveRisk` 只读命令推断（约 40 个只读命令 + systemctl/journalctl/docker/kubectl/iptables/ip 子命令级判定，重定向/`$()`/反引号一律保守）、子代理 Inspector、thinking/assistant 分 id、close 前强制中文可见结论（host 兜底合成巡检报告）。

### 1.2 仍开放（docs/11 承诺未闭环 + 抽查存疑）

| 项 | 现状 | 严重度 |
|---|---|---|
| `@at-series/command-policy` 预判 | **未接**。docs/01 §依赖表写 `^0.1.1`、docs/07 §5 承诺简报展示 allow/review/deny，但 `package.json` 无此依赖；`src/policy` 手写只读推断是**平行实现**，与 Terminal Bridge 权威分析器必然漂移 | 高（见 §3.1） |
| 8 条 playbook 端到端 evals | `test/playbook-eval.test.ts` 仅覆盖 `pb.inspection` 状态机（无 LLM）；其余 7 条无生命周期 eval，无金样本事故 | 高（见 §3.6） |
| compaction 时间线事件 | `runtime/compaction.ts` 存在，但「哪些证据被摘要」的用户可见系统事件未验证到；需复查 | 中 |
| `@terminal` 引用 | `@资产` 只覆盖证据便签 + 工作区文件；docs/11 P1-11 的 @terminal（Kilo 截断规则）未做 | 低 |
| Board「Ops 版 Agent Manager」 | `boardView.ts` 存在，过滤/日期分组/定位回会话的打磨深度未验证；归 UI 分项复查 | 低 |
| 配置导出/导入团队下发 | 未见实现（`${secret:}` 占位符已天然支持脱敏导出，缺的只是导出面） | 中（并入 §3.7 企业化） |

---

## 2. 四家竞品 × 我们：2026-08 矩阵

### 2.0 对手在这一年变了什么（旧矩阵为何作废）

- **OpenCode V2（beta）**：client/server 架构定型（Go TUI + Bun HTTP server，终端/桌面/IDE 同一引擎）；权限从 per-tool map 升级为**有序规则数组**（action×resource×effect，action 覆盖 shell/edit/subagent/skill/webfetch 等 13 类）；agent 级权限独立不继承父代理；桌面端出 tabs；Zen 托管模型目录；Copilot/ChatGPT 账号直登。
- **Kilo Code**：VS Code 扩展**整个重建在 OpenCode server 上**，CLI/扩展/Cloud Agent 三面同核；Agent Manager（worktree 并行 + diff 评审 + 每会话终端 + 从 PR/分支导入会话）成为主打；新增 **Sandboxed Auto Mode**（OS 级约束下的自动执行）；Cloud Agents 支持手机双向接管本地会话（消息/审批请求路由到任意在线端）。
- **Codex**：五个 surface（CLI/桌面/IDE/云任务/浏览器扩展）一脑；**内核级沙箱**（macOS Seatbelt、Linux Landlock+seccomp）+ 审批策略（always/on-request/never）+ 沙箱模式（workspace-read/write）三层正交；`codex exec` headless 进 CI；`/goal` 长时目标模式 GA；企业侧 admin 强制 `requirements.toml`；Slack/Linear/GitHub 集成与 Codex Security（漏洞扫描）。
- **Claude Code**：六原语（CLAUDE.md/skills/subagents/plugins/hooks/MCP）+ marketplace 分发；`PreToolUse` hook 是显式安全检查点；沙箱 Bash 带**网络域名白名单**；**managed settings**（admin console / MDM 下发，`allowManagedPermissionRulesOnly`、`strictPluginOnlyCustomization` 等锁死用户侧放宽）；**OTel 全量导出**（metrics/events/traces，`tool_decision` 等事件即 SIEM 审计流）+ Compliance API。

一句话：四家的战场已经从「会话体验」转移到 **可移植内核、OS 沙箱、企业管控、Agent 自身可观测** 四个纵深。我们上一轮补齐的恰是会话体验层——及格线到手，但对手的第二曲线已经开出。

### 2.1 通用会话 UX 矩阵

图例：✅ 有 ｜ 🟡 部分 ｜ ❌ 无。at-opsAgent 列以 `b099484` 代码实况为准。

| 能力 | OpenCode V2 | Kilo | Codex | Claude Code | at-opsAgent |
|---|---|---|---|---|---|
| provider 向导 + 连通性测试 | ✅ /connect + Zen + 账号直登 | ✅ 登录/BYOK/自定义 | ✅ ChatGPT 登录或 API key | ✅ 订阅登录 / Bedrock 等 | ✅ 预设 + 保存并测试（探测降级链 + 人话错误） |
| 模型目录 | ✅ Models.dev 75+ | ✅ 500+ 网关目录 | 🟡 官方 GPT-5.x 谱系为主 | 🟡 Anthropic 谱系为主 | ✅ `GET /v1/models` 拉取（内网网关向） |
| 密钥保管 | 🟡 本地 auth.json | ✅ SecretStorage + 云账号 | ✅ 本地 config + 登录态 | ✅ 登录态/密钥 helper | ✅ SecretStorage + `${secret:}` 占位符 + 0600，**探测错误保证不含 key** |
| 会话持久化/续接 | ✅ 一等资源 + share link | ✅ 本地+云 + 跨端续接 | ✅ resume + 云任务 | ✅ append 式会话存储 + rewind | ✅ ui-sessions.json + pi JSONL 续接（重载不失忆） |
| 流式/中止/重试 | ✅ | ✅ Cancel/Stop 两档 | ✅ | ✅ | ✅ 40ms 合批 + 软停/硬停 + Retry |
| 工具卡 | ✅ TUI | ✅ 折叠 + diff | ✅ diff/日志 | ✅ | ✅ 默认折叠 + 五态 + 耗时 |
| 审批交互 | ✅ 有序权限规则数组 | ✅ Permission Dock once/always/deny | ✅ 三档审批策略×沙箱模式 | ✅ 7 种权限模式 + PreToolUse hook | ✅ 工具内挂起 + 9 要素简报 + 只读会话免审名单 |
| token/成本/水位 | ✅ | ✅ 状态栏成本 | ✅ | ✅ /cost + OTel | 🟡 水位 + usage 有；**成本换算无**（内网网关多无单价，可接受） |
| @ 引用 | ✅ @File#L | ✅ @file/@terminal | ✅ 选区/打开文件 | ✅ @file 等 | 🟡 @证据便签 + @工作区文件；无 @terminal |
| 子代理 | ✅ agents/subagents 独立权限 | ✅ 并行 subagent + 查看器 | ✅ subagents + /goal | ✅ subagents 独立上下文 + 编排 | ✅ 四角色 + 阻塞式 dispatch + Inspector + per-角色模型 |
| 多会话并行 | ✅ 多 session | ✅ Agent Manager 多 worktree | ✅ 云任务并行 | 🟡 单 loop 为主（SDK 可编排） | ✅ 席位 ≤2（查库+查主机；刻意不做 worktree） |
| headless / CI | ✅ server API | ✅ CLI 同核 | ✅ codex exec | ✅ claude -p | ❌（刻意：值班场景以 IDE 在场为前提；见 §4「不做」） |
| onboarding | ✅ /init | ✅ 迁移向导 | ✅ | ✅ | ✅ walkthrough 三步 + 空态 CTA + 状态栏未配置警告 |
| i18n 中文 | ❌ | 🟡 | ❌ | ❌ | ✅ 中文一等（nls + webview 双表）——**对中国企业 IDE 是硬差异** |

结论：docs/reviews/competitive.md 第 2 节里我们的 6 个 ❌ 已清零，通用层不再是漏水桶。剩余 🟡（成本换算、@terminal）不值得优先投入。

### 2.2 Ops 纵深矩阵（我们的护城河 vs 四家的最近替代物）

| Ops 能力 | OpenCode V2 | Kilo | Codex | Claude Code | at-opsAgent |
|---|---|---|---|---|---|
| 事故链路状态机（阶段/结局/校验点） | ❌ agents 是 persona | 🟡 workflows=提示词模板 | 🟡 /goal 是目标循环非状态机 | 🟡 skills+hooks 可拼但无状态机 | ✅ 8 条 playbook + 迁移表校验 + `ops_advance/close` + eval 回归 |
| 变更审批的**语义**强度 | 🟡 拦不拦（规则数组） | 🟡 拦不拦 + 记规则 | 🟡 拦不拦 + 沙箱兜底 | 🟡 拦不拦 + hook 可自定义 | ✅ 9 要素简报（回滚方案/影响面）+ HMAC 令牌 + **命令集哈希绑定**（改一字令牌作废）+ 插件宿主二次确认 |
| 执行隔离哲学 | 权限规则 | OS 沙箱（本机） | **内核沙箱（本机）** | 沙箱 Bash + 域名白名单（本机） | 语义闸 + 桥边界。**生产远端无法沙箱**——对 ops 而言 OS 沙箱保护的是笔记本，不是生产；我们的等价物是审批+留痕（见 §4） |
| 证据时间线/值班报告 | ❌ share link ≠ 证据链 | ❌ | 🟡 云任务出日志/diff | 🟡 transcript 导出 | ✅ 证据卡 + 时间线 + Markdown 值班报告（审批含未决、阶段轨迹） |
| 能力接入零配置 | ❌ 手配 MCP | ❌ 手配 MCP | ❌ 手配 MCP | 🟡 plugin 打包 MCP 但仍需安装配置 | ✅ Bridge v1 装插件即热注册 + AT/MCP 去重 |
| 调查/执行角色硬隔离 | 🟡 agent 权限独立但用户可切 | 🟡 | 🟡 workspace-read 模式 | 🟡 permission mode 可切 | ✅ Investigator read 硬顶（结构性，非模式切换）+ Writer 无业务工具面 |
| 只读命令语义推断 | ❌ shell=整串匹配 | 🟡 命令 glob | 🟡 沙箱粒度非命令语义 | 🟡 hook 可自写 | ✅ `inferEffectiveRisk` 子命令级白名单（systemctl status 放行、`sed -i` 拦截），保守缺省 |
| 不可信工具输出防护 | ❌ | ❌ | ❌ | ❌ | ✅ UntrustedQuotes 产品化 + C7 |
| GuidedManual（AI 不碰生产写面） | ❌ | ❌ | ❌ | ❌ | ✅ 独一份，安全团队可讲述 |
| IM 值班通知（审批不出 IDE） | ❌ | 🟡 双向远程接管（**批准可出端**，反例） | 🟡 Slack 发起云任务（同上） | ❌ | ✅ 单向脱敏摘要 + 回 IDE 批准（方向正确，成熟度低，见 §3.4） |
| 定时巡检 | ❌ | 🟡 automations（云） | 🟡 app automations | 🟡 CI 定时 headless | ✅ 到点提醒 + 人点启动（无人值守刻意不做） |
| **Agent 自身可观测（OTel/审计事件）** | ❌ | 🟡 开源可自查 | 🟡 云任务留日志 | ✅ **metrics/events/traces + SIEM + Compliance API** | ❌ **唯一被对手反超的安全相邻项**（见 §3.2） |
| **企业管控（admin 锁策略）** | 🟡 enterprise 字段 | 🟡 团队云管理 | ✅ requirements.toml 强制 | ✅ managed settings（MDM/控制台，用户不可放宽） | ❌ `sessionRequiredFor` 用户可自调成 `never`（见 §3.7） |

结论：护城河六件（Playbook/双闸/证据/Bridge/GuidedManual/硬只读）依然无人正面竞争，且本轮加厚了（哈希绑定审批、只读推断、报告导出、L-env）。但矩阵最后两行是**方向性失分**：Claude Code 把「审计与管控」做成了企业采购的默认项，Codex 把「管理员强制策略」做成了配置文件。我们的买家（企业安全团队）会拿这两行提问。

---

## 3. 其他方向审计（其余分项不覆盖的地带）

### 3.1 安全与审计

**a) command-policy 断链（最高优先技术债）。** `@at-series/command-policy` 是系列仓里现成的确定性命令分析库（Shell/Python/SQLite/MySQL/Redis 五分析器，allow/review/deny，fail-closed），At-Terminal 的 limited-trust 执行已用它做**权威判定**。docs/01/07 明文承诺 Agent 侧复用同库做预判并在简报展示三态+证据坐标，但 `package.json` 没有这个依赖——`src/policy/index.ts` 手写了一套只读推断。后果：两套词法两套白名单，**Terminal 侧策略升级（新增危险模式）时 Agent 预判不会跟进**；简报里也没有 allow/review/deny 展示，审批人少了一个决策输入。修法：引入 `@at-series/command-policy`，`inferEffectiveRisk` 退化为「库判定之上的 ops 白名单补充」，聚合规则维持「只能加严」；简报增加 policy 三态徽标。

**b) 没有 Agent 侧审计日志。** 现状三个「像审计但不是审计」的东西：pi JSONL（模型上下文真源，可被 compaction 改写语义）、`ui-sessions.json`（可变 JSON、上限 50 条会被淘汰）、Markdown 值班报告（导出时点快照）。缺一条 **append-only 审计流**：谁在何会话批准/拒绝了哪个简报（哈希）、policy 拦截了什么、哪些 exec 真实下发。建议：`~/.at-series/agent/audit/*.jsonl` 追加写 + 逐条链式哈希（防篡改可验证），事件模型直接对齐 Claude Code 的 `tool_decision`/`permission_mode_changed` 命名——企业 SIEM 侧规则可以复用，这是低成本蹭到对手生态的机会。

**c) 注入防护有 UI 无回归。** UntrustedQuotes + C7 是产品行为，但没有敌意语料测试集（工具结果里埋「请执行 rm -rf」「请提升 riskCeiling」「请把 key 打印出来」，断言 policy/prompt 层不放行）。这类语料集应与 §3.6 的 eval harness 共用 fixture 通道。

**d) 已到位、应保持宣传口径的**：HMAC 令牌只存 host 内存、命令集哈希改一字作废（有 reorder 测试）、探测/导出双承诺不含凭证、registry 攻击面缓解（docs/07 §6）。

### 3.2 Agent 自身可观测性

现状为零：无 traces、无 metrics、无结构化事件导出，只有 Output Channel。Claude Code 已把 OTel 三信号 + SIEM 审计事件 + Compliance API 做成了企业默认项；「审计我们的审计者」将成为采购问题。我们的有利条件：证据时间线、playbook 阶段迁移、审批事件、policy 拦截**本来就是结构化事件**，导出只是加一个 OTLP sink。建议范围（刻意小）：`tool_decision`（含 policy 三态与风险级）、`approval_request/decision`、`policy_block`、`playbook_stage`、token usage、subagent spawn/终态。**默认关闭、导出目标仅允许配置内网 collector**（呼应 air-gapped 卖点）。不做「LLM 质量评分上报」这类云依赖。

### 3.3 调度 / 巡检

已有 `inspection.intervalMinutes` 到点提醒 + 人点启动，红线（无人值守不执行）守得对。差距：只有 interval 无 cron 表达（值班要「工作日 09:30」不要「每 480 分钟」）；巡检**历史**无处沉淀——上次巡检报告、与上次的差异（昨天磁盘 71% 今天 83%）是巡检的核心价值，目前每次从零。建议：巡检产物落 `~/.at-series/agent/inspections/`，启动新巡检时把上次摘要注入 L-env；提醒支持 cron 语法。仍然不做无人值守执行——但可以做「无人值守**只读**采集 + 人在场时出结论」的中间态实验，前提是 §3.1b 审计流先就位。

### 3.4 IM 通知

已有的 webhook POST 是正确骨架（脱敏、无令牌、提示回 IDE）。三个缺口：① 国产 IM 不吃裸 JSON——钉钉要加签（timestamp+sign）、飞书/企微要各自卡片 schema，需要 per-provider 适配器（一个文件一个厂，约百行/厂）；② 没有深链——消息里应带 `vscode://at-series.at-ops-agent/approval?brief=<id>`（URI handler 聚焦对应会话与简报），把「回 IDE」从一句话变成一次点击；③ 决策结果不回推（已批准/已拒绝的 followup 消息，避免群里悬空）。**批准动作永不出 IDE** 维持不变：Kilo 的手机双向接管和 Codex 的 Slack 发起任务恰是我们的反面教材——凭据与决策必须留在插件宿主所在机器，这是可讲给安全团队的立场，不是功能欠账。

### 3.5 多窗口 / 多主机

多主机在会话内已落地（HostSessionChip、`dcf63a5` 连接主机在-session 巡检、runtimePool 双席「查库+查主机」）。真正没人管的是**多窗口**：每个 VS Code 窗口一个扩展宿主，意味着两个窗口 = 两套巡检定时器（重复弹提醒）、两路 IM webhook（重复打扰）、同一 `~/.at-series` 下并发写 `ui-sessions.json`（last-write-wins 可丢会话列表项）。建议：agentDir 加轻量文件锁/心跳选主，巡检定时器与 IM 推送只在主窗口生效；`ui-sessions.json` 写入带版本比对。Remote-SSH 语义（registry 在远端、loop 在远端）docs/07 §7 已定且正确，不动。

### 3.6 评测机制 / 金样本事故

现状：`playbook-eval.test.ts` 只静态跑 `pb.inspection` 状态机（但已含「首轮 select 必须精确 = at.terminal」这类实录回归，方向对）；`pin-guard` 守 pi 版本；无 LLM-in-loop。风险：L0–L4 提示词、只读白名单、playbook yaml 的任何改动，都没有「8 条链路还能不能把事故走完」的回归门。docs/12–14 三轮返工全部源于**实录才暴露**的行为问题——这正是缺 eval harness 的代价的直接证据。建议分两层：
- **L1 无模型（进 CI）**：8 条 playbook 全部走 orchestrator 生命周期 + fixture 桥校验（把现有 pb.inspection 模板复制 7 份的工作量）；敌意注入语料过 policy/prompt 断言（§3.1c）。
- **L2 有模型（人工触发/夜间）**：金样本事故库——每条 playbook 1–2 个脚本化故障场景（fixture Bridge 返回预置的指标/日志/进程快照），跑真实模型，按 rubric 打分：是否先认客户端、是否只读取证、是否出简报再动手、结论三态是否诚实、报告是否含未检查项。这同时是「升 pi / 换模型 / 改提示词」的守门员，也是将来对客户讲「我们的 agent 行为经过 N 个事故样本回归」的销售证据。

### 3.7 企业化：SSO、气隙、审计导出、策略管控

- **策略管控是最大缺口**：`atOpsAgent.approval.sessionRequiredFor` 用户可自调 `never`——双闸的第①道闸在企业视角是「员工可自行拆除」。Claude Code 的 `allowManagedPermissionRulesOnly` 和 Codex 的 `requirements.toml` 都解决了这个问题。修法成本低：读一个 admin 下发文件（`/etc/at-series/managed.json` 或 VS Code 机器级设置），作为**策略下限**（floor）——用户配置只能比它更严；锁 `sessionRequiredFor`、`plugins.autoEnableNew`、`sessionReadAllowlist` 上限、IM webhook 域名。
- **气隙其实是我们的强项但没被产品化**：零遥测、模型走内网 OpenAI 兼容网关、models.json/skills 全本地、无 marketplace 依赖、vsix 离线安装。应写成一页「air-gapped 部署清单」（含验证步骤），这在信创/军工/金融场景是 Codex/Claude Code（登录态绑云）结构性做不到的。
- **SSO**：我们没有自己的账号体系（正确），SSO 的真实需求是「内网网关鉴权」——支持网关侧 OIDC token 注入（apiKeyHelper 式的可执行钩子要慎重，air-gapped 下建议只支持静态 header 模板 + SecretStorage）。
- **审计导出**：Markdown 报告是给人看的；给合规看的是 §3.1b 的 JSONL 审计流 + 一条「按时间窗导出全部会话审计包（脱敏）」命令。

### 3.8 技能版本 vs vendor/super-ops

skills 随扩展打包（`skills/ops-agent-core` + 8 组 playbook），playbook.yaml 有 `version` 且 orchestrator 拒载未知版本——底子有。缺：① skill/playbook 无独立于扩展发版的更新通道，事故话术要改就得发 vsix；② vendor SuperOps 镜像同步无 diff/review 仪式（同步进来什么就是什么）；③ 无 lockfile——现场跑的是哪个版本的 playbook 无法回答（审计问题）。建议：`skills.lock.json`（id→version→sha256）随审计流记录每次会话加载的技能版本；vendor 同步做成「生成 diff → 人审 → 落地」命令；企业可用 §3.7 的 managed 文件锁定技能来源目录（对齐 Claude Code `strictPluginOnlyCustomization` 的语义）。**不做**公开 marketplace——技能即 runbook，runbook 是企业资产不是社区内容。

### 3.9 可访问性 / 键盘 / 300px

底子好：全库 codicon + aria（19 个组件 81 处 aria-*）、ApprovalBar 两段式过 300px、tool 卡 aria-expanded、`Ctrl+Esc`/`Shift+Esc`。残余三件：① 审批到达无 aria-live 播报（屏读用户不知道有单要批——审批是我们的核心动词，这不是装饰性 a11y）；② HistoryOverlay/PlaybookPicker 的焦点圈闭与 Esc 归还未验证；③ transcript 卡片键盘遍历（Tab 序）未验证。归 UI 分项执行，此处只标优先级：①>②>③。

### 3.10 生态位：成为中国企业 IDE 里的默认 ops agent

买家是「安全团队点头 + SRE 愿意用」的交集。四家对手在中国企业场景的结构性弱点：登录态绑海外云（Codex/Claude Code）、中文非一等（全部）、无国产 IM/信创叙事（全部）、凭据经其云面（Kilo Cloud）。我们要坐实的五件：① 中文一等 + 国产模型 preset（deepseek/qwen/zai thinkingFormat 已有，补 GLM/Kimi preset 即可）；② 钉钉/飞书/企微适配器（§3.4）；③ air-gapped 清单 + 离线分发（§3.7）；④ managed 策略下限（§3.7，安全团队的采购问题）；⑤ 审计导出对齐等保测评证据格式（§3.1b）。IDE 面上，webview + OpsCore 的组合天然可移植到 Cursor（已兼容）与 Kiro 类 VS Code 系——**不要**为单一 IDE 做深绑定。Cursor Cloud Agents 这类云端后台代理与我们「凭据不出插件宿主」硬约束冲突，仅作为「我们为何不做云执行」的对照叙事使用。

---

## 4. 战略建议：能力赌注（技术阶段制，非日历）

### 4.1 判断

上一轮的命题「通用体验对齐及格线」已完成。下一轮的竞争不在会话窗里：Claude Code/Codex 正在把「企业可管、可审计、可观测」变成默认项，OpenCode/Kilo 正在把「可移植内核」变成默认项。我们的对位答案不是跟跑这四件的 coding 形态，而是把它们翻译成 ops 语义：**可管 = 策略下限，可审计 = 审批/证据链的防篡改导出，可观测 = 把已有结构化事件接 OTLP，可移植内核 = 已有的 OpsCore facade 按兵不动直到第二客户端真实出现。**

### 4.2 四个技术阶段（每阶段有独立验收，顺序即依赖）

**阶段 α · 补信任内核（在卖点上兑现承诺）**
接 `@at-series/command-policy`（简报显示三态 + 聚合只加严）；append-only 审计 JSONL + 链式哈希 + 导出命令；managed 策略下限文件；敌意注入语料进 CI。验收：安全团队演示脚本——改一个已批命令→令牌作废；员工把审批调 never→被 floor 顶回；导出审计包→哈希链可验证。

**阶段 β · 证明它能干活（评测与可观测）**
8 条 playbook L1 eval 全覆盖进 CI；金样本事故库 L2（fixture 桥 + rubric，人工/夜间触发）；OTLP 导出六类事件（默认关、仅内网 collector）。验收：改任意 L0–L4 提示词，CI 能在无模型层拦住链路断裂；换模型跑金样本出分数对比。

**阶段 γ · 值班闭环（分发与打扰面）**
钉钉/飞书/企微签名卡片 + `vscode://` 深链 + 决策回推；巡检历史沉淀 + 上次摘要注入 + cron 表达；多窗口选主（定时器/IM 单实例）；skills.lock + vendor 同步 diff 仪式。验收：手机收到审批卡→点深链→IDE 聚焦简报→批准→群里收到回执；连续两天巡检报告能出差异。

**阶段 δ · 生态位（仅在触发条件满足时启动）**
第二客户端（Web 值班台/CLI）出现时给 OpsCore 套 HTTP/SSE 壳（ADR-001 进程模型仍不破）；air-gapped 认证清单产品化；等保证据格式导出。触发条件：真实客户提出第二客户端或合规导出需求——**没有需求不预建**。

### 4.3 明确不做（对手每一项都在诱惑我们）

1. **不做 OS/内核沙箱竞赛**（Codex/Kilo/Claude Code）：ops 的执行面在远端生产，沙箱保护的是错误的机器；我们的等价物是语义审批 + 桥边界 + 审计链。
2. **不做云端/后台执行代理**（Kilo Cloud、Codex Cloud、Cursor Cloud Agents）：凭据不出插件宿主是硬约束 C4，这是卖点不是欠账。
3. **不做 IM 双向批准 / 手机接管**（Kilo remote 反例）：IM 永远单向。
4. **不做 headless/CI 化的 ops 执行**：`codex exec` 式无人值守与双闸互斥；巡检的无人值守上限是只读采集（且在审计流就位后）。
5. **不做公开技能 marketplace**：runbook 是企业资产；分发走 vendor 镜像 + managed 锁源。
6. **不做 worktree/diff/checkpoint/`/undo`**（上轮已定，维持）：运维回滚是被审批的生产动作，不是文件快照。
7. **不追 provider 数量与成本换算精度**：内网网关 + 国产模型 preset 覆盖目标用户。

### 4.4 一句话收束

上一轮把「像产品」补齐了；这一轮的赌注是把**双闸和证据链从产品功能升级为可验证、可管控、可导出的信任基础设施**——那是四家 coding agent 的架构与商业模式都不便跟进的地带，也是中国企业 IDE 里「默认 ops agent」的真正门票。
