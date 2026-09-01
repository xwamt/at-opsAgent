# 用户消息撤回/编辑 + 插件侧安全闸去重

> **日期：** 2026-09-01  
> **状态：** 已确认  
> **范围：** `at-opsAgent` 聊天输入撤回/编辑；Agent 会话审批 vs AT 插件确认弹窗  
> **方法：** 对照本地 Kilo Code 7.4.x、pi SDK 0.84.3、at-terminal / JumpServer / Nacos 插件确认实现  
> **非本次：** 不写代码、不改默认策略落地；本文是需求与可行方案，确认后再拆实现计划

---

## 0. 要解决的两件事

1. **用户输入可撤回、可修改。** 对话已经走了几轮之后，改某一条用户话，必须同时清掉「那条之后」的模型上下文，并把原文放回输入框继续编。
2. **不要在 Agent 侧再加一道人审。** 写/执行的安全闸已经在各 AT 插件里实现（弹窗 + command-policy + 信任档）。Agent 再弹 9 要素简报是重复确认，不是额外安全。

两件事独立，可分两个实现计划。本文合写，是因为它们都碰到同一条产品约束：**生产侧已发生的动作不能靠聊天 UI 撤销；人审只应发生一次，且发生在真正会打到目标系统的那一层。**

---

## 1. 现状（代码实况）

### 1.1 用户消息：发出去就定死

| 层 | 现状 | 关键文件 |
|----|------|----------|
| UI | 用户气泡只渲染纯文本，无编辑/删除按钮 | `ChatTranscript.vue` `transcript__msg--user` |
| Composer | 只能发新消息；运行中 = steer，刚结束 = followUp | `Composer.vue`、`store-helpers.buildPromptPayload` |
| UI 会话 | `sessionStore.appendItem` 只追加；无按 id 截断 API | `sessionStore.ts` |
| 模型上下文 | pi JSONL 是唯一真源；UI transcript 只是缓存 | `sessionStore.ts` 文件头注释 |
| 用户气泡 id | host 用 `randomUUID()`，**不是** pi JSONL `entryId` | `chatService.handlePrompt` |

现有「改口」只有两条旁路，都不是编辑：

- **steer**：当前 turn 还在跑，把新文字插进这一轮（追加约束，不回溯）。
- **retry**：重发**最后一条**用户原文，不截断、不改字。

改第 2 条用户话、丢掉后面 3 轮问答，今天做不到。UI 截掉气泡而 pi JSONL 不动，模型仍带着旧上下文——这是最危险的半成品，禁止作为实现。

### 1.2 审批：文档写三道闸，设置项是空壳

`docs/07-security.md` 的顺序：

```text
模型 tools/call
  → ① 会话策略（risk + Playbook + approvalToken + payloadCaps）   Agent
  → ② Hub 选路                                                     HubHost
  → ③ 插件确认弹窗 + command-policy / 信任档                       插件
```

① 的人审面是 ApprovalBar 九要素。`evaluatePolicy` 在 `sessionRequiredFor=write-exec`（默认，且 `policy.floor` 不能更松）时，对所有 write/exec **一律** `needSessionApproval`。runtime `applyToolGate` 在同一 `execute` 内 `await requestApproval`：批准才继续同一调用，拒绝返回结构化 JSON。

设置 `atOpsAgent.approval.dedupePluginModal`（默认 false）**没有关掉任何一道闸**。它只把 `ApprovalBriefView.dualConfirmHint` 设为 false，少显示一句「插件可能再确认」。`docs/05-ui-system.md` 写的 `sessionApproval: 'brief-only'` 并未接线。

叠加 GuidedManual 时，一次写操作最多确认三次（评审 `docs/reviews/ux.md` #20）。这正是本次要拆掉的重复。

### 1.3 插件侧人审（权威闸）

