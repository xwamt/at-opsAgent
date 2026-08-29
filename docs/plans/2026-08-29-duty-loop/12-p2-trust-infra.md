# Plan 12 · P2 信任基础设施与值班闭环（P0/P1 全绿后）

> Status: Ready after Wave 0–2 `npm test` 全绿
> Source: docs/15 §3 P2 子弹；reviews/round2/01 R7–R8、04 长期记忆、07 审计/OTLP/IM
> Depends on: Plan 04（mergeEvidence 已接线或标明删除）；Plan 07 刮密（审计/IM 正文必须过 redact）
> Parallel-safe: 下列 T# **各做独立 PR**，禁止一个 PR 塞完全部 P2
> Module: memory 文件、`subagents.ts`、审计 JSONL、settings 策略下限、OTLP、IM、UI 过滤、skills.lock

## 0. 一句话目标 + 完成判据

在不违反「凭据不出宿主 / 无 IM 双向批准 / 无 OS 沙箱 / 无云执行」的前提下，把已有结构化事件变成可管、可审计、可观测的值班基础设施；长期记忆只读用户确认的事实。

本包没有单一完成判据——每个 T 自己的 Done when。Wave 3 总闸：任意 T 不得打开 docs/15 §5 的禁区。

## 1. 背景（代码事实）

- 长期记忆：无 `memory/environment.json`、无 `ops_recall`。L-env 只有 Hub 现场（`env-snapshot.ts`）。
- 子代理：阻塞式 `Promise.all`；`subagents.ts` **无** `waitMs`。`payloadCaps` 在 orchestrator `index.ts:56,94,363` 注入 playbook defaults，**runtime `executeBusinessTool` 未调用** `injectPayloadCaps`（reviews R8）。
- 审计：timeline + ui-sessions + Output Channel，无链式哈希。
- IM：`approvalNotify.ts:31-56` POST JSON 摘要到 `atOpsAgent.im.webhookUrl`，无加签、无 `vscode://` 深链、无回执。
- OTLP：零。
- 策略：`approval.sessionRequiredFor` 用户可调松。
- 技能：`skills/vendor/super-ops@0.1.0/` 无 `skills.lock.json`。

## 2. 硬约束（整包）

- 不做 OS/内核沙箱、云端/后台 Cloud Agent、IM **双向批准**（卡片通知 + 深链回 IDE 可以；手机上点批准不行）。
- 不做 swarm / worktree / undo、不 fork pi、不现在抽 `serve` 进程（docs/15 P2「第二客户端」明确按兵不动）。
- 不从工具结果自动抽记忆。
- 不把 Jenkins/Nacos/Grafana 写成 MCP。
- selection 不是 ACL。
- runtime/orchestrator/hub-host/policy 零 vscode（OTLP/IM/文件记忆的 vscode 放 host）。

## 3. 目标设计（按 docs/15 P2 子弹）

每颗子弹一个可独立合入的 T。Skip 必须在 PR 说明写原因，不能 silently drop。

---

### T1. 长期记忆层（environment / incidents / OPS.md / ops_recall）

**对应：** docs/15「记忆层」

目录（workspace 优先，否则 `~/.at-series/agent/memory/`）：

```
memory/environment.json   # 用户确认的别名 { "prod-a": "集群说明" }
memory/incidents/index.md # ≤200 行；每行日期 + 一句话 + 路径
memory/OPS.md             # 只读操作备忘；Agent 只 read
```

工具：

- `ops_recall({ query: string })` risk=read：对 index + environment **子串匹配**（不要向量库），返回 ≤8 行。
- **没有** `ops_memory` 任意 key write。写入 environment：仅 host 命令 `atOpsAgent.memory.editEnvironment` 打开 JSON，保存时 schema 校验 + `redactSecrets`；**模型不能写 environment.json**。
- incidents：close playbook 成功后 **询问** notice「是否把本结论追加到 incidents/index.md？」用户点是才写一行（≤200 行满则拒绝并提示归档）。禁止自动写。

L-env：`formatEnvSnapshot` 末尾若 environment.json 有键，追加 `aliases:` 最多 15 行。文件缺失则不提。

测试：`test/ops-recall.test.ts` 子串命中；秘密字段拒写；index 第 201 行失败。

**明确不做：** 自动从 tool preview 抽事实。

Done when：用户确认的别名出现在 L-env；模型只能 recall 不能默写环境表。

---

### T2. 有限后台化 waitMs + ops_check_subagent

**对应：** 编排 waitMs；reviews R7

- `DISPATCH_TASK_PROPERTIES` 增加可选 `waitMs`（number，毫秒）。缺省不传 = 今日阻塞语义。
- `waitMs` 到期：该 task 返回 `{ status:'running', taskId }`，主会话 prompt 结束；runner **继续**在 manager 内跑。
- 新工具 `ops_check_subagent` `{ taskId }` 只读，仅主会话注册，复用已有 `waitFor`/`statusOf`（reviews 指 `subagents.ts:557-592` 一带，以当时行号为准，实现前 Read 确认）。
- 子会话 **不** 注册 check/dispatch（禁递归）。

