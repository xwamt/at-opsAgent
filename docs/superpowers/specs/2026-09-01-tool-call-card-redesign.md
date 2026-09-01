# 工具调用卡三行布局 + 结构化结果

> **日期：** 2026-09-01  
> **状态：** 已确认  
> **范围：** `at-opsAgent` 聊天 Webview 的 `ToolCallCard` / `TerminalViewer` / preview 解析  
> **已确认方向：** 命令卡三行叠栏（方案 A）；普通工具剥壳 + 专用视图 + 键值回退（方案 1）

---

## 1. 问题：上次 UI 改动为什么看起来「没生效」

当前线上（用户截图，浅色主题）已经是 `ToolCallCard` + `TerminalViewer`：

- 标题：`run_remote_command` + `at.terminal` + 红徽标「执行」+ 「成功」+ `265ms`
- 正文：**没有命令栏**，只有「终端输出 1 行」
- 那一行是 **Hub 信封 JSON**，不是 stdout

真实 `preview`（截图原文，仅排版）：

```json
{
  "ok": true,
  "result": {
    "serverId": "4d1fbefc-aeef-42e9-9008-62c04915affe",
    "serverLabel": "99.90",
    "host": "192.168.99.90",
    "command": "hostname",
    "exitCode": 0,
    "stdout": "cl\n",
    "stderr": "",
    "durationMs": 258,
    "timedOut": false,
    "truncated": false
  },
  "attemptCount": 1,
  "durationMs": 261
}
```

源码里命令栏（`tool__cmd-bar`）和意图标题（`磁盘 · df -h`）**已经写了**，但解析器只认**顶层** `command` / `stdout` / `serverName`。生产回包把这些放在 `result.*`，主机字段名是 `serverLabel` 不是 `serverName`。于是：

| 期望 | 实际（截图） |
|------|----------------|
| 标题「99.90 · …」 | `run_remote_command` |
| 第二行 `$ hostname` | 命令栏 `v-if="commandText"` 为假，整段不渲染 |
| 终端里 `cl` | 整段信封被当成 `rawText`，JSON 压成 1 行 |

单测用的是虚构扁平 JSON（`{command, stdout, exitCode}`），所以测试绿、界面仍是 JSON。这是本次必须堵住的洞：**测试夹具 = 截图这种 Hub 信封，不允许再用扁平假数据当主路径。**

`tool/start` 的 preview 是 `JSON.stringify(args)`；`tool/update` / `tool/end` **整段覆盖** preview。流式一旦来了，命令也会从 preview 里消失。只改 Vue 模板、不改解析与字段留存，会再次「改了跟现在一样」。

---

## 2. 目标与非目标

**目标**

1. `run_remote_command`（及同类命令工具）三行叠栏：标题 / 命令 / 终端。折叠整卡时只留标题。
2. 标题 = 主机 + 执行目的（命令里的 `# Purpose:`；没有则回退意图表）。
3. 终端只渲染 `stdout`/`stderr`，实时贴底；禁止把信封 JSON 当终端内容。
4. 普通工具（如 `list_ssh_servers`）剥壳后结构化展示，不再 pretty-print 整包 JSON。
5. 解析与单测以**生产信封**为准，避免 UI 再空转。

**非目标**

- 不改 Terminal 插件 / Bridge 的返回形状。
- 不做左右分栏（侧栏宽度不够）。
- 不为每个 MCP 工具写专用视图；未知工具走通用键值/表格。
- 不把 `# Purpose:` 当审批依据（策略仍走 command-policy）。

---

## 3. 命令卡：三行叠栏（方案 A）

侧栏宽度约 360–420px，三行全宽叠加，不是三列。

```
┌─────────────────────────────────────────────┐
│ ▾  ● 99.90  ·  检查主机名     只读  ✓ 265ms │  ← 行1 标题，折叠后仍在
├─────────────────────────────────────────────┤
│ ▾  $ hostname                        [复制] │  ← 行2 命令，可单独折
├─────────────────────────────────────────────┤
│ 终端输出  1 行                    exit: 0   │  ← 行3 现有 TerminalViewer
│  1  cl                                      │
└─────────────────────────────────────────────┘
```

### 3.1 行 1 · 标题栏

始终可见。点击切换整卡展开/折叠（与现在 `tool__head` 相同）。

显示顺序：chevron · 主机 · Purpose 或意图 · 风险徽标 ·（spacer）· 状态 · 耗时。

- **主机：** `serverLabel` → `serverName` → `host` → `label`。有 label 时 `host` 可放 title 提示（`192.168.99.90:22`）。
- **目的：** 从命令正文解析 `# Purpose:` / `# Purpose ：`（允许全角冒号、前后空白）。多行命令只取第一条 Purpose。
- **无 Purpose：** 回退现有 `COMMAND_INTENT_ZH`（`hostname` →「主机」）。意图与主机都没有时才显示工具短名。
- **风险：** 继续用 `call.risk`（policy 推断后的值）。只读命令显示「只读」。
- 插件 id（`at.terminal`）不进标题正文，放在 `title` 属性，避免再占一行把 Purpose 挤掉。

