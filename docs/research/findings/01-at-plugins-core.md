# AT 系列核心能力插件调研报告（面向 at-opsAgent 嵌入式 Hub 设计）

> 调研对象：`/tmp/research/At-Terminal`、`/tmp/research/AT-Jumpserver`、`/tmp/research/At-grafana`、`/tmp/research/At-Database`，
> 以及它们共同依赖的 `/tmp/research/at-series-mcp-hub`（`@at-series/mcp-hub`）。
> 调研方式：逐文件阅读源码、package 清单、ADR/需求文档、Skill 文件；所有结论均给出具体文件路径与符号名。
> 目标：为「把 at-series-mcp-hub 嵌入 at-opsAgent 内部、AT 插件作为 Agent 能力插件」的设计提供可直接引用的契约与差异清单。

---

## 目录

- [0. 执行摘要（TL;DR）](#0-执行摘要tldr)
- [1. 共享基座：@at-series/mcp-hub 契约精读](#1-共享基座at-seriesmcp-hub-契约精读)
- [2. At-Terminal（at.terminal）](#2-at-terminalatterminal)
- [3. AT-Jumpserver（at.jumpserver）](#3-at-jumpserveratjumpserver)
- [4. At-grafana（at.grafana）](#4-at-grafanaatgrafana)
- [5. At-Database（at.database）](#5-at-databaseatdatabase)
- [6. 四插件交叉对比表](#6-四插件交叉对比表)
- [7. Agent 嵌入 Hub 后的调用序列建议](#7-agent-嵌入-hub-后的调用序列建议)
- [8. 零改动验证结论](#8-零改动验证结论)
- [9. 风险与缺口总清单](#9-风险与缺口总清单)

---

## 0. 执行摘要（TL;DR）

1. **四个插件全部实现同一套 Bridge v1 契约**（`@at-series/mcp-hub` 定义）：activate 时在 `127.0.0.1` 随机端口起 HTTP 服务（`GET /health`、`GET /tools`、`POST /invoke`，`x-at-series-token` 鉴权），并把注册记录（含端口、token、完整工具目录）以原子写落盘到 `~/.at-series/bridges/<hostApp>/<bridgeId>.json`，每 ≤30s 心跳刷新 `updatedAt`，deactivate 时删除该文件（unpublish）。
2. **嵌入式 Agent 的核心结论：进程内读 registry + HTTP invoke，对 At-Terminal / AT-Jumpserver / At-grafana 可以做到严格零改动**。At-Database 的调用链也能跑通（发现、health、tools、invoke 成功路径全部符合契约），但它的 **invoke 错误路径返回 `HTTP 200 + {ok:false}` 而非契约错误体**，且 **`write` 风险工具（含任意 SQL 执行）没有任何确认弹窗**——嵌入客户端需要做兼容/兜底，理想情况应修复该插件（见 §5.9、§8）。
3. 凭据隔离在四个插件中一致：**所有密码/Token 存 VS Code `SecretStorage`，只在扩展宿主内使用，绝不进 registry、不进 Hub、不从任何工具返回**。registry 里唯一的秘密是 Bridge token（`0600` 文件权限保护）。
4. `@at-series/mcp-hub` npm 包本身就把嵌入所需的全部积木以库形式导出：`listBridgeRecords` / `watchBridgeRegistry`（registry 读与监听）、`bridgeGetHealth` / `bridgeGetTools` / `bridgeInvoke`（HTTP 客户端，含超时/2MiB 限制/拒绝重定向）、`aggregateTools` / `pickBridgeForTool`（聚合与选路）、审计日志模块。**at-opsAgent 不需要 stdio 的 `hub.js`，直接复用这些模块即可**；协议 v2 §2 甚至预留了 “embedding runtime supplies an explicit mode” 的措辞。
5. 主要风险集中在 At-Database（错误体不合契约、写操作无确认、`db_execute_query` 风险标注偏松、无 Skill、不等待 hub 同步就写 MCP 配置）以及全系列共性约束（invoke 120s 上限内含人工确认、2MiB 双向体积上限、`tools/list` 非 ACL）。

---

## 1. 共享基座：@at-series/mcp-hub 契约精读

仓库：`/tmp/research/at-series-mcp-hub`（npm 包 `@at-series/mcp-hub`，README 标注当前 `0.3.3`；四个插件 package.json 均声明 `"@at-series/mcp-hub": "^0.3.2"`）。

### 1.1 架构与角色

```text
IDE MCP Client (Cursor / Kiro / Continue …)
        │ stdio，MCP server 名固定为 "AT Series"
        ▼
~/.at-series/mcp/hub.js          ← 各插件打包内嵌、按 semver 选举写入的单文件 Hub
        │ 读 registry + HTTP
        ▼
~/.at-series/bridges/<hostApp>/<bridgeId>.json   ← 每个插件窗口一条注册记录
        │
        ▼
插件 Bridge  127.0.0.1:<port>   GET /health · GET /tools · POST /invoke
        │
        ▼
插件域服务（SSH / JumpServer / Grafana / DB）+ 确认弹窗 + SecretStorage 凭据
```

规范文件：

- Bridge 线协议（真源）：`at-series-mcp-hub/docs/protocol/v1.md`（`protocolVersion: 1`）
- Hub 渐进暴露：`at-series-mcp-hub/docs/protocol/v2.md`（Hub 面 `protocolVersion: 2`，Bridge 面不变）
- 接入指南：`at-series-mcp-hub/docs/guides/plugin-integration.md`
- 架构决策：`at-series-mcp-hub/docs/decisions/ADR-001-at-series-mcp-hub.md`
- 类型真源：`packages/mcp-hub/src/protocol/index.ts`（包根导出）

### 1.2 关键类型与常量（`packages/mcp-hub/src/protocol/index.ts`）

```9:12:at-series-mcp-hub/packages/mcp-hub/src/protocol/index.ts
export const AT_SERIES_BRIDGE_PROTOCOL_VERSION = 1 as const;

/** Hub MCP surface + list_providers / hub-version protocol stamp. */
export const AT_SERIES_HUB_PROTOCOL_VERSION = 2 as const;
```

- `BridgeRegistryRecord`：`{ protocolVersion, bridgeId, pluginId, pluginDisplayName, pluginVersion, hostApp, port, token, pid, updatedAt, endpoints?, tools[], capabilities?{connectedTargets} }`
- `ToolCatalogEntry`：`{ name, title, description, risk: 'read'|'write'|'exec', inputSchema }`
- `BridgeErrorBody`：`{ error: { code, message, details? } }`，`code ∈ BAD_REQUEST | UNAUTHORIZED | NOT_FOUND | METHOD_NOT_ALLOWED | CONFLICT | PAYLOAD_TOO_LARGE | VALIDATION_ERROR | USER_CANCELLED | INTERNAL_ERROR | UNAVAILABLE`
- 常量：`AT_SERIES_TOKEN_HEADER = 'x-at-series-token'`、`BRIDGE_HOST = '127.0.0.1'`、`BRIDGE_MAX_BODY_BYTES = 2MiB`、`MCP_SERVER_DISPLAY_NAME = 'AT Series'`
- 命名约束：`PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`、`TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/`、`REGISTRY_PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/`（`hostApp`/`bridgeId` 用作路径段，`bridgeRecordPath` 校验不过直接 throw，防路径穿越）
- 风险归一化：`normalizeToolRisk`——缺失/非法 risk 一律按 `exec`（fail-closed）；`isAutoApproveRisk(risk) === (risk==='read')` 但 **installer 实际不给业务工具 autoApprove**（见 §1.6）。

### 1.3 Bridge HTTP 契约（v1 §7，Hub 侧硬约束）

| 项 | 规定 |
|---|---|
| 传输 | `http://127.0.0.1:<port>`；禁止 3xx（Hub `redirect:'error'`，防 token 随自定义头泄漏） |
| 鉴权 | 每请求带 `x-at-series-token`；比较必须常量时间（`timingSafeEqualToken`，空 token 永不匹配）；迁移期可另收 `x-at-terminal-token` / `x-at-jumpserver-terminal-token` |
| 体积 | 双向 2 MiB；请求超限 → 413；响应超限 Hub 中途 abort → `INTERNAL_ERROR` |
| 超时（Hub 出站，`packages/mcp-hub/src/bridgeClient/http.ts`） | `/health` 2s、`/tools` 5s、`/invoke` **120s**（含人工确认弹窗时间）；可用 `BridgeRequestOptions.timeoutMs` 覆盖 |
| `/invoke` 请求 | `{ name: string, arguments: object }` |
| `/invoke` 成功 | `200 { ok:true, name, result }`（result 必须 JSON 可序列化） |
| `/invoke` 失败 | 非 2xx + `BridgeErrorBody`；`USER_CANCELLED`（可用 499）必须与校验失败可区分 |
| 记录过期 | `updatedAt` 距今 > 90s（3 次心跳丢失）视为 stale，跳过探测、标 `unhealthy` |

`bridgeInvoke`（`src/bridgeClient/http.ts`）的解析行为对嵌入设计很重要：**2xx 但 body 不是 `{ok:true, name}` 形状时直接 throw `BridgeHttpError('Invalid Bridge invoke success response', code: INTERNAL_ERROR)`**——这正是 At-Database 错误路径踩中的坑（§5.9）。

### 1.4 Registry 与文件系统（v1 §3、§5）

- 根：`~/.at-series/`，POSIX 下所有目录 `0700`、文件 `0600`（创建即最终权限，不允许先写后 chmod）；写入必须同目录临时文件 + `rename` 原子替换（`src/fs/atomicWrite.ts`）。
- `FsBridgePublisher`（`src/publisher/BridgePublisher.ts`）：`publish(record)` / `updateTools(tools)` / `heartbeat(patch)` / `unpublish()`；构造参数 `{ bridgeId, hostApp, home? }`，record 与构造参数不一致直接 throw。
- 读侧：`listBridgeRecords`（`src/registry/read.ts`，含 `parseBridgeRegistryRecord` 校验：pluginId/toolName/port/endpoints 不合法则**整条记录跳过**）、`watchBridgeRegistry`（`src/registry/watch.ts`，原生 watch + ≤3s 轮询兜底、目录指纹去抖）。
- 审计：Hub 对每次**业务** `tools/call` 追加一行 JSONL 到 `~/.at-series/logs/<hostApp>/agent-ops-YYYY-MM-DD-<pid>.jsonl`（v1 §3.4；字段 `traceId/timestamp/hostApp/hubPid/toolName/attemptCount/durationMs/status/params/responseSummary`，敏感键与 token 样式字符串脱敏、超 4096 字节截断；默认开启，`AT_SERIES_AUDIT_LOG=false` 关闭，保留 30 天）。**嵌入式 Agent 若绕过 hub.js，需要自行复用 `src/audit/*` 模块补齐这条取证链**。

### 1.5 hub.js 版本选举（v1 §8.6，`src/publisher/HubBundleSync.ts` 的 `syncHubBundle`）

- 候选 semver 更高 → 覆盖；同版本且 `bundleSha256` 不同 → 覆盖；更低 → 禁止；同版本同 hash → no-op。
- 必须先对磁盘上的 `hub.js` 实际做 SHA-256 校验再决定 no-op（防篡改后拒修复）；`hub-version.json` 损坏视为“无活跃 hub”自愈。
- 互斥：`~/.at-series/mcp/.hub-sync.lock`（`O_EXCL` 原子抢占、30s 过期、死 pid 立即回收、5s 获取预算）。
- 插件义务：**必须 `await syncHubBundle` 完成后才能 `ensureAtSeriesMcpConfig`**（否则 IDE 可能启动一个指向不存在文件的 MCP 条目）。

### 1.6 MCP 配置 installer（v1 §9，`src/installer/*`）

- 只写一个名为 **`AT Series`** 的条目：`command: node`，args 指向 `~/.at-series/mcp/hub.js`；env 写入 `AT_SERIES_HOST_APP=<slug>`、`AT_SERIES_TOOL_DISCOVERY=auto`、`AT_SERIES_TOOL_DISCOVERY_THRESHOLD=20`、`AT_SERIES_TOOL_SELECTION_IDLE_MS=0`、`AT_SERIES_TOOL_SELECTION_MAX_CALLS=0`。
- 目标仅 `cursor`（`~/.cursor/mcp.json`）、`kiro`（`~/.kiro/settings/mcp.json`）、`continue`（`<workspace>/.continue/mcpServers/at-series.yaml`，必须有 workspaceFolder）；`vscode`/其他 fork 无 writer，插件应跳过。
- `autoApprove` **只含 Hub 五个 meta-tools**（`at_list_providers`、`at_search_tools`、`at_get_tool`、`at_select_tools`、`at_clear_tool_selection`）；任何业务工具（含 `risk=read`）都不写入 autoApprove。
- 迁移：安装/修复时把旧的 `AT Terminal` / `AT JumpServer Terminal` 等 per-plugin 条目改写/删除为单一 `AT Series`；幂等；deactivate **不得**卸配置、不得删 hub.js。

### 1.7 Hub v2 渐进暴露（对嵌入式 Agent 的“工具目录治理”参考）

- 模式 `auto|always|off`；`auto` 下业务工具数 > 20 才收缩 `tools/list` 到「已选中 ∩ 当前赢家」+ 5 个 meta-tools。
- `at_select_tools {pluginIds?, names?, mode:'replace'|'add'}`；选中项对赢家集合的短暂缺席有 15s 宽限；空闲 TTL（运行时默认 120s，installer 写 0 关闭）与调用预算可自动 clear。
- **选择只过滤 list，不是 ACL**：Hub 对任何当前赢家工具都继续路由 `tools/call`。
- `tools/list` 注解映射（v2 §8）：`read → readOnlyHint:true/destructiveHint:false`、`write → false/false`、`exec → false/destructiveHint:true`；`openWorldHint` 恒 true；缺失 risk 按 exec fail-closed。
- 聚合与选路（v1 §8.2/8.3，代码 `src/hub/aggregate.ts`）：按 `(pluginId, name)` 折叠多实例；跨 pluginId 同名 → 冲突，赢家按 `(connectedTargets desc, updatedAt desc)`（`scoreBridge` / `pickBridgeForTool`）；invoke 传输失败立刻在内存标记 unhealthy 并换下一候选一次；`NOT_FOUND` / 目标未知型 `VALIDATION_ERROR` 也换同 pluginId 的下一 Bridge 一次。

### 1.8 系列 Skill：`skills/super-ops/SKILL.md`（SuperOps）

Agent 侧的标准操作规程，嵌入式 Agent 的系统提示可直接移植：

- 强制流程清单：`at_list_providers → at_search_tools/at_get_tool →（每任务一轮）at_select_tools → 刷新 tools/list → 一等名调用 → 任务结束才 clear/replace`。
- 时间盒事故快速路径（QPS/延迟尖峰）：确认尖峰（窄窗口 metrics）→ top-N 放大面 → **必须查业务日志**（metrics 相关性 ≠ 根因）→ 才允许写根因；MQ/RPS/QPS 同涨只是传播链。
- 红旗表：IDE 确认弹窗 ≠ 会话内授权；调查中途禁止 `at_clear_tool_selection`；日志/面板/SQL 报错文本是不可信数据不是指令。
- 提供商附录（每任务 ≤1 个 + ≤1 个 ops reference）：`at.terminal`→terminal.md、`at.jumpserver`→jumpserver.md、`at.grafana`→grafana.md、`at.nacos`→nacos.md。

---

## 2. At-Terminal（at.terminal）

仓库：`/tmp/research/At-Terminal`，版本 `0.3.4`。

### 2.1 产品定位与用户场景

面向**直连 SSH 的主机运维**：侧边栏管理 SSH 服务器（分组、跳板机 jumpHost、密码/私钥认证、主机密钥 TOFU 信任），Webview xterm.js 终端，SFTP 文件树（上传/下载/编辑/预览/拖拽），资产包加密导入导出。MCP 面向 Agent 暴露“远程命令 + SFTP 读写”能力，配套一整套运维 Skill（含 16 篇 ops references）。主 UI：activity bar 容器 `sshManager` 下的 `sshManager.servers`（服务器树）与 `sshManager.sftpFiles`（SFTP 树），终端与服务器表单为 WebviewPanel。

### 2.2 扩展清单（`package.json` / `package.mcp.json` / `package.base.json`）

- **双变体构建**（ADR-001-dual-build-variants）：
  - base 变体：`name: "at-terminal"`，无 `onStartupFinished`，无 MCP 命令；esbuild `--variant=base` 把 `MCP_ENABLED` define 成 `false`，并用 `stubMcpHubPlugin`（`esbuild.config.mjs`）把 `@at-series/mcp-hub` 整包替换成全 `undefined` 导出的 stub（CJS 无法 tree-shake）。
  - mcp 变体：`name: "at-terminal-mcp"`（`package.mcp.json`），`activationEvents` 增加 `onStartupFinished`，增加 `sshManager.installMcpConfig` / `sshManager.uninstallAtSeriesMcpConfig` 两条命令；打包时 `scripts/copy-hub.mjs` 把 hub 的 `hub.js` + `hub-version.json` 拷入 `dist/`，`scripts/copy-policy-assets.mjs` 拷贝命令策略资产。
- publisher：`local`（两个变体扩展 ID 即 `local.at-terminal` / `local.at-terminal-mcp`）。
- activationEvents：`onStartupFinished`、`onView:sshManager.servers`、`onView:sshManager.sftpFiles`。
- 命令（22 条）：服务器 CRUD（`sshManager.addServer/editServer/deleteServer/connect/disconnect/reconnect/copyHost/refresh`）、SFTP 12 条（`sftp.refresh/upload/download/delete/rename/newFile/newFolder/copyPath/edit/openPreview/cdToDirectory/goToPath/goUp`）、资产导入导出（`exportAssets/importAssets`）、MCP 安装卸载 2 条。
- 配置项：`sshManager.terminalFontSize`(14)、`terminalFontFamily`、`scrollback`(10000)、`semanticHighlight`(true)、`idleDisconnectMinutes`(60)、`keepAliveInterval`(30)。
- 依赖：`@at-series/mcp-hub ^0.3.2`、`@at-series/command-policy 0.1.0`、`ssh2`、`@xterm/xterm` 系列、`zod`。

### 2.3 src/ 结构与模块职责

```text
src/
  extension.ts                 # activate/deactivate；装配所有服务与命令
  agent/                       # Agent 执行域（MCP 工具的真正实现）
    AgentToolService.ts        #   工具门面：listServers/getTerminalContext/runRemoteCommand/sftp*
    RemoteCommandExecutor.ts   #   后台 SSH exec（非交互）
    remoteCommandAuthorization.ts / agentCommandTrust.ts   # 三档信任 + 策略评估
    loadRemoteCommandPolicy.ts #   懒加载 @at-series/command-policy（失败→review 弹窗兜底）
    destructiveCommandHint.ts  #   破坏性提示（仅 UI 红字，不参与放行）
    SftpAgentService.ts / SftpWriteAuthorizer.ts / createSftpWriteAuthorizer.ts / remoteWritePolicy.ts
  mcp/                         # Bridge 与 Hub 接入层
    BridgeServer.ts            #   HTTP server + publish/heartbeat/unpublish
    BridgeProtocol.ts          #   线上类型 + legacy header 'x-at-terminal-token'
    bridgeSchemas.ts           #   invoke 参数 Zod schema
    toolCatalog.ts             #   AT_TERMINAL_PLUGIN_ID / AT_TERMINAL_TOOL_CATALOG
    hubSync.ts                 #   syncPackagedHub（dist/hub.js → ~/.at-series/mcp/hub.js）
    McpConfigInstaller.ts      #   ensure/uninstallAtSeriesConfigForCurrentIde
  ssh/                         # SshSession / HostKeyStore / 连接测试
  sftp/                        # SftpManager/SftpSession/编辑会话/预览/拖拽
  terminal/TerminalContext.ts  # TerminalContextRegistry（活动/已连接终端快照）
  tree/ config/ webview/ utils/ assets/ policy-runtime/ i18n/
```

### 2.4 MCP / Bridge 接入方式（最重要）

**activate 顺序**（`src/extension.ts` L121–197，代码注释明示）：`detectHostApp → syncPackagedHub → AgentToolService → BridgeServer.start（publish）→ ensureAtSeriesConfig → 注册 install/uninstall 命令`。全部包在 `if (MCP_ENABLED)` 内。

- **hub 同步**：`syncPackagedHub(context)`（`src/mcp/hubSync.ts`）→ `syncHubBundle({ version: 来自 dist/hub-version.json 侧车（fallback require '@at-series/mcp-hub/package.json'）, bundlePath: dist/hub.js, pluginId: 'at.terminal', pluginVersion })`。**`hubReady` promise 完成后才调 `ensureAtSeriesConfigForCurrentIde`**（符合 v1 §9.1 顺序要求）；失败弹 warning（“MCP may not start until Repair succeeds”）。
- **MCP 配置**：`src/mcp/McpConfigInstaller.ts` 的 `resolveMcpInstallerTarget`——`kiro→'kiro'`、`cursor→'cursor'`、`continue→有 workspaceFolder 才 'continue'`、其余（含 vscode）返回 undefined 跳过。
- **Bridge HTTP**（`src/mcp/BridgeServer.ts`）：
  - `bridgeId = randomUUID()`（每扩展宿主实例一次，类字段）；`token = createBridgeToken()`（32 字节 CSPRNG base64url）；`listen(0, '127.0.0.1')` 随机端口。
  - `headersTimeout=10s`、`requestTimeout=30s`（防本地进程占连接）；**未鉴权请求在读 body 之前就 401**（防 2MiB 缓冲攻击）；`readLimitedBody` 超 2MiB → 413 `PAYLOAD_TOO_LARGE`。
  - 鉴权 `isAuthorized`：`timingSafeEqualToken` 比较 `x-at-series-token`，legacy 兼容 `x-at-terminal-token`。
  - `/health`（GET 或 POST 兼容）返回 v1 health 形状 + `connectedTargets`（当前已连接终端数）+ `toolCount`。
  - `/invoke`：`dispatchTool` switch 按工具名分发到 `AgentToolService`；参数用 `bridgeSchemas.ts` 的 Zod 校验，失败 → `422 VALIDATION_ERROR`；未知工具 → `404 NOT_FOUND`；`'Remote command was cancelled.'` → **`499 USER_CANCELLED`**；其余异常 → `500 INTERNAL_ERROR`。
  - **publish**：`FsBridgePublisher.publish({ protocolVersion: 1, bridgeId, pluginId: 'at.terminal', pluginDisplayName: 'AT Terminal', pluginVersion, hostApp, port, token, pid, updatedAt, tools: AT_TERMINAL_TOOL_CATALOG, capabilities: { connectedTargets } })`；心跳 `BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000`，每次带最新 `connectedTargets`，失败静默下轮重试。
  - **dispose**（挂进 `context.subscriptions`）：清心跳 → `publisher.unpublish()`（删除自己的 registry 文件）→ `server.close()`。注释明示 dispose 只 unpublish，**不卸 MCP 配置、不删 hub.js**（符合 v1 §5.4/§9.4）。
- **pluginId / bridgeId 规则**：pluginId 是 `src/mcp/toolCatalog.ts` 里的常量 `AT_TERMINAL_PLUGIN_ID = 'at.terminal'`；bridgeId 每窗口一个 `crypto.randomUUID()`；hostApp 来自 `detectHostApp({appName, appRoot, uriScheme, extensionPath})`。
- **凭据隔离**：`ConfigManager`（`src/config/ConfigManager.ts`）密码存 `context.secrets`（SecretStorage，按 server id 派生 key）；`list_ssh_servers` 返回的 `BridgeServerSummary` 只含 `id/label/host/port/username/authType`+信任档位，**无密码/私钥**；主机密钥指纹存 `globalState`（`HostKeyStore`）。registry 记录里只有 Bridge token。

### 2.5 工具目录（`src/mcp/toolCatalog.ts`，共 9 个）

| # | name | title | risk | 确认弹窗 | inputSchema 摘要 / 输出限额 |
|---|---|---|---|---|---|
| 1 | `list_ssh_servers` | List SSH Servers | read | 无 | 空对象；只返回勾选「允许后台连接」的服务器 |
| 2 | `get_terminal_context` | Get Terminal Context | read | 无 | 空对象；返回 focused/connected/known 终端快照 |
| 3 | `run_remote_command` | Run Remote SSH Command | **exec** | **按服务器信任三档**（见下） | `{serverId?('active'), command*, cwd?, timeoutMs?(cap 120000), maxOutputBytes?(默认 64000，cap 256000，stdout/stderr 各自计)}`；description 长文详述信任策略与截断行为 |
| 4 | `sftp_list_directory` | SFTP List Directory | read | 无 | `{terminalId?, serverId?, path?, maxEntries?(默认 500, cap 5000)}`+`truncated/total` |
| 5 | `sftp_stat_path` | SFTP Stat Path | read | 无 | `{…, path*}` |
| 6 | `sftp_read_file` | SFTP Read File | read | 无 | `{…, path*, maxBytes?(默认 65536, cap 262144)}`+`truncated` |
| 7 | `sftp_write_file` | SFTP Write File | write | **有**（目录级授权） | `{…, path*, content*, overwrite?}` |
| 8 | `sftp_create_file` | SFTP Create File | write | 有 | `{…, path*, content?}` |
| 9 | `sftp_create_directory` | SFTP Create Directory | write | 有 | `{…, path*}` |

**确认机制细节**：

- `run_remote_command`（`AgentToolService.runRemoteCommand` → `authorizeRemoteCommand`，`src/agent/remoteCommandAuthorization.ts`）：服务器 `agentCommandTrust` 三档（ADR-003 第五修订，2026-08-21）——`none` 每条弹模态确认；`policy` 走 `@at-series/command-policy` 黑名单+引号感知词法（`shellCommandLexer`；docker/kubectl/virsh 只读子命令放行、iptables 只读标志放行、`sed -i`/`awk system(` 弹窗、`sh`/`python`/`sudo`/`xargs` 一律弹窗、命令替换/重定向/不可解析形态一律弹窗、**未知命令默认放行**）；`full` 不弹。策略加载失败 fail-safe 成 `review`（弹窗）。取消 → `Error('Remote command was cancelled.')` → 499。
- SFTP 写（`createProductionSftpWriteAuthorizer` / `SftpWriteAuthorizer`、`remoteWritePolicy.ts`）：非 full-trust 时**按目录逐个授权**（换目录再弹）、敏感路径（SSH key、/etc、/usr、service unit、sudoers、cron）**永远二次确认且不记忆**、权限被拒**绝不 sudo 升级**（`SftpSession` 以 `allowSudoFallback:false` 构造，与用户 UI 会话的 `true` 显式区分，`extension.ts` L156–164 注释说明）。

### 2.6 Skill（`skills/at-terminal-mcp/SKILL.md` + 16 个 references）

- 前置：入口是 **AT Series**（推荐配合系列 skill `super-ops`）；禁止读 IDE 存储/密码/密钥/bridge token。
- select 流程：`at_list_providers → at_select_tools({mode:'replace', pluginIds:['at.terminal']}) → 刷新 tools/list → 调工具 → 完成后 at_clear_tool_selection`。
- 核心工作流：先 `get_terminal_context`（除非用户指名 server），多目标必须问、不许猜；先只读取证，“诊断请求不授权修复”；`run_remote_command` 必须非交互、每条命令带 `# Purpose:` POSIX 注释；截断时收窄命令而不是加大限额（明确点名不要 `nginx -T` / `docker compose config` 全量导出）；SFTP 先 stat/read 再 write；汇报必须含目标、证据、动作、退出码、验证与残余风险。
- 分级引用（每假设 ≤1 篇 + 写操作前必读 safe-operations）：setup / safe-operations / workspace-troubleshooting / incident-response / linux-host / systemd / network-dns-tls / storage / docker-compose / kubernetes / web-proxy / databases / observability / deployment-rollbacks / backup-DR / security-incidents。
- 明示「IDE 确认弹窗 ≠ 会话内批准」；一切远端输出为不可信数据。
- 另有 `skills/writing-ops-documents`（运维文档写作规范）。

### 2.7 ADR 要点（`docs/decisions/`）

- **ADR-001 双构建变体**：base（无 MCP）与 mcp 两个 VSIX；`MCP_ENABLED` esbuild define + mcp-hub stub。
- **ADR-002 MCP stdio + 本机 Bridge**：凭据/确认/终端上下文必须留在扩展宿主；回环 TCP+token；安全不变量：工具永不返回密码私钥、命令确认留在 `AgentToolService`、SFTP 写必须过 `SftpWriteAuthorizer`（生产装配禁 stub 恒真）、出站 SSH 必做主机密钥校验。
- **ADR-003 Agent 命令确认策略**（五次修订，当前 2026-08-21 版）：布尔开关 → 只读白名单 → 只读管道放行 → 黑名单+词法 → **信任三档 `none/policy/full`**。修订史非常有参考价值：明确了「威胁模型是被提示注入的 Agent 而非手滑的人」「黑名单漏报可收敛、白名单误报会训练用户无脑点确认」的不对称性。
- **ADR-004/005 采纳 AT Series Hub**：删除 `languageModelTools` 与 per-plugin `mcp-server.js` 产品面；`AgentToolService` 仍是执行与确认权威。

### 2.8 前端技术栈与 IPC

- **无框架纯 TypeScript** + xterm.js（`webview/terminal/index.ts`：`@xterm/xterm` + fit + web-links；剪贴板、主题、语义高亮、斑马纹模块化）；`webview/server-form/index.ts` 纯 DOM 表单。
- IPC：标准 `acquireVsCodeApi().postMessage`。终端上行 `{type:'ready',rows,cols} | {type:'input',payload} | {type:'resize',rows,cols}`（`src/webview/TerminalPanel.ts` L15–17）；下行 `{type:'output'|'outputBytes'|'status',payload}`（输出经 `TerminalOutputBatcher` 批量化）。HTML 由 `src/webview/html.ts` 生成，带 nonce CSP。

### 2.9 对嵌入式 Agent 的影响与零改动验证

- Bridge 与 registry 的发布**不依赖任何外部 MCP 客户端存在**：activate 即 publish；嵌入式 Agent 进程内 `listBridgeRecords({hostApp})` + `bridgeInvoke` 即可调用，**零改动成立**。
- `syncPackagedHub`/`ensureAtSeriesConfig` 仍会写 `~/.cursor/mcp.json` 的 `AT Series` 条目——对嵌入方案无害但会造成“工具双入口”（IDE 原生 MCP + opsAgent 各见一份）；如需收敛可引导用户跑 `sshManager.uninstallAtSeriesMcpConfig`（插件自带，仍零改动）。
- 确认弹窗在插件扩展宿主内弹出，invoke 会阻塞——嵌入客户端超时必须 ≥120s 并把 `USER_CANCELLED(499)` 单独呈现为「用户拒绝」而非失败重试。

### 2.10 风险与缺口

- `policy` 档下**未知命令名默认放行**（ADR-003 已知残留 #1），对生产主机建议 `none` 档；嵌入 Agent 的策略层可考虑附加自己的命令审计。
- 读取面无门（`cat /etc/shadow` 不弹窗）——有意决策，但嵌入 Agent 的输出侧应做脱敏。
- 多窗口 = 多 bridge 记录，选路依赖 `connectedTargets`/`updatedAt` 评分，Agent 需实现同样的评分或复用 `pickBridgeForTool`。

---

## 3. AT-Jumpserver（at.jumpserver）

仓库：`/tmp/research/AT-Jumpserver`，版本 `0.1.9`。

### 3.1 产品定位与用户场景

面向**JumpServer 堡垒机运维**：用户名/密码登录多台 bastion，列出授权资产（SSH / MySQL `db_client` / Redis `db_client`），通过 JumpServer KoKo WebSocket 打开浏览器风格终端，SFTP（经 KoKo）文件管理。MCP 暴露“资产发现 + 终端命令 + SFTP + SQL/Redis 执行”。主 UI：activity bar `jumpserverManager` 下 `jumpserverManager.assets`（资产树）与 `jumpserverManager.sftpFiles`；终端与配置面板为 Webview。不支持直连 ssh2、RDP、SSO/MFA（README「Not Supported」清单）。

### 3.2 扩展清单（`package.json`）

- `name: "at-jumpserver-terminal"`，publisher `local`，**单一构建变体，MCP 恒开启**（无 `MCP_ENABLED` 门；`npm run build` 恒执行 `copy:hub`）。
- activationEvents：`onStartupFinished`、`onView:jumpserverManager.assets`、`onView:jumpserverManager.sftpFiles`。
- 命令（21 条）：`configure/addBastion/removeBastion/refreshBastion/editBastion/validate/refresh/connect/copyHostIp/disconnect/reconnect`、SFTP 10 条、`installMcpConfig`、`uninstallAtSeriesMcpConfig`。
- 配置项：`jumpserverManager.terminalFontSize/terminalFontFamily/scrollback(5000)/semanticHighlight/idleDisconnectMinutes`。
- 依赖：`@at-series/mcp-hub ^0.3.2`、`ws`（KoKo WebSocket）、`@xterm/*`、`zod`；**`@modelcontextprotocol/sdk ^1.29.0` 在 src/ 中零引用**（历史残留依赖，可视为缺口/待清理）。

### 3.3 src/ 结构

```text
src/
  extension.ts                     # activate：配置/树/SFTP/Agent 服务/Bridge/Hub
  agent/
    JumpServerAgentToolService.ts  # 全部 14 个工具实现 + 确认注入点 confirm()
    TerminalExecutors.ts           # ShellTerminalExecutor / MysqlCliExecutor / RedisCliExecutor
    TerminalOutputBuffer.ts        # PTY 输出捕获（哨兵标记法）
    SqlSafety.ts / RedisSafety.ts  # isReadOnlySql / isReadOnlyRedisCommand / isBlockingRedisCommand
  jumpserver/                      # REST 客户端（JumpServerClient/Pool、orgs、pagination、KoKo session）
  mcp/                             # BridgeServer / BridgeProtocol / bridgeSchemas / toolCatalog / hubSync / McpConfigInstaller
  sftp/  tree/  config/  terminal/  webview/  utils/  i18n/
```

### 3.4 MCP / Bridge 接入方式

与 At-Terminal 同构（同一套代码模板），差异点：

- `syncPackagedHub` 用 `pluginId: AT_JUMPSERVER_PLUGIN_ID = 'at.jumpserver'`（`src/mcp/hubSync.ts`）；activate 中 `hubReady.then(() => ensureAtSeriesConfigForCurrentIde(...))` 顺序正确。
- `BridgeServer`（`src/mcp/BridgeServer.ts`，597 行）比 Terminal 多一个 **`rollbackFailedStart()`**：publish 失败时回滚（清心跳、关 server），避免半启动状态。
- legacy 鉴权头：`BRIDGE_TOKEN_HEADER = 'x-at-jumpserver-terminal-token'`（`src/mcp/BridgeProtocol.ts` L13）。
- 取消映射更宽：`/cancelled/i.test(error.message)` → `499 USER_CANCELLED`（BridgeServer L334）。
- 确认 UI 通过依赖注入：`extension.ts` 构造 `JumpServerAgentToolService` 时传 `confirm: async (message) => showWarningMessage(message, {modal:true}, 'Continue') === 'Continue'`——**所有 write/exec 确认集中走这一个注入点**，对测试与嵌入替换很友好。
- deactivate：`cleanup.dispose()` 内 `void bridgeServer.dispose()` → unpublish；不卸配置。
- **凭据隔离**：`JumpServerConfigManager`（`src/config/JumpServerConfigManager.ts`）每 bastion 密码存 SecretStorage（`passwordKey(bastionId)`），REST Bearer token 与 KoKo 会话仅内存复用；工具输出仅资产元数据。

### 3.5 工具目录（`src/mcp/toolCatalog.ts`，共 14 个，前缀 `jumpserver_`）

| # | name | risk | 确认 | 摘要 |
|---|---|---|---|---|
| 1 | `jumpserver_list_assets` | read | 无 | 缓存资产列表；`search/bastionId/limit(默认200,cap500)/offset` 分页，`truncated` 提示 |
| 2 | `jumpserver_get_terminal_context` | read | 无 | active/connected/known 终端（含 connectionKind: ssh/mysql/redis） |
| 3 | `jumpserver_send_terminal_input` | **exec** | **恒确认** | 向已连接终端发原始输入（交互兜底通道） |
| 4 | `jumpserver_run_terminal_command` | **exec** | **恒确认** | 非交互 SSH 命令；输出默认 64KB cap 256KB；**按 terminalId 串行队列 `enqueueTerminal` 防并发交织** |
| 5 | `jumpserver_sftp_list_directory` | read | 无 | `connectionKey/terminalId` 选会话；maxEntries 默认 500 cap 5000 |
| 6 | `jumpserver_sftp_stat_path` | read | 无 | |
| 7 | `jumpserver_sftp_read_file` | read | 无 | 默认 64KB cap 256KB；含 `\0` 判二进制拒绝 |
| 8 | `jumpserver_sftp_write_file` | write | 恒确认 | 确认文案含目标资产名+地址 |
| 9 | `jumpserver_sftp_create_file` | write | 恒确认 | |
| 10 | `jumpserver_sftp_create_directory` | write | 恒确认 | |
| 11 | `jumpserver_sftp_rename` | write | 恒确认 | `{oldPath*, newPath*}` |
| 12 | `jumpserver_sftp_delete` | write | 恒确认 | |
| 13 | `jumpserver_mysql_execute_sql` | **exec** | **仅非只读 SQL 确认**（`isReadOnlySql`） | 要求已连接 MySQL CLI 终端；SELECT 建议带 LIMIT；64KB/256KB |
| 14 | `jumpserver_redis_execute_command` | **exec** | **仅非只读命令确认**（`isReadOnlyRedisCommand`） | 单条非阻塞命令；`SUBSCRIBE/MONITOR/BLPOP…` 直接拒绝（`isBlockingRedisCommand`），指引改用 send_terminal_input |

与 Terminal 的关键差异：JumpServer 的 exec 工具**依附于用户已打开的终端会话**（`resolveTerminal` 要求 connected terminal），没有“后台直连”模式——Agent 想执行命令，用户必须先在 IDE 里连上资产。

### 3.6 Skill（`skills/at-jumpserver-terminal-mcp/SKILL.md`）

- 同样的 discover→select→call 流程（`pluginIds:['at.jumpserver']`），强调「保持 JumpServer IDE 窗口打开使 bridge 保持发布」。
- 工具选择表 + Payload 纪律：命令/SQL/Redis 默认 64KB cap 256KB，truncated 时收紧查询而非只加限额；Redis 禁 `KEYS *` 用 SCAN；SFTP 大文件先 stat；资产用 search/limit/offset 不整表倾倒。
- 工作流：先 `get_terminal_context` 按 `connectionKind` 过滤；优先 run_terminal_command / mysql_execute_sql / redis_execute_command，send_input 仅交互场景；SFTP 先读后写；禁读 IDE secret storage/cookie/JumpServer token；别把 at.terminal 与 at.jumpserver 混淆。

### 3.7 文档

`docs/decisions/ADR-001-at-series-mcp-hub.md`（采纳 Hub 的本仓副本）；`docs/mcp`、`docs/superpowers`、`docs/releases`。CHANGELOG.md 在仓库根。

### 3.8 前端技术栈与 IPC

纯 TypeScript + xterm.js（`webview/terminal/index.ts` 与 Terminal 插件同构，共享 clipboard/theme/zebra 模块结构）；`webview/jumpserver-config/index.ts` 纯 DOM 配置面板。IPC 同为 postMessage。

### 3.9 对嵌入式 Agent 的影响与零改动验证

- **零改动成立**：Bridge/registry 行为完全契约内；错误体标准；确认注入点已收敛。
- 特殊约束：exec 类工具需要**已连接的 UI 终端**；嵌入 Agent 应在编排层先查 `jumpserver_get_terminal_context`，无连接时提示用户先在 IDE 中连接资产（不能像 Terminal 那样后台直连）。

### 3.10 风险与缺口

- `@modelcontextprotocol/sdk` 死依赖（体积/供应链噪音）。
- `isReadOnlySql`/`isReadOnlyRedisCommand` 是启发式白名单：判定为只读则免确认，误判（如带副作用的存储过程 `SELECT ... INTO OUTFILE`? 需核对实现细节）风险由插件承担；嵌入 Agent 不应依赖它做安全边界。
- 输出捕获基于 PTY 哨兵（`TerminalOutputBuffer`），远端提示符异常/超长输出场景可能截断错位；已有 per-terminal 队列缓解并发交织。
- 无 `capabilities.connectedTargets`≠0 时的差异化——有（同 Terminal），无额外缺口。

---

## 4. At-grafana（at.grafana）

仓库：`/tmp/research/At-grafana`，版本 `0.1.3`。

### 4.1 产品定位与用户场景

面向**可观测性查询**：多 Grafana 实例配置（Service Account Token），侧边栏看板树与 Unified Alerting 告警树，**Webview 内嵌真实交互式 Grafana 页面**（经本地鉴权反向代理注入 Authorization，见 ADR-003），MCP 暴露 17 个**全只读**工具：Grafana 管理元数据（dashboards/folders/alerts/annotations/deeplink）+ 监控数据（Prometheus/Loki 类型化查询、标签发现、通用 datasource 代理逃生舱）。明确非目标：任何写操作、Legacy Alerting、多组织、单面板下钻。

### 4.2 扩展清单（`package.json`）

- `name: "at-grafana"`，publisher `local`，有 repository（github.com/xwamt/At-grafana）。**单一构建变体**（ADR-002-single-build-variant：全部工具只读，没必要出 base 版）。
- activationEvents：仅 `onStartupFinished`。
- viewsContainers：`atGrafana` → views `atGrafana.dashboards`、`atGrafana.alerts`（含 viewsWelcome 空态文案）。
- 命令（10 条）：`addInstance/manageInstances/installMcpConfig/uninstallAtSeriesMcpConfig/refreshDashboards/filterDashboards/clearDashboardFilter/refreshAlerts/openDashboard/openAlertRule`。
- 配置项（Agent 查询限额，写进 settings 而非硬编码）：`atGrafana.queryLimits.maxRangeMs`（默认 43,200,000 = 12h，超限把 start 前移并标 `truncated:true` reason `time-range`）、`atGrafana.queryLimits.maxResponseBytes`（默认 5MiB，超限**整体丢弃**并标 `truncated:true` reason `response-size`，绝不返回半截结构）。
- 依赖极简：`@at-series/mcp-hub ^0.3.2` + `zod`。

### 4.3 src/ 结构

```text
src/
  extension.ts                    # activate/deactivate（Promise.allSettled 收尾，见 L281 注释）
  grafana/                        # HTTP 域层
    GrafanaHttpClient.ts / GrafanaApiClient.ts     # fetch 封装 + GrafanaApiError
    GrafanaDashboardsApi/AlertsApi/DatasourcesApi/AnnotationsApi.ts
    typedDatasourceQueries.ts     # buildPrometheusProxyCall / buildLokiProxyCall（类型化→受限代理路径）
    typedDatasourceDiscovery.ts   # 标签/指标发现（cap 200 + regex 过滤）
    QueryLimits.ts / QueryRateLimiter.ts           # 时间窗/响应体积/并发/QPM 限额
    GrafanaCertTrustStore.ts / ensureGrafanaTlsTrust.ts / createInteractiveCertVerifier.ts  # TLS TOFU
    grafanaDeeplink.ts / correlateAlertState.ts
  agent/GrafanaAgentToolService.ts # invoke(name,args) → {ok,result} | {ok:false,code,message}
  agent/projectDashboard.ts        # dashboard JSON 投影（targets/summary/full）
  webview/
    GrafanaEmbedProxy.ts          # 本地鉴权反向代理（embedToken + Host/Origin 校验）
    DashboardPanel.ts / AlertDetailPanel.ts / GrafanaInstanceFormPanel.ts / openPanels.ts
  mcp/  tree/  config/  utils/  i18n/
```

### 4.4 MCP / Bridge 接入方式

- activate 顺序注释（`src/extension.ts` L98–99）：`detectHostApp → syncPackagedHub → BridgeServer.start（publish）→ ensureAtSeriesConfig → install/uninstall 命令`；`hubReady.then(ensure)` 顺序正确。**无 MCP_ENABLED 门**（单变体恒开）。
- `syncPackagedHub` pluginId `'at.grafana'`；`McpConfigInstaller.ts` 与 Terminal 逐字节相同（diff 验证）。
- `BridgeServer`（`src/mcp/BridgeServer.ts`）：模板同 Terminal（randomUUID bridgeId、createBridgeToken、listen(0)、10s/30s 超时、未鉴权先拒、2MiB 限体）。差异：
  - `/invoke` 先查 `AT_GRAFANA_TOOL_CATALOG` 找目录项（404），再查 `BRIDGE_SCHEMAS_BY_TOOL_NAME` 强制每个工具都有 Zod schema（缺失 → 500 fail-safe），校验失败 → 422。
  - 分发到 `GrafanaAgentToolService.invoke(name, args)`，返回 `{ok:true,result}` 或 `{ok:false,code,message}`；`statusForToolErrorCode`：`NOT_FOUND→404`、`VALIDATION_ERROR→422`、`UNAVAILABLE→503`（注释：load shedding，值得重试）、其余→500。**没有 USER_CANCELLED 路径**（无确认弹窗，全只读）。
  - health 无 `connectedTargets`（Grafana 无连接会话概念），registry 记录也不带 capabilities。
- deactivate：`export async function deactivate(){ await extensionCleanup?.dispose(); }`，内部 `Promise.allSettled` 并行关 Bridge（unpublish）与 EmbedProxy，单步失败只记日志不让 deactivate 报错（L281–309 注释）。
- **授权模型（ADR-004，替代确认弹窗的门）**：每实例布尔 `allowBackgroundAccess`（默认 false）。false 时不出现在 `grafana_list_instances`，**且任何指名 instanceId 的调用在 Bridge invoke 层被拒**（防旧会话记住 id 绕过）；true 时全部 read 工具随时可调（为无人值守监控设计，requirement S4）。
- **凭据隔离**：Service Account Token 存 SecretStorage（`GrafanaInstanceConfigManager`，key `atGrafana.token.<id>`）；工具输出 `{id,label,url}`、datasource `{uid,name,type,url}`，never token；嵌入代理在扩展宿主侧注入 `Authorization: Bearer`，**Webview/iframe 永远看不到 token**。

### 4.5 工具目录（`src/mcp/toolCatalog.ts`，共 17 个，前缀 `grafana_`，全部 `risk:'read'`，全部无确认弹窗）

每条 description 末尾追加 `MANAGEMENT_FAMILY_SUFFIX` 或 `MONITORING_FAMILY_SUFFIX`，让 Agent 分清「管理 Grafana 自身配置」与「查询 datasource 背后的数据」两个 persona。

发现：

| name | 摘要 |
|---|---|
| `grafana_list_instances` | 只列 `allowBackgroundAccess=true` 的实例 `{id,label,url}`；其余工具 instanceId 的合法值来源 |

管理族（8）：

| name | 摘要 |
|---|---|
| `grafana_list_dashboards` | `/api/search`；`query/tag/folderUid` 收窄 |
| `grafana_get_dashboard` | `fields` 默认 `targets`（仅 panel expr+datasource），`summary` 面板清单，`full` 全模型；`panelIds/titleContains` 服务端过滤 |
| `grafana_list_folders` | 文件夹树 |
| `grafana_list_alert_rules` | Unified Alerting + 当前状态；可按 `states` 过滤 |
| `grafana_get_alert_rule` | 单规则全定义 |
| `grafana_get_alert_history` | 规则状态变更历史 |
| `grafana_list_annotations` | `/api/annotations` 只读；`from/to/dashboardUid/tag/limit(默认100,max100)`；用于部署窗口相关性 |
| `grafana_generate_deeplink` | 生成 dashboard/Explore URL；`openInIde`（默认 false）只对 dashboard 打开内嵌 Webview |

监控数据族（8）：

| name | 摘要 |
|---|---|
| `grafana_list_datasources` | `{uid,name,type,url}`，never credentials |
| `grafana_query_prometheus` | 类型化 PromQL instant/range（默认 range）；构造受限代理路径 `api/v1/query(_range)` |
| `grafana_query_loki` | 类型化 LogQL；`limit` 建议 50–100 |
| `grafana_list_prometheus_metric_names` | `api/v1/label/__name__/values`，cap 200 + regex，`truncated:true` |
| `grafana_list_prometheus_label_values` | 同上按 label；matcher → `match[]` |
| `grafana_list_loki_label_names` / `grafana_list_loki_label_values` | Loki 标签发现，cap 200 |
| `grafana_query_datasource` | **逃生舱**：`method ∈ {GET,POST}` 白名单；`path` 严格限定在 `/api/datasources/proxy/uid/<uid>/` 之下——拒 `..`、`\`、`%2e/%2f/%5c`，URL 归一化后再校验前缀（**三层执行**：Zod schema、`GrafanaDatasourcesApi.proxyDatasourceRequest` 入参检查、`buildDatasourceProxyPath` join 后断言）。ADR-004 记载 2026-08-13 之前无此限制时 `POST ../../../../../api/auth/keys` 可打到 Grafana Admin API——该限制是 `risk:'read'` 分类的承重墙 |

### 4.6 Skill（`skills/at-grafana-mcp/SKILL.md` + references/tool-selection.md、compose-grafana-skills.md）

- discover→select→call（`pluginIds:['at.grafana']`）。
- 省上下文默认值：list_dashboards 传 query；get_dashboard 默认 targets；Prom/Loki 必须有界 start/end、Loki limit ≤100；`truncated:true` 时收窄重试。
- 核心流程：`grafana_list_instances` 为空 → 告诉用户开「Allow Agent background access」，**不许猜 id**；管理线（query→get_dashboard）与监控线（list_datasources→typed query）分开；never 输出 token 形状的值。
- 两个实战例：面板尖峰、firing 告警。

### 4.7 ADR 要点（`docs/decisions/`，7 篇）

- ADR-001：从 at-terminal-series 脚手架复制。
- ADR-002：单构建变体（全只读，无需 base/mcp 双包）。
- ADR-003：**本地鉴权反向代理内嵌 Grafana**——iframe 指向 `http://127.0.0.1:<proxyPort>/e/<embedToken>/instances/<id>/…`；proxy 校验 embedToken（32 CSPRNG 字节 + `timingSafeEqualToken`）、`Host` 精确匹配（防 DNS rebinding）、`Origin` 自身或缺省；失败回**无品牌 404**（防回环端口扫描指纹识别）。此设计文档明确「到达 proxy = 持有 Service Account Token」的威胁模型。
- ADR-004：工具目录与权限模型（上文已详述；含 `allowBackgroundAccess` 与 at-terminal 双路径模型的显式分歧论证）。
- ADR-005：采纳 Hub Protocol v1（pluginId `at.grafana`）。
- ADR-006：类型化 Prom/Loki 工具与 `fields:"targets"` 默认投影。
- ADR-007：发现/annotations/deeplink 工具。

### 4.8 前端技术栈与 IPC

- `webview/grafana-instance-form/`：纯 TypeScript 表单（同 Terminal 模式）。
- Dashboard/Alert 详情：**不是自绘 UI**，是 iframe 内嵌真实 Grafana 前端，鉴权由 `GrafanaEmbedProxy` 完成；WebSocket（Grafana Live）在「Not in this release」清单。
- IPC：postMessage（面板打开/deeplink `openInIde` 由 `openPanels.ts` 调度）。

### 4.9 对嵌入式 Agent 的影响与零改动验证

- **零改动成立**，且是四者中最干净的目标：全 read、错误码规范、限额在 settings 可调、`truncated` 语义一致。
- 嵌入 Agent 唯一要注意的是 `UNAVAILABLE(503)` 的重试语义（rate limiter 载荷剪除）与 12h/5MiB 限额下的窄查询习惯（Skill 已给出话术）。

### 4.10 风险与缺口

- `grafana_query_datasource` 的 `risk:'read'` 依赖路径限制成立，且 ADR-004 自己指出「任意 datasource 在自己代理子树下暴露什么并未枚举」——按 datasource 类型的端点白名单是下一步收紧方向（未做）。
- 无写操作 = 无法执行「静默告警 / 暂停规则」类处置，运维闭环需要落到 Terminal/JumpServer 工具。
- 嵌入代理不支持 Grafana Live WebSocket（面板实时推送降级为轮询刷新）。

---

## 5. At-Database（at.database）

仓库：`/tmp/research/At-Database`，版本 `0.1.1`。

### 5.1 产品定位与用户场景

面向 **IDE 内数据库工作区**：PostgreSQL / MySQL / Redis 统一连接树（支持 SSH 隧道、TLS、HostKeyStore 信任）、Canvas 高性能数据网格（自研 DbxDataGrid，就地编辑、事务批量提交）、SQL 查询工作区（补全、**破坏性 SQL 拦截**、自动 LIMIT 注入）、表结构/DDL、Redis 控制台（命名空间树、Stream、Pub/Sub、慢日志）、慢查询/进程管理（Kill 二次确认）、Schema Diff 迁移脚本。MCP 暴露 12 个 `db_*` 工具。主 UI：`dbManager.connections` 树 + 7 类 Webview 面板。

### 5.2 扩展清单（`package.json` / `package.base.json` / `package.mcp.json`）

- **双变体**（同 Terminal 模式）：`at-database`（dev 清单，`private:true`）与打包用 `package.base.json`（`at-database`）/ `package.mcp.json`（`at-database-mcp`）；`scripts/package-variant.mjs` 按变体换 manifest；esbuild `MCP_ENABLED` define。
- activationEvents：base 仅 `onView:dbManager.connections`；**mcp 变体增加 `onStartupFinished`**（否则不点开树 Bridge 不发布）。
- publisher `local`。命令含 `dbManager.installMcpConfig` / `dbManager.uninstallAtSeriesMcpConfig`（base/mcp 清单都有该命令声明，代码在 `MCP_ENABLED` 内注册）。
- 依赖：`@at-series/mcp-hub ^0.3.2`、`vue ^3.5.13`、`pinia ^3.0.1`、`@lucide/vue`、`esbuild-plugin-vue3`、pg/mysql2/ioredis 等驱动、`ssh2`。

### 5.3 src/ 结构

```text
src/
  extension.ts                 # activate；MCP 段在 L486–556
  db/                          # 域层：DbClient(Pg/Mysql)/RedisClient/ConnectionService(池)/
                               #   queryGuard/sqlPagination/sqlInsert|Update|Delete/
                               #   diagnostics/SlowQueryService  diff/SchemaDiffService
                               #   import/export、RedisPubSubManager、withTimeout
  safety/destructiveSql.ts     # 破坏性 SQL 识别（仅被 webview/QueryPanel、TableDataPanel 引用！）
  ssh/                         # SshTunnelManager（单例隧道复用）/HostKeyStore
  mcp/                         # BridgeServer / toolCatalog / hubSync / McpConfigInstaller（无 BridgeProtocol/bridgeSchemas）
  webview/                     # 面板宿主：QueryPanel/TableDataPanel/TableStructurePanel/
                               #   RedisBrowserPanel/SlowQueryPanel/SchemaDiffPanel/ConnectionFormPanel
  config/ConnectionManager.ts  # SecretStorage：密码 + SSH 密码 + SSH passphrase
  tree/ diagnostics/ i18n/
```

### 5.4 MCP / Bridge 接入方式（含契约偏差）

`src/extension.ts` L486–556，`if (MCP_ENABLED)`：

```ts
const bridgeServer = new BridgeServer({ services: {...}, hostApp: detectHostApp(vscode.env), pluginVersion });
void bridgeServer.start().catch(...);          // ① 启动+publish
void syncPackagedHub(context).catch(...);      // ② hub 选举（未 await）
void ensureAtSeriesConfigForCurrentIde({ appName, appRoot, uriScheme }).catch(() => {});  // ③ 与②并发！
context.subscriptions.push({ dispose: () => { void bridgeServer.stop(); } });
```

偏差点（相对 v1 契约与其他三插件）：

1. **③ 不等待 ②**——违反 v1 §9.1「必须先 await syncHubBundle 再写 MCP 配置」；首装竞态下 `~/.cursor/mcp.json` 可能指向尚不存在的 hub.js（下次 activate 会自愈）。
2. `detectHostApp(vscode.env)` 未传 `extensionPath`（Terminal/JumpServer/Grafana 都传了四元组）——对 Cursor/Kiro 等主流宿主检测结果一致，但对靠 `~/.<slug>/extensions` 路径识别的 fork IDE 会退化。
3. `ensureAtSeriesConfigForCurrentIde` 不传 `workspaceFolder` → Continue 目标永远跳过。
4. `McpConfigInstaller.ts` 与 Terminal 逐字节等价（仅少注释，diff 验证），installer 行为本身合规。
5. `hubSync.ts` pluginId `'at.database'`，与其他插件同构。

**BridgeServer（`src/mcp/BridgeServer.ts`）自实现，未复刻模板，偏差较多**：

- 鉴权：有 `timingSafeEqualToken`（合规），但 401 body 是 `{error:{message:'Unauthorized'}}` **缺 `code` 字段**（Hub 侧 health/tools 路径会落到 fallback `INTERNAL_ERROR`，功能不受阻）。
- `/invoke` 兼容两种请求形状：`{name, arguments}` 或 `{tool, args}`（超出契约的宽容，无害）。
- **无 per-tool 参数 schema 校验**（没有 bridgeSchemas.ts；`executeTool` 里 `String(args.x ?? '')` 硬转）→ 契约的 `422 VALIDATION_ERROR` 永远不会出现。
- **工具执行抛错时返回 `HTTP 200 + { ok:false, name, error:{message} }`**（L144–155）。这不在 v1 契约里：Hub 的 `bridgeInvoke` 对 2xx 只认 `ok===true`，否则 **throw `Invalid Bridge invoke success response`（INTERNAL_ERROR）**——即经由 hub.js 调用时，At-Database 的所有业务错误信息（如 “Connection not found: xx”）都会被吞成一句通用 INTERNAL_ERROR。嵌入式 Agent 若自己实现 invoke 客户端，可以宽容解析这个形状把 message 透传（见 §7）。
- 无 `USER_CANCELLED` 路径（因为根本没有确认弹窗，见 5.5）。
- registry 记录不带 `capabilities.connectedTargets`；health 恒 `connectedTargets: 0`；心跳 `publisher.heartbeat()` 不带 patch。
- 超大请求体：`readBody` 超 2MiB 直接 throw → 外层 500（而非契约的 413 `PAYLOAD_TOO_LARGE`）；也没有「未鉴权先拒再读 body」的顺序保护（先读 body 后进 handler）。
- 生命周期：`stop()`（非 `dispose()` 命名）做 clearInterval → unpublish → server.close，通过 subscriptions 的包装对象在 deactivate 触发——**unpublish 行为本身合规**。

**pluginId/bridgeId**：`AT_DATABASE_PLUGIN_ID = 'at.database'`（`src/mcp/toolCatalog.ts`）；bridgeId `randomUUID()`；token `createBridgeToken()`。

**凭据隔离**：`ConnectionManager` 把 DB 密码、SSH 密码、SSH 私钥 passphrase 分 key 存 SecretStorage；`db_list_connections` 只返回 `{id,label,driver,host,port,database}`。合规。

### 5.5 工具目录（`src/mcp/toolCatalog.ts`，共 12 个，前缀 `db_`）——**全部无确认弹窗**

| # | name | risk | 确认 | 摘要 |
|---|---|---|---|---|
| 1 | `db_list_connections` | read | 无 | 连接摘要（无凭据） |
| 2 | `db_list_databases` | read | 无 | `{connectionId*}` |
| 3 | `db_list_tables` | read | 无 | `{connectionId*, database*}` |
| 4 | `db_get_table_structure` | read | 无 | 列/类型/主键/索引/DDL |
| 5 | `db_execute_query` | **write** | **无！** | `{connectionId*, database?, sql*, limit?(默认100)}`；**任意 SQL 直达 `client.executeQuery`**——`safety/destructiveSql.ts` 与 `db/queryGuard.ts` 只被 `webview/QueryPanel.ts`、`webview/TableDataPanel.ts` 引用（rg 验证），Bridge 路径完全不经过 |
| 6 | `db_redis_scan` | read | 无 | SCAN 分页 |
| 7 | `db_redis_get` | read | 无 | 值/类型/TTL（string/hash/list/set/zset/stream） |
| 8 | `db_redis_set` | write | 无 | string/hash 写入 |
| 9 | `db_redis_xadd` | write | 无 | Stream 追加 + MAXLEN 修剪 |
| 10 | `db_redis_publish` | write | 无 | Pub/Sub 发布 |
| 11 | `db_get_slow_queries` | read | 无 | processlist / pg_stat_activity + 慢查询统计 |
| 12 | `db_compare_schemas` | read | 无 | 双库 diff + 迁移 DDL 生成 |

风险标注商榷：`db_execute_query` 能执行 `DROP TABLE`/`TRUNCATE`/DDL，按 v1 §6 定义（“Runs commands, raw terminal input, **SQL**, or equivalent” → exec）标 `exec` 更贴切；现标 `write` 且无插件内确认，直接违反 v1 §6「write/exec 的插件侧确认必须保留」与 ADR-001 决策第 9 条。

### 5.6 Skill

**不存在**。仓库无 `skills/` 目录；hub 仓库的 super-ops 也未收录 `at.database` 附录（其表格只有 terminal/jumpserver/grafana/nacos）。Agent 侧对该插件零操作规程。

### 5.7 文档

`docs/` 仅 `releases/`。**无 ADR、无需求文档**——四仓库中文档最薄。README.md（中文）是最详实的产品说明来源。

### 5.8 前端技术栈与 IPC

四插件中唯一的 **Vue 3 + Pinia** 前端：`webview/views/*.vue`（ConnectionForm、QueryWorkspace、RedisBrowser、SchemaDiffView、SlowQueryView、TableDataView、TableStructure 及 Shell 壳组件）、`webview/stores/*.ts`（每面板一个 Pinia store）、`webview/adapters/vscode-bridge.ts`（封装 `acquireVsCodeApi` 为 `BridgeApi.on(type, handler)/getState/setState` 事件总线）、`webview/lib/dbx`（Canvas 数据网格）、esbuild-plugin-vue3 构建。IPC 仍是 postMessage，但消息按 `{type, payload}` 经 vscode-bridge 分发。

### 5.9 对嵌入式 Agent 的影响与零改动验证

- **调用链可通**：registry 记录、/health、/tools、/invoke 成功路径全部符合契约，嵌入 Agent 无需该插件改代码即可发现并调用 12 个工具。
- **两个必须在 Agent 侧兜底的偏差**：
  1. invoke 失败返回 `200 {ok:false,…}` → 嵌入客户端不要复用 hub 的严格 `bridgeInvoke`，或包一层：2xx 且 `ok===false` 时按 `{code:'INTERNAL_ERROR', message: body.error?.message}` 归一。
  2. `db_execute_query` 等 write 工具无确认 → 嵌入 Agent 必须在**自己的编排层**对 `risk∈{write,exec}` 加确认门（正好与 v2 注解 `destructiveHint` 对齐），否则模型可无人值守执行任意 SQL。
- 结论：**技术上零改动可行，安全上不建议零改动**——最小修复是插件内给 5/8/9/10 号工具加 `showWarningMessage` 确认 + 把错误路径改为契约错误体（各 ~30 行）。

### 5.10 风险与缺口

见 §9 汇总（At-Database 占大头）。

---

## 6. 四插件交叉对比表

| 维度 | At-Terminal | AT-Jumpserver | At-grafana | At-Database |
|---|---|---|---|---|
| pluginId | `at.terminal` | `at.jumpserver` | `at.grafana` | `at.database` |
| pluginDisplayName | AT Terminal | AT JumpServer Terminal | AT Grafana | AT Database |
| 版本 / 扩展名 | 0.3.4 / `at-terminal(-mcp)` | 0.1.9 / `at-jumpserver-terminal` | 0.1.3 / `at-grafana` | 0.1.1 / `at-database(-mcp)` |
| 构建变体 | base + mcp（`MCP_ENABLED` define + hub stub） | 单变体，MCP 恒开 | 单变体，MCP 恒开 | base + mcp |
| 工具数 | 9 | 14 | 17 | 12 |
| risk 分布 | read 5 / write 3 / exec 1 | read 5 / write 5 / exec 4 | read 17 / 0 / 0 | read 8 / write 4 / exec 0 |
| 工具名前缀 | 无（v1 豁免的短名） | `jumpserver_` | `grafana_` | `db_` |
| write/exec 确认 UI | 有：命令三档信任 + SFTP 目录级授权（敏感路径双确认） | 有：exec/write 恒确认；SQL/Redis 只读判定免确认 | 不适用（全 read；门=每实例 `allowBackgroundAccess`） | **无任何确认** |
| 后台访问门 | 每服务器「允许后台连接」+ 信任三档 | 依附已连接 UI 终端（无后台直连） | 每实例 `allowBackgroundAccess`（默认关） | 无（配置了连接即可调用） |
| 写 MCP 配置 | 是（await hub 同步后；cursor/kiro/continue） | 是（同左） | 是（同左） | 是（**未 await hub 同步**；不支持 continue） |
| unpublish on deactivate | 是（dispose） | 是（dispose + 启动失败回滚） | 是（allSettled 收尾） | 是（stop） |
| USER_CANCELLED(499) | 是（精确消息匹配） | 是（`/cancelled/i` 宽匹配） | 无此路径 | 无此路径 |
| invoke 参数校验 | Zod（422） | Zod（422） | Zod（422，schema 缺失 fail-safe 500） | **无**（硬转 String） |
| 错误体合规 | 合规 | 合规 | 合规 | **200+ok:false 偏差；401 缺 code；413→500** |
| capabilities.connectedTargets | 有（已连接终端数，心跳更新） | 有 | 无 | 无（恒 0） |
| legacy 鉴权头 | `x-at-terminal-token` | `x-at-jumpserver-terminal-token` | 无 | 无 |
| 凭据存储 | SecretStorage（密码）| SecretStorage（bastion 密码） | SecretStorage（SA Token） | SecretStorage（DB 密码/SSH 密码/passphrase） |
| Skill | 有（+16 references，另有文档写作 skill） | 有 | 有（+2 references） | **无**（super-ops 亦未收录） |
| ADR/需求文档 | 5 篇 ADR（含确认策略 5 次修订） | 1 篇 ADR 副本 | 7 篇 ADR + requirements.md | **无** |
| 前端栈 | 纯 TS + xterm.js | 纯 TS + xterm.js | 纯 TS 表单 + iframe 内嵌真 Grafana（鉴权代理） | **Vue 3 + Pinia + Canvas 网格** |
| activationEvents | onStartupFinished + 2 views | onStartupFinished + 2 views | onStartupFinished | base: onView；mcp: +onStartupFinished |
| @at-series/mcp-hub | ^0.3.2 | ^0.3.2 | ^0.3.2 | ^0.3.2 |
| 零改动可行性 | ✅ 严格零改动 | ✅ 严格零改动 | ✅ 严格零改动 | ⚠️ 可通但需 Agent 侧兜底（错误体+确认门），建议小修 |

---

## 7. Agent 嵌入 Hub 后的调用序列建议

### 7.1 设计基线

at-opsAgent 不再让 IDE 起 `node ~/.at-series/mcp/hub.js`，而是在 **opsAgent 扩展进程内**复用 `@at-series/mcp-hub` 的库模块，自己扮演 Hub 角色：

- registry：`listBridgeRecords({ hostApp })` + `watchBridgeRegistry`（`packages/mcp-hub/src/registry/`）
- HTTP：`bridgeGetHealth` / `bridgeGetTools` / `bridgeInvoke`（`src/bridgeClient/http.ts`，自带 2s/5s/120s 超时、2MiB 限体、拒绝重定向）
- 聚合选路：`aggregateTools` / `orderBridgesForTool` / `pickBridgeForTool`（`src/hub/aggregate.ts`）
- 风险注解：`normalizeToolRisk` + v2 §8 映射（`src/hub/annotations.ts`）
- 审计：`src/audit/logger.ts` + `agentOpsLogPath`（保持与 hub.js 相同的 JSONL 取证格式）

这正是 ADR-001 决策第 5 条「Hub runtime 内嵌于 MCP-capable 插件」的对称形态，v2 §2 也预留了 embedding runtime 直接指定 discovery mode 的口子。**插件无感知：它们只对「registry 文件 + 带 token 的回环 HTTP」负责，谁来读/调无从区分。**

### 7.2 启动序列（opsAgent activate）

```text
1. hostApp = detectHostApp({ appName, appRoot, uriScheme, extensionPath })   // 与插件同宿主 → 同 slug，天然同仓
2. records = listBridgeRecords({ hostApp })                                   // ~/.at-series/bridges/<hostApp>/*.json
3. 过滤：updatedAt 距今 > 90_000ms 的记录标 stale（跳过探测，仅诊断展示）
4. 并行探测（每 bridge）：
     health = bridgeGetHealth(record)         // 2s 超时；失败 → unhealthy
     tools  = bridgeGetTools(record)          // 5s；health 成功才采信；失败回退 record.tools 快照
5. catalog = aggregateTools(healthyBridges)   // (pluginId, name) 折叠；跨插件同名冲突取赢家
6. watchBridgeRegistry({ hostApp, onChange: 重跑 2–5 })  // 原生 watch + ≤3s 轮询兜底
7. 目录治理（进程内等价 v2）：业务工具 > 20 时不要全量塞进模型上下文；
   实现 search/select 等价物（可直接内联 at_search_tools/at_get_tool/at_select_tools 的语义），
   并按 risk 映射 readOnlyHint/destructiveHint 注解供审批 UI 使用
```

刷新纪律（照抄 v1 §8.4）：成功刷新 2s 内不重复全量探测；探测失败的 bridge 3–5s 内跳过按需重试；周期性 re-health（失败者 3–5s、健康者 ≤15s）。

### 7.3 单次工具调用序列

```text
Agent 决定调用工具 T(args)
1. entry = catalog.lookup(T)；miss → 一次按需刷新再查；仍 miss → NOT_FOUND
2. risk 门（Agent 层，弥补插件差异）：
     entry.risk ∈ {write, exec} → opsAgent 自己的审批策略（至少对 at.database 必须拦，
     对其余三插件可放行让插件自己的模态弹窗兜底——双门不冲突，插件门是最终权威）
3. candidates = orderBridgesForTool(pluginId, T)   // connectedTargets desc, updatedAt desc
4. resp = bridgeInvoke(candidate, { name: T, arguments: args }, { timeoutMs: 120_000 })
     - 传输失败：立刻在内存标 unhealthy，换下一候选一次；全灭 → 「插件离线」
     - NOT_FOUND / 目标未知型 VALIDATION_ERROR：换同 pluginId 下一候选一次
     - USER_CANCELLED(499)：呈现为「用户在 IDE 中拒绝」，禁止自动重试
     - VALIDATION_ERROR(422)：把 message 回喂模型修参
     - UNAVAILABLE(503)：短退避后可重试（Grafana rate limiter 语义）
   ★ At-Database 兼容层：HTTP 2xx 且 body.ok === false 时，归一为
     { code: 'INTERNAL_ERROR', message: body.error?.message ?? 'tool failed' }
     （不要直接用严格版 bridgeInvoke，或 catch 其 'Invalid Bridge invoke success response' 后二次解析）
5. 审计：无论成败，按 v1 §3.4 追加 JSONL（agentOpsLogPath(hostApp, date, pid)），
   复用 hub 的 sanitize（敏感键+token 样式脱敏、4096B 截断）；写失败不影响返回
6. 大输出：信任插件自身限额（64KB/256KB、maxEntries、Grafana 12h/5MiB），
   Agent 层对 result 再设一道注入上下文前的截断阈值
```

### 7.4 会话与提示词层

- 把 `skills/super-ops/SKILL.md` 的强制流程、时间盒事故路径、红旗表移植为 opsAgent 系统提示；per-plugin skill（terminal/jumpserver/grafana）作为按需加载的 references。
- 为 `at.database` **补写 skill**（现缺）：LIMIT 纪律、先 `db_get_table_structure` 后查询、`db_execute_query` 高危声明、SCAN 优先。
- 「IDE 确认弹窗 ≠ 会话内授权」原则保留：即使插件弹了窗、用户点了确认，破坏性/生产影响操作仍应有对话内明示。

### 7.5 与现有 MCP 入口共存

插件仍会写 `~/.cursor/mcp.json` 的 `AT Series` 条目（零改动前提下不可避免）。选项：

1. 放任共存（IDE 原生 Agent 与 opsAgent 各自可调，registry/Bridge 天然多客户端安全——token 校验与并发队列都在插件侧）；
2. 引导用户执行各插件的 `*.uninstallAtSeriesMcpConfig` 命令收敛入口；
3. 后续插件版本给 installer 加「检测到 opsAgent 时跳过」逻辑（非零改动，列为可选演进）。

---

## 8. 零改动验证结论

> 判据：opsAgent 进程内读 `~/.at-series/bridges/<hostApp>/` + 带 token 的 HTTP invoke，插件不改一行代码能否被完整、安全地使用。

| 插件 | 结论 | 依据 |
|---|---|---|
| At-Terminal | **零改动 ✅** | Bridge/registry/错误体/确认/unpublish 全契约内；`syncPackagedHub` 与 MCP 配置写入对嵌入路径无副作用（仅多一个可选入口） |
| AT-Jumpserver | **零改动 ✅** | 同上；额外注意 exec 工具需用户已连接 UI 终端，属产品语义而非契约障碍 |
| At-grafana | **零改动 ✅** | 全 read + 每实例后台门 + 契约错误码；最顺滑的嵌入目标 |
| At-Database | **可通但打星 ⚠️** | 发现/健康/目录/成功调用全通；但 (a) 错误路径 `200+{ok:false}` 需 Agent 侧兼容解析（经标准 hub.js 反而信息更差）；(b) write 工具无插件内确认，零改动前提下安全门必须由 Agent 层补；(c) 413/401 形状小偏差不阻断。**建议对该插件做 ~30 行小修（确认弹窗 + 契约错误体）**，否则在 opsAgent 的策略引擎里把 `at.database` 的 write 工具列为强制人工审批 |

通用注意事项（不构成改动需求）：invoke 超时必须 ≥120s（插件确认弹窗计入）；多窗口多 bridge 用 `connectedTargets/updatedAt` 评分选路；`tools/list` 收缩（如做渐进暴露）不是 ACL，风控要建在调用路径上。

---

## 9. 风险与缺口总清单

### 9.1 At-Database（优先级最高）

1. **write 工具零确认**：`db_execute_query`（任意 SQL）、`db_redis_set/xadd/publish` 直达域层；`safety/destructiveSql.ts` 只保护 Webview 路径。违反 v1 §6 与 ADR-001#9。
2. **invoke 错误体不合契约**（`200 {ok:false}`）→ 经 hub.js 时错误信息被吞成 `INTERNAL_ERROR`。
3. `db_execute_query` 标 `write` 而非 `exec`——按 v1 §6 SQL 执行应为 exec；fail-closed 注解（destructiveHint）拿不到。
4. 无参数 schema 校验（永不返回 422）、401 缺 `code`、超体 500 而非 413、未鉴权请求先缓冲 body。
5. `ensureAtSeriesMcpConfig` 不等 `syncPackagedHub`（首装竞态）；`detectHostApp` 少传 `extensionPath`；Continue 目标永不安装。
6. 无 Skill、无 ADR、super-ops 未收录 → Agent 操作规程真空。
7. registry 无 `capabilities.connectedTargets` → 多窗口选路评分退化到只看 `updatedAt`。

### 9.2 其余插件的具体缺口

- At-Terminal：`policy` 信任档下未知命令默认放行（ADR-003 已知残留）；读取面无确认（有意）；命令策略读的是文本，远端 alias/改名免疫。
- AT-Jumpserver：`@modelcontextprotocol/sdk` 死依赖；SQL/Redis 只读判定为启发式，免确认边界依赖其正确性；exec 依赖 UI 终端在线（Agent 无法后台自愈式操作）。
- At-grafana：`grafana_query_datasource` 的 read 分类依赖路径限制（ADR-004 自认按 datasource 类型的端点白名单未做）；无写操作导致告警处置闭环缺失；嵌入面板无 WebSocket。

### 9.3 系列级/契约级约束（嵌入设计必须消化）

1. **`/invoke` 120s 上限内含人工确认**——Agent 的调用 UI 要能呈现「等待用户在 IDE 确认」状态；超时后选择项 TTL（Hub 默认 120s idle）也是按这个上限对齐的。
2. **2MiB 双向体积上限**：v2b「结果分页/截断」在 hub 路线图里仍是未开始项；超大结果（如全表 dump）会在传输层被腰斩，插件各自的 64KB/256KB 限额是第一道防线。
3. **`tools/list` ≠ ACL**：任何治理都必须落在 invoke 路径（Agent 层审批 + 插件层确认），列表收缩只是上下文优化。
4. **registry token 明文落盘**（`0600` 文件权限是唯一防线）：同用户任意进程可读走 token 直接调 Bridge——插件侧确认弹窗因此是不可移除的纵深（At-Database 缺的正是这一层）。
5. **多窗口多实例**：同插件多条 bridge 记录是常态，冲突/折叠规则（§1.7）必须在嵌入实现中保留。
6. **版本漂移**：四插件锁 `^0.3.2`，hub 仓 README 已是 `0.3.3`；嵌入实现应以包导出的 `AT_SERIES_BRIDGE_PROTOCOL_VERSION===1` 做兼容判断，而不是假设行为完全一致。
7. **审计连续性**：绕过 hub.js 后 `~/.at-series/logs/<hostApp>/agent-ops-*.jsonl` 不会自动产生；opsAgent 应复用 `src/audit/*` 保持同格式，否则丢失系列既有的本地取证面。
8. **工具名全局唯一**：新能力插件必须带前缀（v1 §4.4）；opsAgent 若自带内建工具，注意避开 `at_`（Hub 保留）与四插件现有名字空间。

### 9.4 建议的后续动作（按投入排序）

1. Agent 侧：invoke 客户端加 At-Database 兼容解析 + `risk∈{write,exec}` 审批门（零插件改动即可上线）。
2. 插件侧小修（如允许动 At-Database）：write 确认弹窗 + 契约错误体 + `db_execute_query` 改 exec。
3. 生态补齐：撰写 `at.database` skill 并入 super-ops 附录；清理 AT-Jumpserver 死依赖。
4. 演进项：installer 的「opsAgent 感知」开关；hub v2b 大结果分页；Grafana per-datasource 端点白名单。

---

*报告完。所有路径均相对 `/tmp/research/`；符号名与行为均经源码逐一核验（2026-08-28）。未修改任何业务仓库代码。*
