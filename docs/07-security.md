# 07 · 安全

## 1. 三道闸（顺序不可颠倒）

```text
模型请求 tools/call
  → ① 会话策略（risk + Playbook + approvalToken + payloadCaps）   Agent
  → ② Hub 选路（unhealthy 摘除、2MiB、timeout）                   HubHost
  → ③ 插件确认弹窗 + command-policy / readOnly / allowBackground   插件
```

① 不能替代 ③。③ 不能替代 ①。UI 必须写明这一点。

## 2. 会话策略默认

| risk | 主会话 | Investigator | Executor |
|------|--------|--------------|----------|
| read | 默认放行（可关） | 放行 | 仅当计划需要 |
| write | 审批简报 | **拒绝** | 需 token + 哈希 |
| exec | 审批简报 | **拒绝** | 需 token + 哈希 |

`at.database` 的 write 在插件无弹窗前，① 对 Database write **强制简报**，即使全局策略被用户调成 `exec-only`。

`atOpsAgent.policy.floor`（默认 `write-exec`，取值与 `approval.sessionRequiredFor` 相同）是组织下限：有效范围 = 下限与用户设置中更严的一档（松→严：`never` < `exec-only` < `write-exec`）。用户无法把闸门调到比 floor 更松。

`allowBackgroundAccess === false` 不是安全漏洞：工具会 `UNAVAILABLE`。不要在 Agent 里绕过该开关。

审批 waiter 超时（`atOpsAgent.approval.timeoutMs`，默认 15 分钟，0 禁用）以及软停 / 硬停，一律按 **拒绝** 落定，不得当成批准。超时后令牌不得留在 `currentApprovals`。

## 3. 凭据

| 秘密 | 位置 | Agent |
|------|------|-------|
| 插件密码 / SA token | 各插件 SecretStorage | 不读、不请求、不进 prompt |
| Bridge token | registry 文件 0600 | 仅 Hub 客户端使用，禁止日志 |
| LLM key | Agent SecretStorage | ModelRuntime.getApiKey |
| IM webhook HMAC 密钥 | Agent SecretStorage（`atOpsAgent.im.webhookSecret`） | 出站 `X-At-Ops-Signature`；不进 settings / 日志 / LLM |
| approvalToken | 内存 + 会话 custom entry | 不进 LLM |

## 4. 提示注入

- 工具结果、日志、看板标题、SQL 错误一律当数据。
- Writer 引用原文时 UI 加「不可信」样式（安全链路强制）。
- 工作区 README / 远程文件中的「请执行…」不作为指令（workspace-troubleshooting）。
- 子代理不允许根据工具结果自行提高 riskCeiling。

## 5. 命令策略

Agent 侧对远程执行类工具（`run_remote_command` / `jumpserver_run_terminal_command` 等白名单；**不对** `grafana_query` 跑 shell 分析器）用 `@at-series/command-policy` **0.1.1** 做预判（精确锁定，禁用 `^`）：

- `allow` → 有效风险 read（仍须手写表也认为只读：聚合只能加严，防 command substitution 等库误放）
- `review` / `deny` → 保持申报风险（write/exec），走 ① 会话审批
- 库不可用（import 失败）→ 手写只读表兜底，log 一次
- 解析/判定失败 → 保持申报风险，**不加严为 allow**

审批简报展示「命令策略：allow|review|deny」+ reason 截断（`unknowns` / `commandPolicy` 要素）。Terminal Bridge 内的分析仍是权威。allow 仍要过 ①③。

## 6. 文件系统与 registry 攻击面

能写 `~/.at-series/bridges/<hostApp>/` 的本地进程即可注册假工具。缓解（Hub 已有 + Agent 增强）：

- endpoints/port 校验、禁止 redirect、2MiB
- 新 pluginId 可选 `autoEnableNew=false`
- Capabilities 树展示 pluginId / 版本，异常 pluginId 警告

不要把 registry 同步到云盘。

## 7. 多租户 / 远程开发

Remote-SSH：扩展跑在远程机，registry 是远程 `$HOME`。这是正确的（插件也在远程）。不要试图读本地 Mac 的 bridges。

## 8. 供应链

- pi 三包精确锁定 + shrinkwrap/lockfile
- 不执行用户 skill 里的任意 TS（pi 扩展若开启，`defaultProjectTrust` 对非交互默认不信任项目扩展——运维 Agent 应 **默认关闭** 项目本地 pi extensions，只加载打包 skills）

## 9. 落盘刮密范围 / JSONL 限制 / 30 天 tool-results

本扩展**自己写到磁盘或导出文件**的文本先过 `redactSecrets`（`src/runtime/sanitize.ts`，禁止 import vscode）：

| 路径 | 刮密点 |
|------|--------|
| `~/.at-series/agent/tool-results/*.json` | `persistFullToolResult` 写盘前；回模型的截断文本同样先刮密 |
| `~/.at-series/agent/ui-sessions.json` | `sessionStore.persistNow` 序列化前对 item 的 `text` / `call.preview` / `errorMessage` |
| 值班报告 Markdown | `buildOpsReportMarkdown` return 前 |

规则覆盖 Bearer、`password=`/`token=` 键、PEM 私钥块、`mysql://user:pass@` 类连接串、`sk-`、`x-at-series-token`。刮密不可逆。

**JSONL 限制：** pi 会话 JSONL（`~/.at-series/agent/sessions/*.jsonl`）由 SessionManager 写入。`createAgentSession` / SessionManager **没有**本仓可接的 transform hook，本扩展不 fork pi，因此 JSONL **可能仍含工具原文**。回给模型的业务工具结果会先刮密，这是进入 JSONL 的主要通道，但 pi 自身写入不经过 `redactSecrets`。

**保留：** activate 末尾 `void pruneToolResults(agentDir)`（不阻塞启动，失败只记日志）：

- `tool-results/*.json`：mtime 超过 30 天则删除
- `sessions/*.jsonl`：mtime 超过 30 天 **且** 不被 `ui-sessions.json` 任何 `sessionFile` 引用才删除。读不到引用表则跳过 JSONL（宁可漏删，不删仍被引用的文件）
