# 02 · 核心设计 1：嵌入 Hub 与能力插件热注册

## 1. 目标

AT 系列插件 **就是** Agent 的能力插件。安装 / 启用插件 → Bridge `publish` → Agent 工具目录出现。卸载 / 禁用 → `unpublish` → 工具消失。用户在 Agent 设置里 **看不到、也不需要** 「AT Series MCP server」这一项。

## 2. 已验证的插件矩阵（2026-08-28 源码）

| pluginId | 仓库 | MCP 工具 | risk | 确认弹窗 | Skill | 嵌入零改动 |
|----------|------|----------|------|----------|-------|------------|
| `at.terminal` | At-Terminal | 9 | read 5 / write 3 / exec 1 | 有（exec/write） | 有 | **是** |
| `at.jumpserver` | AT-Jumpserver | 14 | read 5 / write 5 / exec 4 | 有 | 有 | **是** |
| `at.grafana` | At-grafana | 17 | 全 read | 无 | 有 | **是** |
| `at.jenkins` | At-jenkins | 7 | 全 read | 无 | 有 | **是** |
| `at.nacos` | At-Nacos | 13 | 全 read | 无 | 有 | **是** |
| `at.database` | At-Database | 12 | read 8 / write 4 | **无（缺口）** | 无 | 可通，错误体需兼容 |

共性（全部符合即可被发现）：

- `bridgeId = crypto.randomUUID()`，每窗口一条
- `token = createBridgeToken()`，请求头 `x-at-series-token`
- `127.0.0.1` 随机端口，`GET /health` `GET /tools` `POST /invoke`
- `FsBridgePublisher.publish` → `~/.at-series/bridges/<hostApp>/<bridgeId>.json`，30s 心跳，`updatedAt` > 90s 视为 stale
- 凭据只在插件 `SecretStorage`
- deactivate 只 `unpublish`，不删 hub.js、不卸 MCP 配置

每实例后台门禁：Grafana / Jenkins / Nacos 的 `allowBackgroundAccess`（默认关）。Agent 必须把 `UNAVAILABLE` + 「请在插件 UI 打开 Allow Agent background access」原文透出，而不是重试或发明 instanceId。

Jenkins / Nacos **MCP 无写工具**。触发构建、发布配置是 IDE 命令。Playbook 对此使用 `GuidedManual` 结局（深链到插件命令），不要在 Agent 里「补一套 MCP 写工具」。

At-Database 两处必须在 HubHost 做兼容（并单独立项催上游）：

1. invoke 失败返回 `HTTP 200 {ok:false}` —— 标准 `bridgeInvoke` 会当成 `INTERNAL_ERROR`。适配层对 `at.database` 若收到 2xx 但 `ok!==true`，按 `INTERNAL_ERROR` 规范化，并把 `message` 透传。
2. `db_execute_query` 标 `write` 却无确认弹窗。Agent 侧审批闸对 `at.database` 的 write **强制会话确认**，不得因 risk 映射 readOnlyHint 放行。

完整工具表见调研 `docs/research/findings/01-*.md` 与 `02-*.md`。

## 3. 运行时嵌入

### 3.1 HubHost 生命周期

```text
Agent activate
  detectHostApp(vscode.env) → hostApp          // vscode | cursor | kiro | …
  new AtSeriesHubHost({ hostApp })
  void host.start()                            // 不阻塞：watch + 后台基线探测
      createHubRuntime({
        hostApp,
        hubVersion: AGENT_HUB_COMPAT_VERSION,  // 仅遥测，不写 hub.js
        discoveryMode: 'auto',
        discoveryThreshold: 20,
        selectionIdleMs: 120_000,              // 嵌入路径用运行时默认，不用 installer 的 0
        selectionMaxCalls: 0,
        audit: { enabled: true },
        onToolsListChanged: () => emit(ToolChangeEvent)
      })

插件 activate
  listen(127.0.0.1:0) → publish(record)
  → fs.watch (150ms debounce) → refreshCatalog
  → health(2s)+tools(5s) → aggregate → onDidChangeTools
  → Capabilities TreeView + 下一轮 LLM 工具集

插件 deactivate
  unpublish() → 工具从暴露集消失
```