| 插件 | MCP/Agent 路径的人审 | 自动放行条件 |
|------|----------------------|--------------|
| **at-terminal** | `AgentToolService.runRemoteCommand`：非 autoApprove 则 `showWarningMessage({ modal: true })`，120s 超时后晚到的点击作废 | 信任档 `full` → 全放；`policy` → `@at-series/command-policy` 判 `allow` 才放；`none` → 每次弹。SFTP 写按目录+TTL；delete **每次**弹，即使 full trust |
| **JumpServer** | MCP 命令/SQL/Redis 走 `confirm()`；部分操作 **full trust 仍弹**（send raw、delete） | 资产信任档；delete 永不记住批准 |
| **Nacos** | 写路径统一 `confirmWrite` 模态 + `assertWritable` | 实例 `readOnly` 直接拒绝 |
| **Jenkins** | 树/命令面板的 trigger/stop/save 有模态；**当前 MCP 工具全是 `risk: read`，Agent 打不到写** | 控制器 `readOnly` |
| **Grafana** | 只读；TLS TOFU，无人审写路径 | — |
| **Database** | 文档与 policy 明确：**MCP 写无插件弹窗**，所以 ① 对 `at.database` write **强制简报**，即使用户把 `sessionRequiredFor` 调到 `exec-only`/`never` | 这条必须保留 Agent 简报，直到插件 MCP 写也弹窗 |

Terminal 的 command-policy 在插件内是权威；Agent 侧 `previewRemoteCommandPolicy` / `inferEffectiveRisk` 只做预判（`hostname` 可降为 read、免简报），**不能替代**插件弹窗。

### 1.4 pi 已经能做「回到某条用户话」

当前 runtime 用 `createAgentSession`（`session-factory.ts`），会话对象是 `AgentSession`，**不需要**升到 `AgentSessionRuntime` 也能回溯：

| API | 效果 | 是否新会话文件 |
|-----|------|----------------|
| `session.navigateTree(entryId)` | 同文件把 leaf 移到该节点；若目标是用户消息，返回 `editorText` | 否 |
| `session.getUserMessagesForForking()` | 列出可回退的用户消息 `{ entryId, text }` | — |
| `runtime.fork(entryId)`（`AgentSessionRuntime`） | 复制到该用户话，**新开** JSONL | 是 |
| `/tree` 选非用户节点 | 停在那一点，编辑器空，从此续写 | 否 |

pi 文档：`/fork` = 选一条更早的用户话 → 拷到那一点 → **把原文放进编辑器供修改**。这就是「回归编辑」的语义。

约束（ADR-002）：**不 fork pi 源码**。只用公开 API。Coding 的 git checkpoint / rewind-code **不做**——运维回滚是被审批的生产动作，不是本地文件快照。

---

## 2. 对照 Kilo：编辑怎么清上下文、怎么回到输入框

### 2.1 旧版 Kilo（Cline 谱系，changelog 仍见 `editMessageConfirm`）

交互：

1. 悬停用户气泡 → Edit / Delete。
2. **Edit**：气泡内（或 Composer）进入编辑；Save 时：
   - 若正在跑，先 abort；
   - 从该条用户消息起截断 UI 历史（`clineMessages`）和模型历史（`apiConversationHistory`）；
   - 有 checkpoint 则还原工作区文件（coding 语义，我们不抄）；
   - 用新文本重新跑一轮。
3. **Delete**：同样截断，不重发。
4. 改中间某条 = 丢掉它后面的所有 assistant / 工具 / 用户话。

这是 **就地截断（truncate-in-place）**，会话 id 不变。

### 2.2 新版 Kilo（OpenCode server 重建，7.4.11）

`docs/chat-ui-features/message-editing-management.md` 把消息编辑标成 **Remaining Work**，后端映射是：

> Map edit/delete to CLI session operations (**fork-from-message + re-run**)

即：不要自己维护两份 history 数组，把「从某条用户话重新开始」交给 CLI 的 fork/undo。Checkpoint 另文，且明确「CLI undo 能否替代 git checkpoint 尚未定」。

### 2.3 对 at-opsAgent 的翻译