测试：假 runner 10s + `waitMs:50` → 工具结果 running；随后 check 等到 ok。不传 waitMs 行为与现网 snapshot 一致（可对 dispatch 单测做 goldens）。

Done when：缺省阻塞不变；可选早返 + 收割。

---

### T3. payloadCaps 接线或删除

**对应：** reviews R8；docs/15「mergeEvidence / payloadCaps 接线或删」——**mergeEvidence 属 Plan 04 T4，本 T 不管 merge**。

二选一，PR 描述必须声明选了哪条：

- **接：** `executeBusinessTool` 前 `injectPayloadCaps(playbook.defaults.payloadCaps, args)`；dispatch schema **不**暴露 payloadCaps（由 yaml defaults 来）。单测：Loki 类工具缺 `limit` 时被补 ≤100（以 `orchestrator/index.ts` 现函数为准）。
- **删：** 删除 `injectPayloadCaps` 与 yaml 字段，改 `docs/04` §3.2「上限靠 L1」并删悬空 API。

禁止半接（函数还在但零调用）。

Done when：`rg injectPayloadCaps src` 要么有 runtime 调用，要么定义与文档一起消失。

---

### T4. 审计 JSONL + 链式哈希 + 时间窗导出

**对应：** 审计

- 路径：`~/.at-series/agent/audit/YYYY-MM-DD.jsonl` append-only
- 每行：`{ ts, type, sessionId, payload, prevSha256, sha256 }`。`sha256 = sha256(prevSha256 + canonical(payload))`。payload 先 `redactSecrets`。
- 事件类型最少：`tool_decision`、`approval_request`、`approval_decision`、`policy_block`、`playbook_stage`、`export`
- 导出命令 `atOpsAgent.exportAudit`：QuickPick 时间窗，写出独立 jsonl 副本（仍含链，便于外送）。
- 启动时若最新文件末行链断，log 警告 **不要** 自动重写历史。

测试：写三行，第三行 prev=第二行 sha；手改第二行后校验函数报断链。

Done when：一次巡检 close 后 audit 文件含 stage + 至少一次 tool_decision。

---

### T5. managed 策略下限

**对应：** sessionRequiredFor 只能更严

- 新配置 `atOpsAgent.policy.floor`（enum 与 `sessionRequiredFor` 同值，默认 `write-exec`）可由 **企业 settings.json / 文档说明** 下发。
- 有效值 = `max(floor, userSetting)`（read < write-exec < exec 的全序，实现时写死比较函数）。
- UI：settings 若用户选了比 floor 更松的值，保存时 clamp 并 notice「已按组织下限收紧」。

测试：floor=`exec`、用户 `write-exec` → 实际 `exec`；用户 `exec` 不变。

Done when：无法把闸门调到比 floor 更松。

---

### T6. 内网 OTLP（默认关）

**对应：** 可观测六类事件

配置：

```
atOpsAgent.otel.endpoint   # 空=关
atOpsAgent.otel.protocol   # http/protobuf，仅允许 http(s) 且 hostname 为 RFC1918 / localhost（拒绝公网 SaaS）
```

六类：`tool_decision`、`approval_request`、`approval_decision`、`policy_block`、`playbook_stage`、`token_usage`（reviews 还列了 subagent spawn/终态——作为 6+1 可附在 usage 或第七；文档写六类则 **恰好六类**，subagent 并入 `tool_decision` 属性）。

失败只 log。无 SDK 也可先用 OTLP HTTP JSON 最小 POST，避免拉全量 vendor。依赖若加，精确锁版本。

测试：endpoint 空 → 零 fetch；endpoint `https://example.com` → **拒绝**（非内网）；`http://127.0.0.1:4318` mock 收到 1 条。

Done when：默认零网络；内网 collector 能看到 span/log。

---

### T7. IM 加签卡片 + 深链（单向）

**对应：** 值班面钉钉/飞书/企微

扩展现有 `postApprovalWebhook`：

- 配置 `im.webhookSecret`（SecretStorage，不是 settings 明文）HMAC-SHA256 body。
- body 增加 `deeplink`: `vscode://xwamt.at-ops-agent/chat?sessionId=`（publisher/id 以 `package.json` 为准）+ `hint` 已有「回 IDE 批准」。
- **禁止** 做 inbound HTTP 收「approve」——没有回调服务器。
- 飞书/钉钉卡片字段差异：先保持通用 JSON；各 IM 适配作为 T7b 可选，缺省 raw JSON 足够（现状已是 JSON）。

测试：secret 空仍可发（兼容现状）但 log「未加签」；secret 有则 header `X-At-Ops-Signature`。