**Agent 禁止**：`syncHubBundle`、`ensureAtSeriesMcpConfig`、写 registry、实现 Bridge HTTP。

### 3.2 工具如何进入 LLM

Hub v2 的五个 meta-tools 在嵌入形态下 **不必** 以同名 MCP 工具暴露给模型（避免与 Cursor 里那份混淆）。映射为 HubHost 内部 API + 一组稳定的 Agent 发现工具：

| SuperOps 步骤 | 嵌入形态 |
|---------------|----------|
| `at_list_providers` | 发现工具 `ops_list_providers` **或** 系统已注入健康摘要时跳过 | 
| `at_search_tools` / `at_get_tool` | `ops_search_tools` / `ops_get_tool`（读 `listAllTools()`） |
| `at_select_tools` | `ops_select_tools` → `SelectionController.select`；Playbook 阶段可 **由 Orchestrator 代发**，不占用模型一轮 |
| 刷新 list | `onDidChangeTools` → `session.setActiveTools(exposed)` |
| 一等名 `tools/call` | `HubHost.invoke` → `bridgeInvoke` |
| `at_clear_tool_selection` | 任务 Closed 时 Orchestrator 调用 `selection.clear()`；模型在调查中调用被权限闸拒绝 |

当业务工具数 ≤ `threshold`（默认 20）且 `discoveryMode=auto`：可把当前 winner 业务工具全部设为 active，跳过 select（与 Hub v2 一致）。超过则只暴露发现工具 + 已选中集合。

`setActiveTools` 是 pi 0.83+ ExtensionAPI。HubHost 在工具变更时调用，保证 system prompt 里的 schema 与暴露集一致。

发给 Bridge 的 `name` **必须是协议短名**（`run_remote_command`，不是 `at-series:run_remote_command`）。UI 展示可以带 pluginId 前缀。

### 3.3 选路与多窗口

同 `(pluginId, name)` 多条 Bridge：`(connectedTargets desc, updatedAt desc)`。A 窗口 Agent 可能打到 B 窗口终端——这是 v1 既定行为。UX：

- 目标性工具参数（`serverId` / `terminalId` / `instanceId`）由模型填写，审批 UI 展示解析后的目标标签。
- Capabilities 树按 pluginId 分组，子节点显示 `bridgeId` 短号、`connectedTargets`、健康态。
- 不在 Agent 里「只调用本窗口 Bridge」——那会分裂协议。若未来要亲和性，作为 Hub 选路可选 hint 向上游提，不在第一期做。

### 3.4 hostApp

Agent 与插件必须使用同一个 `detectHostApp()`。实现 **直接调用** `@at-series/mcp-hub` 的 `detectHostApp`，禁止自己 slug 化 `vscode.env.appName`。

| 宿主 | hostApp | 效果 |
|------|---------|------|
| VS Code | `vscode` | 补齐无 installer 的空白 |
| Cursor | `cursor` | 与 Cursor MCP 的 hub.js 并存；去重见 §5 |
| Kiro | `kiro` | 同 Cursor |

错配（Agent 扫 `vscode/` 而插件写在 `cursor/`）表现为 Capabilities 为空。诊断命令 `atOpsAgent.diagnoseHub` 列出：本进程 hostApp、各目录 record 数、`ignoredUnscopedBridgeCount`。

## 4. Bridge 调用语义（嵌入路径必须遵守）

| 项 | 值 |
|----|-----|
| 鉴权 | `x-at-series-token`，常量时间比较（包内已做） |
| 禁止重定向 | `redirect:'error'` |
| 体积 | 双向 2 MiB |
| 超时 | health 2s / tools 5s / invoke **120s**（含插件弹窗） |
| 成功 | `200 { ok:true, name, result }` |
| 失败 | 非 2xx + `{ error:{ code, message, details? } }` |
| 用户取消 | `USER_CANCELLED`（常 499）→ Agent 标 `cancelled`，不是模型错误 |
| failover | 传输失败立即摘桥，同 pluginId 换下一候选 **一次** |
| stale | `updatedAt` 超 90s 跳过探测 |