| Kilo / pi | 我们该学 | 我们不学 |
|-----------|----------|----------|
| 编辑 = 从该用户消息截断模型上下文 + 原文回编辑器 | 学 | — |
| 删除 = 截断且不重发 | 学 | — |
| 就地截断（旧 Kilo）/ 同文件 `navigateTree`（pi `/tree`） | **推荐学这个** | 不要默认新开会话（fork 新 JSONL 会炸历史抽屉） |
| 新 Kilo 的 CLI fork | 仅当用户明确「另存一条分支」时再做 | 不要把普通「改错字」做成新会话 |
| git checkpoint 还原文件 | — | 生产主机上的命令已经执行，UI 撤回**不能**当回滚 |
| 气泡内完整 Composer（模式选择/图片） | 窄侧栏不够；回退到 Composer | 不在气泡里重做一套输入栏 |

**「改第 2 条、后面还有 3 轮」的目标语义：**

```text
UI:  U1 A1 T1  U2 A2 T2  U3 A3
                 ↑ 用户点编辑

1. abort 当前流 / 拒掉挂起审批 / 中止该点之后派发的子代理
2. pi.navigateTree(U2 的 entryId)     ← 模型上下文停在 U2 之前（不含 U2 之后）
3. sessionStore 截到 U2 之前（U1+A1+T1 留下）
4. Composer 填入 U2 原文，用户改完再发送 = 新的 U2'
5. 上屏一条 notice：只撤回了对话上下文；已执行的命令/发布不会自动撤销
```

pi 的 `navigateTree` 若把 leaf 停在 U2 这条用户消息上，需要核对 SDK：是「含这条用户话」还是「停在它之前、原文进 editor」。实现时以 `editorText` 返回值为准——有 `editorText` 就视为「请重新编辑这条」，UI 不再保留该气泡。

---

## 3. 需求 A · 用户输入撤回 / 修改

### 3.1 用户可见行为

1. **空闲时**，每条用户气泡悬停（或常驻小图标，窄侧栏可点）：编辑、删除。
2. **编辑**：点击即向 host 提交截断（先 abort 再 `navigateTree`），该条及之后从 transcript 消失；原文进入 Composer；焦点在输入框；发送 = 新 turn。截断一旦成功不可「取消还原」——关掉输入框只是不重发，历史不会自动长回去。需要那几轮对话只能从导出/记忆里抄，或一开始就不要点编辑。
3. **删除**：同样立即截断；Composer 不预填，不自动向模型发话。
4. **运行中**：先 `chat/abort`（`stop`，含审批 waiter 拒绝 + 子代理级联），完成后再截断。不允许「边跑边改历史」。
5. **Up-arrow（可选，P1）**：不截断，只把**最后一条**用户原文填进 Composer，便于改错字后当 followUp。与「编辑历史气泡」不同。
6. 截断后若 transcript 里已有 **write/exec 且 status=ok** 的工具卡被裁掉，顶部 sticky notice（不可点掉直到发送或新会话）：**「仅撤回对话。已在目标系统执行的操作不会撤销。」**

### 3.2 必须一起动的状态

截断不是只改 Vue 数组。一次成功的编辑/删除要原子完成：

| 状态 | 动作 |
|------|------|
| pi JSONL | `navigateTree(entryId)`（禁止只改 UI） |
| `ui-sessions.json` | `sessionStore` 按 item id 截断并 persist |
| 挂起审批 | `rejectWaitersFor(sessionId)`，简报从 UI 消失 |
| 该点之后的子代理 | `abort`；卡片从 transcript 裁掉 |
| playbook stage | **不**根据工具卡倒推阶段。截断后保持当前 stage，或若已无 playbook 条目则不动。系统提示词下一轮 `syncLivePrompt` 会带现 stage——允许「上下文短了、阶段还在 investigating」。禁止为编辑去重置整个 playbook 状态机 |
| `currentApprovals` 令牌 | 清空该会话 |
| 用户气泡 ↔ pi | 发送时在 `TranscriptItem` 上写入 `piEntryId`（pi 用户消息落盘后回填）。**现在的 `randomUUID()` 不能拿去 navigateTree** |

`piEntryId` 回填时机：`subscribeSessionEvents` 在对应 user message 写入 JSONL 后 patch UI item。编辑协议用 `piEntryId`，没有则拒绝编辑并 notice「该条无法回溯（旧会话）」。

### 3.3 三种实现对照