Done when：webhook 含深链；无法经 IM 直接批准。

**明确 skip：** 巡检历史差异 / cron / 多窗口选主——各为独立 T8–T10，不要捆进 IM PR。

---

### T8. 巡检历史差异（可选独立 PR）

close 时若 `memory/incidents` 或上一次同 playbook 导出存在，对「结论段落」做行级 diff，notice 展示 `+新增 / -消失` 最多 20 行。无历史则跳过。

没有稳定存储则本 T skip，等 T1 incidents 落地。

---

### T9. cron 巡检（可选）

VS Code `tasks.json` / `alichs` 不造。用 `vscode.workspace.createFileSystemWatcher` **不做**。唯一允许：`atOpsAgent.inspection.cron` 字符串空=关；用 `setInterval` 仅当窗口聚焦且 `window.state.active`——后台无宿主则不跑（呼应「不做 headless 无人值守执行」）。默认关。

若实现会滑向 headless，**直接 skip** 并在文档写「巡检由用户点 Playbook」。

---

### T10. 多窗口选主（可选）

`globalState` + 文件锁 `~/.at-series/agent/instance.lock`。非主窗口禁用 runtime pool（只读 hydrate）。复杂度高，允许 skip 并写 ADR「单窗口」。

---

### T11. UI P2 集合（可拆 PR）

docs/15 UI 子弹，**不要**和新审计链混 PR：

1. 结论模式：Composer 旁 filter，只显示 assistant + evidence + notice，隐藏 tool/thinking。
2. ApprovalBar：空要素折叠（无文本的 dt/dd 不渲染）；命令行等宽高亮（关键词 `rm|kubectl apply|delete` 用 span，不是整 pre）。
3. board 补完 codicon（grep 残留 emoji）。
4. token 间距：`--ops-density` 已有则收敛 ChatTranscript padding 到 4/8。
5. 思考时长：thinking item 显示 `durationMs`（协议加可选字段，host 在 thinking 结束时写）。
6. Focus：已有折叠则确认默认不展开 CoT；加配置 `ui.showThinking` 默认 true（值班需要），Focus 模式 false。

每项可单独合。测试以组件/纯函数为主。

---

### T12. skills.lock.json + SuperOps diff 仪式

`skills/skills.lock.json`：

```json
{ "vendor": { "super-ops": { "version": "0.1.0", "sha256": "..." } } }
```

`npm test` 或单独 `test/skills-lock.test.ts`：计算 `skills/vendor/super-ops@0.1.0` 文件哈希，不一致则失败并提示「vendor 升级走 diff 仪式」。文档 `skills/README.md` 加三步：锁文件、PR 说明、VERSION。

Done when：改 vendor 一个字 CI 红。

---

### T13. 气隙一页 + GLM/Kimi preset

新 `docs/16-airgap.md`（一页）：无外网时 models.json 怎么填、Hub 不访问公网、OTLP 默认关、walkthrough 不依赖外链图。

`models` 预设：settings 或 `media/presets/glm.json` + `kimi.json` 示例（无真实 key）。不要写进默认 models.json 以免覆盖用户。

Done when：文档可离线照做；preset 无密钥。

---

### T14. 第二客户端 HTTP/SSE — SKIP

文档一段：OpsCore facade 保持；真实第二宿主出现前不抽进程、不 `pi serve`。Plan 12 执行者看到「加个 HTTP 就能量化」必须停。

在 `docs/01-architecture.md` 加 TBD 框即可，**零代码**。

---

## 4. 建议 PR 顺序（仍全部在 Wave 3）

```
T5 floor（小、安全）
T12 skills.lock（小）
T13 文档/preset
T1 memory（产品）
T2 waitMs
T3 payloadCaps
T4 audit chain
T6 OTLP
T7 IM 深链
T11 UI 碎片
T8–T10 仅当有明确值班需求
T14 skip
```

## 5. 验收（整包）

- [ ] 每个合入的 T 有自己的测试或文档 skip 理由
- [ ] `rg` 确认无 IM approve 回调 server
- [ ] 无 pi serve / 无 OS sandbox 新依赖
- [ ] 全量 `npx vitest run` 绿

## 6. 明确不做

docs/15 §5 全文适用。另外：本文件旧稿里的「审批 Remember / autoAllowReadMcp / 子代理 MCP 白名单 / 分进程 serve / 模型探活横幅 / MCP 60s」**不是** docs/15 P2 主键。若 reviews 仍想做：

- Remember / autoAllowRead = 审批 UX，可附在 T11 或独立 P2 PR，默认关。
- 分进程 serve = T14 skip。
- MCP 超时 = 可附 T6 之前的小修，但不替代 OTLP。

## 7. 风险

审计链与 ui-sessions 双写磁盘；失败不得挡住主会话（void catch log）。OTLP 配错公网必须在发送前拒绝。