Agent 取消（用户点停止）必须把 `AbortSignal` 传到 `bridgeInvoke`（`timeoutMs` + abort）。插件侧若已弹出确认框，取消表现为连接中断；HubHost 记 `interrupted`。

## 5. 与用户自定义 MCP 并存

```text
ToolRegistry
  ├─ ToolProvider id=at-series     ← 内嵌 HubHost（不可禁用 AT 发现，可禁用具体 pluginId）
  └─ ToolProvider id=mcp:<name>    ← ~/.at-series/agent/mcp.json
```

去重规则（实现必须单测）：

1. server `name === 'AT Series'`（`MCP_SERVER_DISPLAY_NAME`）→ 跳过 spawn，UI 徽章「内置接管」。
2. `command+args` 规范化后指向 `**/.at-series/mcp/hub.js` → 同样跳过。
3. legacy 名 `AT Terminal` / `AT JumpServer Terminal` 等 → 提示清理，不自动删第三方。
4. AT 工具与外部 MCP 工具短名冲突 → UI 显示 `mcp:<server>/<tool>`；调用外部时用 MCP 名，调用 AT 时用协议短名。

第三方 MCP 的工具爆炸：沿用 pi-mcp 的 `search` + `call` 代理 + `directTools` 白名单，与 Hub 渐进发现是两套机制，不要合成一套 meta-tool。

## 6. 新能力插件接入规范（给插件作者）

Agent 不新增任何插件侧 API。继续遵守：

[at-series-mcp-hub plugin-integration](https://github.com/xwamt/at-series-mcp-hub/blob/main/docs/guides/plugin-integration.md)

最低清单：

1. `pluginId` 匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`
2. 工具名 `^[a-z][a-z0-9_]*$`，带 `risk`
3. Bridge 三端点 + token + 2MiB
4. `publish` / 30s `heartbeat` / `unpublish`
5. write/exec 必须在插件内确认（Database 现状视为缺陷）
6. 凭据不进 result
7. 建议附 `skills/<plugin>-mcp/SKILL.md`，并指回系列 SuperOps，不要宣传 per-plugin MCP 入口

Agent 对未知 `pluginId` **默认启用**（热注册核心体验）。设置项 `atOpsAgent.plugins.autoEnableNew` 默认 true；false 时新 pluginId 进 Capabilities 树为「待启用」，用户点一次才 `select` 得上。

## 7. 建议的 Hub 包增量（非阻塞）

| # | API | 必要性 |
|---|-----|--------|
| 1 | 导出 annotations 映射 | 高，防 Agent 抄一份漂移 |
| 2 | `audit` option 注入 | 高 |
| 3 | `listAllTools` / `getSelectionState` / `getProviders` | 高，否则 callTool 元工具再 JSON.parse |
| 4 | 修 `getServer?` 类型漂移 | 中 |

第一期可用现有 `createHubRuntime` + `callTool('at_list_providers')` 撑住，适配层做 JSON 解析。第二期再升 Hub 0.4。

## 8. 能力视图数据

Capabilities TreeView 数据源 = `HubHost.getProviders()` + `listAllTools()`，**不是** MCP `tools/list`（那是渐进后的暴露集）。

节点：

```text
AT Grafana          healthy · 1 instance Agent-enabled · 17 tools · read
  grafana_query_prometheus    read
  …
AT Terminal         healthy · 2 connected · 9 tools · read/write/exec
AT Jenkins          unhealthy · bridge stale  —  [打开插件]
（空）              welcome: 安装 AT 系列插件后将自动出现在这里
```

健康态着色见 UI 规范。`onDidChangeTools` 刷新树；badge = unhealthy 数量。
