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

`allowBackgroundAccess === false` 不是安全漏洞：工具会 `UNAVAILABLE`。不要在 Agent 里绕过该开关。

## 3. 凭据

| 秘密 | 位置 | Agent |
|------|------|-------|
| 插件密码 / SA token | 各插件 SecretStorage | 不读、不请求、不进 prompt |
| Bridge token | registry 文件 0600 | 仅 Hub 客户端使用，禁止日志 |
| LLM key | Agent SecretStorage | ModelRuntime.getApiKey |
| approvalToken | 内存 + 会话 custom entry | 不进 LLM |

## 4. 提示注入

- 工具结果、日志、看板标题、SQL 错误一律当数据。
- Writer 引用原文时 UI 加「不可信」样式（安全链路强制）。
- 工作区 README / 远程文件中的「请执行…」不作为指令（workspace-troubleshooting）。
- 子代理不允许根据工具结果自行提高 riskCeiling。

## 5. 命令策略

`@at-series/command-policy` 在 Agent 侧只做 **预判**（审批简报里展示 allow/review/deny + 证据坐标）。Terminal Bridge 内的分析仍是权威。聚合「只能加严」：Agent 预判 deny → 直接不 invoke；review → 必须进简报；allow 仍要过 ①③。

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