| | A. 同文件 `navigateTree`（推荐） | B. `fork` 新 JSONL | C. 只截 UI |
|--|--------------------------------|---------------------|------------|
| 模型上下文 | 与 UI 一致 | 一致，但是新会话 | **不一致，禁止** |
| 历史抽屉 | 同一会话 | 每次改口多一条 | — |
| 与现有 runtime | `AgentSession` 已有 API | 要升 `AgentSessionRuntime`，替换 session 后重订事件订阅 | — |
| 运维可讲性 | 「回到这句话再问」 | 「另存分支」——值班不需要 | — |

**推荐 A。** B 留作以后「另存对照实验」，不进本期。C 永不做。

### 3.4 协议（A 所需）

新增（名称可在实现计划里微调，语义锁定）：

```ts
// webview → host
type ChatEditReq = {
  itemId: string;          // UI transcript user item id
  action: 'edit' | 'delete';
};

type ChatEditRes = {
  ok: boolean;
  editorText?: string;     // edit 成功时：应填进 Composer 的原文
  reason?: string;
};

// TranscriptItem.user 增补（旧条目缺省 = 不可编辑）
// { kind: 'user'; id: string; text: string; ts?: number; piEntryId?: string }
```

Host 步骤：abort → `navigateTree(piEntryId)` → 截断 store → hydrate/broadcast → 返回 `editorText`。Webview 把 `editorText` 写入 Composer draft 并 `focus`。不在气泡内做「未提交的本地编辑」：窄侧栏放不下第二套 Composer，且未提交编辑会造成 UI 与 pi 谁先动的竞态。

### 3.5 非目标（需求 A）

- 不还原远端主机/Nacos/Jenkins 状态。
- 不做 assistant 气泡编辑。
- 不在气泡内嵌完整 Composer（附件、slash、模型选择仍在底栏）。
- 不把 compaction 摘要当成可编辑用户消息。
- 不 fork pi。

---

## 4. 需求 B · 人审只留在插件，Agent 不再叠一道

### 4.1 产品判断

人审的意义是：**在命令打到目标系统之前，人看见了什么、点了同意。**  
这件事 AT Terminal / JumpServer / Nacos 已经做了（模态 + 超时 + 信任档 + 审计）。Agent 九要素简报做的是另一件事：逼模型填 goal/rollback 再点一次。值班路径上这会变成「点两次几乎相同的是否执行」，然后插件再弹第三次。

**本期结论：对「插件 MCP 路径已经会弹确认」的 write/exec，Agent 不再 `needSessionApproval`。**  
Agent ① 仍保留**非人审**能力：block、riskCeiling、payload caps、SQL LIMIT、command-policy 风险升降、Executor 无令牌拒绝、fail-closed。

### 4.2 三种实现对照

| | 1. 按「插件会确认」跳过 Agent 简报（推荐） | 2. 关掉 ① 的全部人审（`sessionRequiredFor=never` 当默认） | 3. 让 Agent 去压插件弹窗 |
|--|--------------------------------------------|-----------------------------------------------------------|--------------------------|
| Terminal `policy`/`none` | 只弹插件 | 只弹插件 | 只弹 Agent，插件被绕过 → **安全回退** |
| Terminal `full` 自动放行 | 无人审（用户在服务器表单里选的） | 同左 | Agent 仍拦一道，与「安全在插件」相反 |
| `at.database` write | **仍要** Agent 简报（插件 MCP 无窗） | **漏审** | 无插件窗可压 |
| 第三方 MCP write | 无 `confirmsInPlugin` → 仍要简报 | **漏审** | 压不了别人的窗 |
| 现有 `dedupePluginModal` | 删除或改成只读说明 | 更名也救不了漏审 | 文档曾幻想 brief-only，从未实现 |

**推荐 1。** 默认行为对齐用户要求，且不拆掉 Database / 第三方 MCP / 无窗插件的安全网。

**反对 2：** `policy.floor` 默认 `write-exec` 就是防止用户把全局开关拧到 `never`。把 never 当产品默认，等于拆掉 floor。