折叠态必须能回答：哪台机器、干什么、成功没有。截图那种折叠后只剩 `run_remote_command` 视为失败。

### 3.2 行 2 · 命令

独立折叠，方案 A：**默认展开**。长命令折行（`pre-wrap`），不要只用单行 ellipsis 把中间吃掉。

- 展示去掉 Purpose 注释后的命令正文。
- 左侧 `$`，右侧复制按钮（复制正文，不含 Purpose 行也可以复制「含注释的原始命令」——采用**复制原始命令**，与终端里实际执行的字符串一致）。
- 无命令时（解析失败）隐藏本行，不得渲染空 `$`。

### 3.3 行 3 · 终端

继续用 `TerminalViewer.vue`（ANSI、光标、贴底、exit、截断打开编辑器）。

- `text` = `stdout`，若有 `stderr` 则追加（中间空行或 `stderr:` 前缀，二选一：**有 stderr 且非空时在 stdout 后空一行再写 stderr**）。
- `exitCode` 来自 `result.exitCode`。
- `isRunning` 时保持呼吸光标；stdout 随 `tool/update` 增长。
- **禁止**把 `ok` / `attemptCount` / 整段 `result` 对象塞进终端。

### 3.4 折叠默认值

与现在一致：默认折叠整卡；`write`/`exec` 且 `status===running` 时自动展开。成功后不强制展开。命令行在整卡展开时默认展开（方案 A，不是成功后自动收起）。

---

## 4. 数据怎么接到三行上（这次生效的关键）

### 4.1 冻结入参，输出走 preview

`ToolCallView` 增加可选字段 `inputPreview?: string`。

| 事件 | 行为 |
|------|------|
| `tool/start` | `inputPreview = args` 的 JSON（现有 start preview）；`preview` 可同值或空 |
| `tool/update` | **只改** `preview`（流式 stdout / 部分结果）。`inputPreview` 不变 |
| `tool/end` | **只改** `preview`（最终 Hub 信封）。`inputPreview` 不变 |

`pickToolCall` / `upsertTool` / `runtimeEvents` / schema 副本必须带上 `inputPreview`。hydrate 回放同样保留。

没有 `inputPreview` 的旧会话：解析器仍能从 end 信封的 `result.command` / `result.serverLabel` 恢复标题与命令（截图那种已结束卡片仍能美化）。Purpose 若只存在于 start args、结果里的 `command` 已被剥成 `hostname`，旧卡片会走意图回退——可接受。

### 4.2 统一拆信封：`parseToolOutputPreview`

输入：`inputPreview` + `preview`（end/update）。输出结构化字段，**不要把信封当 stdout**。

拆包规则（按序）：

1. 若字符串是 JSON 对象，且同时有 `ok`（boolean）与 `result` 键 → 载荷 = `result`，元数据 = `{ok, attemptCount, durationMs}`。
2. 若 `result` 是字符串，当作 stdout 文本。
3. 若 `result` 是对象，从对象取字段（见下）。
4. 否则按现有：顶层 `command` / `stdout` / …（兼容旧扁平夹具与 start args）。

命令工具字段（在载荷或顶层找，先 input 后 result，result 覆盖主机/退出码/输出，**不覆盖**已解析出的 Purpose——Purpose 取「input 命令 ∪ result.command」里第一条 `# Purpose:`）：

| 逻辑字段 | 候选键 |
|----------|--------|
| command | `command`, `script`, `query`, `cmd` |
| hostLabel | `serverLabel`, `serverName`, `label`, `server` |
| hostAddr | `host`, `ip`, `target` |
| exitCode | `exitCode`, `code` |
| stdout | `stdout`, `output`（仅当值为 string） |
| stderr | `stderr` |

`result` 为对象且没有 string stdout 时：**不得** `JSON.stringify(result)` 进终端。命令工具走空输出；数据工具走结构化渲染。

### 4.3 Purpose 解析

对命令字符串：

- 匹配行：`^\s*#\s*Purpose\s*[:：]\s*(.+?)\s*$`（忽略大小写）
- 展示用命令 = 去掉所有 Purpose 注释行后 trim
- 标题用 Purpose = 第一条捕获组

Agent 没写 Purpose 时：标题 `99.90 · 主机`（意图表）+ 命令行 `$ hostname`。

---

## 5. 普通工具结果（方案 1）

同一套拆信封。命令类（`isCommandToolCall`）走三行卡；其余走数据面板。

### 5.1 `list_ssh_servers`