**反对 3：** 插件弹窗是权威闸；Agent 没有、也不该有「替插件同意」的通道。`dedupePluginModal` 今天的文案「合并插件确认」是错的，实现上也从未合并。

### 4.3 判定「插件会确认」

不要只认 pluginId 字符串。Hub 工具描述符增加显式标记（插件登记时带上），Agent 只读标记：

```ts
// Hub 工具描述（概念；落地字段名在实现计划与各插件 catalog 对齐）
confirmsInPlugin?: boolean;
```

**过渡 allowlist**（标记未齐时的硬编码，宁多审不多放）：

| 视为 confirmsInPlugin=true | 仍要 Agent 简报 |
|----------------------------|-----------------|
| at.terminal：`run_remote_command`、SFTP 写/删/改名 | `at.database` 的 write（现有强制规则不动） |
| at.jumpserver：终端命令、SQL、Redis、SFTP 写/删 | `ops_write_ops_doc`（host 工具，无插件窗） |
| at.nacos：publish/delete/rollback/health | 第三方 `mcp_call_tool` 及未知插件 write/exec |
| | Jenkins：当前 MCP 全是 read，走 read 放行即可；**一旦暴露写工具且 MCP 无窗，必须简报或先补插件确认** |

`inferEffectiveRisk` 把远程命令降为 read 的路径不变：只读巡检不弹 Agent、也不该弹插件（Terminal `policy`+allow 已自动放行）。这不是第二道人审，是风险分类。

Playbook Executor：今日必须带 `approvalToken`。去重后主会话可能从未签发令牌。规则改为：

- 主会话对「插件会确认」的工具：不签 token，直接 invoke，插件弹窗为人审。
- Executor：若目标工具 `confirmsInPlugin`，允许无 token 下发，**仍受 riskCeiling 与命令集约束**（不能即兴扩命令）。人审发生在插件。
- Executor 打 Database write / 无窗工具：仍必须先有主会话简报 token。

### 4.4 `dedupePluginModal` 怎么处理

| 动作 | 原因 |
|------|------|
| 删除该设置，或改为只读文案「写操作由对应插件确认，Agent 不再重复弹简报」 | 现在的开关既不跳过 ① 也不跳过 ③，会骗人 |
| ApprovalBar 对跳过简报的工具不再出现 | 避免空等 |
| 设置页 `sessionRequiredFor` 只影响 **无插件确认** 的 write/exec | 有插件确认的工具不受此旋钮控制，避免「never + full trust」被理解成 Agent 又能拦一道 |
| 双确认 hint 文案删除 | 不再有双确认主路径 |

`sessionRequiredFor` + `policy.floor` 继续管：Database、第三方 MCP、将来未标 `confirmsInPlugin` 的写工具。

### 4.5 Agent ① 仍要做的（不是人审）

这些不是「再点一次同意」，必须留下：

- Investigator / Writer 的 riskCeiling、工具面剥离。
- Loki limit、SQL LIMIT、payload caps。
- command-policy 预判失败时 **不加严为 allow**（与现网一致）。
- 策略异常 fail-closed。
- 审批/工具审计时间线：即使无人审，也记 `tool_decision`（`needSessionApproval: false`, `humanGate: 'plugin'`）。
- Terminal `full` 自动放行：Agent **不**补弹。信任档是服务器表单上的明确选择；要拦就去改该主机的 `agentCommandTrust`，不要在 Agent 藏一道。

### 4.6 与 at-terminal 对齐的值班体验

今天：Agent 简报（9 行 dl）→ 用户点批准 → Terminal `showWarningMessage`（主机 + 命令 + destructive 提示 + policy evidence）。

目标：模型直接 `execute` → 只出现 Terminal 那一张模态（或 policy 自动放行）。Agent transcript 里工具卡仍显示「等待插件确认 / 已在插件批准 / 用户取消（USER_CANCELLED）」。

超时：继续用插件自己的超时（Terminal 120s，JumpServer `confirmWithTimeout`）。**不要**再套一层 Agent `approval.timeoutMs` 去等人审——人审不在 Agent。Agent 的 15 分钟 TTL 只留给仍走简报的路径（Database 等）。

晚到的批准：Terminal 已处理（超时后点击提示「命令未执行，请让 Agent 重试」）。Agent 把 `USER_CANCELLED` 当取消，不重试同一调用（现有 `isCancelledInvocation`）。

---

## 5. 架构（两件都做时的边界）

```text
ChatTranscript 用户气泡
    │ edit/delete
    ▼
ChatService.handleEdit
    │ abort + navigateTree + truncate store
    ▼
Composer 预填 editorText ──► 再发送 = 普通 handlePrompt

模型 tools/call
    │
    ▼
evaluatePolicy          ① 仍可 block / 降风险 / caps
    │ needSessionApproval?
    │   ├─ 插件 confirmsInPlugin → 否，execute
    │   └─ 无窗写工具           → ApprovalBar（现状）
    ▼
Hub invoke              ②
    ▼
插件 confirm + policy   ③ 唯一的人审（有窗工具）
```

两件共享的不变量：

- 生产副作用只发生在 ③ 之后（或插件 autoApprove 之后）。
- 编辑/删除只动对话与模型上下文，不动 ③ 已经放过的命令。

---

## 6. 错误与边缘

| 情况 | 行为 |
|------|------|
| 旧会话用户条无 `piEntryId` | 编辑按钮禁用或点击后 notice，不假装截断 |
| `navigateTree` 失败 | 不截 UI；notice；会话保持可聊 |
| 截断范围内有 running 工具 | abort 完成前不截；超时则硬停再截 |
| 编辑时另一并行会话 | 只动活动会话（与现有 abort 定向一致） |
| 插件弹窗取消 | 工具结果 `USER_CANCELLED`；模型看到取消，不走 ApprovalBar |
| Database write | 仍 ApprovalBar；与插件无窗的现状一致 |
| 用户开着 Terminal `full` | 无 Agent 简报、无插件窗；这是配置选择，设置页/服务器表单需能看见信任档 |

---

## 7. 测试要点（实现计划必须覆盖）

**消息编辑**

- 三条用户话，编辑第 2 条：UI 只留第 1 轮；再发送后模型请求的历史不含第 2/3 轮原文。
- 删除第 2 条：不向模型发 prompt；Composer 空。
- 流式中点编辑：先 abort，再截断，再预填。
- 无 `piEntryId`：不可编辑。
- 截掉已成功的 `run_remote_command`：出现「不撤销已执行命令」notice。

**审批去重**

- `run_remote_command` + `sessionRequiredFor=write-exec`：`needSessionApproval === false`，ApprovalBar 不出现；invoke 仍发生。
- `at.database` write：`needSessionApproval === true`（强制规则回归）。
- Investigator 调 write：仍 block（ceiling），不是跳过简报就执行。
- `dedupePluginModal` 删除后 settings hydrate 不含该键（或只读）。
- 取消插件模态：runtime 得到取消 JSON，不是 `OPS_APPROVAL_REJECTED`。

---

## 8. 建议落地顺序

1. **审批去重**（需求 B）：改 `evaluatePolicy` + 描述符/allowlist + 删空壳设置。值班立刻少点一次。不依赖 UI。
2. **消息编辑**（需求 A）：`piEntryId` 回填 → host `chat/edit` → 气泡按钮 → Composer 预填。依赖 pi `navigateTree` 与双存储对齐，面更大。

不要把两件揉进同一个 PR。

---

## 9. 刻意不做

- Agent 代插件点「运行命令」。
- 用 Agent 简报替代 Terminal 信任档。
- OS 沙箱、kilo serve、rewind 工作区文件。
- IM/手机上批准（现有：webhook 只出站，批准永不出 IDE）。
- 为 Jenkins 尚未暴露的写 MCP 预做简报豁免。

---

## 10. 规格自检

- 无 TBD：编辑语义（navigateTree + Composer）、人审归属（插件有窗则跳过 Agent 简报）、Database 例外、full trust 不补弹，均已选定。
- 两需求可拆两个计划，互不阻塞。
- 「撤回」不含生产回滚，文案与 notice 写死，避免和 playbook 回滚混淆。