用户示例：`{ok, result: {servers: [...]}, attemptCount, durationMs}`。

标题：`SSH 目标` + `N 台`（已连接数可写在副文案）。  
正文：每台一行卡片：圆点（connected）· label · `host:port` · username；次行「已连接/未连接 · 信任 {agentCommandTrust} · 自动批准/需批准」。  
不展示 `id` UUID（放 title 即可）。  
页脚：`attemptCount` + 信封 `durationMs`（与卡片耗时重复则只保留卡片耗时）。

### 5.2 通用回退（未知工具）

对拆壳后的载荷：

1. 对象且含 `servers` 数组（元素有 `host` 或 `label`）→ 复用主机列表。
2. 对象数组、键集合相近 → 表格（列 = 键；`id`/`uuid` 列默认隐藏，hover title 显示）。
3. 普通对象 → 键值表。值为对象/数组时该格折叠 JSON，不要整页墙。
4. 解析失败或纯标量 → 现有 pretty JSON。

页脚可显示 `ok` 为 false 时的错误；成功态不把 `ok:true` 当正文。

---

## 6. 组件边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| `unwrapHubPayload(raw)` | 拆 `{ok,result}`，纯函数 | 无 |
| `parseCommandPurpose(command)` | Purpose + 正文 | 无 |
| `parseToolOutputPreview(preview, inputPreview?)` | 命令/主机/stdout/数据载荷 | 上两者 |
| `toolCallHeadline(call)` | 标题字符串，走拆包后的 host+purpose | parse\* |
| `ToolCallCard.vue` | 三行布局；命令类 / 子代理 / 数据 三分支 | TerminalViewer, parse\* |
| `ToolDataPanel`（可留在 Card 内或小文件） | 主机列表 / 表 / 键值 / JSON 回退 | 载荷对象 |
| `TerminalViewer.vue` | 不改协议；只吃纯文本 stdout | 现有 |

Host：`runtimeEvents.ts` 在 start 写入 `inputPreview`；update/end 补丁不得带 `inputPreview: undefined` 把它清掉。`store.ts` `Object.assign` 只赋定义了的键（现有 pick 已跳过 undefined——补丁里不要显式传空）。

协议：`src/protocol/host-protocol.ts` 与 `docs/schemas/host-protocol.ts` 同步加 `inputPreview?`。

---

## 7. 错误与运行中

- `status===error`：三行仍按能解析的字段渲染；终端下保留现有错误条（`errorCode` / `errorMessage`）。
- `ok:false` 信封：不要把 `error` 对象 JSON 当 stdout；错误条优先 `error.message`。
- 运行中尚无 stdout：终端空态用现有「正在…」+ 主机名（若已有 label）。
- 超 4KB preview：仍截断 + artifact 链接；截断不得把解析器切回「整段当一行」。

---

## 8. 测试合同（防止再次空转）

`test/webview-chat.test.ts`（及必要时 `runtime-events`）必须包含：

1. **截图夹具：** 第 1 节完整信封 → `hostLabel==='99.90'`，`command==='hostname'`，`stdout==='cl\n'`，`exitCode===0`，headline 含 `99.90` 且 **不含** 整段 JSON，且不等于裸 `run_remote_command`。
2. **Purpose：** `command` 为 `"# Purpose: 检查磁盘\ndf -h"`（可在 inputPreview 或 result.command）→ 标题含「检查磁盘」，命令正文为 `df -h`，终端不是 JSON。
3. **list_ssh_servers 夹具：** 用户第一条消息里的 servers 数组信封 → 解析后是数组而不是把 `ok/attemptCount` 当正文；至少能读出两台 label `99.90` / `99.92`。
4. **覆盖不丢入参：** start 写入 `inputPreview` 后 end 只带 result 信封 → Purpose/命令仍在。
5. 旧扁平 `{command,stdout}` 仍能解析（回归）。

禁止再把「顶层 `{command, stdout}`」当作 `run_remote_command` 的**唯一**成功用例。

---

## 9. 验收

用真实会话或 mock-host 打出与截图同结构的 end preview 后：

- [ ] 标题能读出主机 + 目的（或意图回退），不是 `run_remote_command`
- [ ] 第二行是 `$ hostname`（或真实命令），可单独折叠
- [ ] 终端内容是 `cl`（或真实 stdout），行数与 stdout 行数一致，不是「1 行 JSON」
- [ ] 折叠整卡后标题仍有主机与目的
- [ ] `list_ssh_servers` 看到主机列表，看不到 `attemptCount` 当正文
- [ ] `npm test` 含第 8 节夹具且绿
- [ ] 改完后执行 `npm run compile:webview`（或 `npm run compile`），用新 bundle 打开聊天侧栏验收；只改 `.vue` 不重编会再次表现为「没生效」
