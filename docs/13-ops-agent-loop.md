# 13 · 运维 Agent Loop 重设计（基于 pi，对照 Claude Code / Codex / DeepSeek）

对照新一轮「巡检当前连接服务器」实录：`ops_list_providers` 已返回 `at.terminal`（`toolNames` 11 个、`bridgeCount=4`），但 `healthy:false`；随后 `ops_get_tool` / `ops_search_tools` 全空。模型卡在发现仪式，**从未 `ops_select_tools`，从未调用业务工具**。

本设计不 fork pi 的 agent loop（ADR-002），在 pi 的 `customTools` / `setActiveTools` / `beforeToolCall` / `systemPromptOverride` 上做运维 harness。

## 0. 结论先行

成熟 coding agent（Claude Code、Codex CLI、OpenCode、DeepSeek Harness）的共同结构是：

```text
harness 先注入现场 → 模型在已启用的工具上行动 → 结果回灌 → 必要时压缩
```

不是：

```text
模型用元工具把世界从零发现一遍 → 再决定能不能干活
```

at-opsAgent 把 Hub 的「声明清单」（插件 manifest `toolNames`）和「live catalog」（健康桥 MCP `listTools`）混成一件事。`healthy:false` 时 live catalog 为空，`listAllTools()` 返回 `[]`，`ops_search_tools`/`ops_get_tool` 对已经写在 provider 上的名字报 NOT_FOUND。L2 又写「调用前先 ops_get_tool」，于是死锁。

**战略一句话：host 注入 L-env 现场；声明工具直接 select；get_tool/search 禁止空转；不健康 = 向用户交代桥，不是假装没工具。pi loop 本身不重写。**

## 1. 实录根因（代码）

| 观察 | 代码 |
|------|------|
| providers 列出 `toolNames` | Hub 插件清单，与桥是否 healthy 无关（`mapHubProviders`） |
| `healthy:false` | `healthyBridges.length === 0`；4 座桥都未 ready |
| search/get_tool 全空 | `searchTools`/`getTool` 只查 `hub.listAllTools()` ← `catalog.tools`（仅健康桥 MCP 目录） |
| 模型去 get_tool | L2：「调用前先确认参数」 |
| Hub start 非阻塞 | `HubHost.start()` 后台 `scheduleSync`；首条消息可能撞上未 sync 完的空 catalog |

`connectedTargets` 只从 **healthy** 桥汇总。用户 IDE 里明明连着 SSH，只要桥心跳不健康，Agent 侧就既没有 live 工具、也没有 connected 计数。

## 2. 业界对照（该学 / 不该学）

| 来源 | 该学 | 不该学 |
|------|------|--------|
| **Claude Code** | 进 loop 前注入 cwd/git/`CLAUDE.md`；gather → act → verify；失败工具给可执行下一步；子代理回摘要 | 把运维做成 coding 四件套；动态 JS 编排 1000 子代理 |
| **Codex CLI** | ContextManager 注入 reference context，未变不重注；并行工具；会话 JSONL | 内核级 sandbox（我们双闸 + Bridge 已有边界） |
| **pi SDK（我们的内核）** | `createAgentSession` + `customTools` + `setActiveToolsByName` + `beforeToolCall` + skills 渐进披露 + `promptSnippet` | 打开 bash/write/edit；fork Studio；自研 agent-loop |
| **DeepSeek Harness** | 重复调用 advisory nudge；工具错误结构化；步数预算 | 无上限 while(true)（我们已有 subagent budget，主会话也应对空转发现设软顶） |
| **OpenCode / Cline** | 工具面由 harness 按场景打开，模型直接用 | 全量 dump 工具 schema（tools 税） |

运维特化（对手没有、必须保留）：Playbook 状态机、9 要素双闸、证据三态、GuidedManual、调查/执行永不同体。

## 3. 目标 loop（单台已连 SSH 巡检）

```text
用户：巡检当前连接的服务器
  host（模型开口前）:
    1. await hub.refresh()           // 等首轮 catalog，消掉 start 竞态
    2. 注入 L-env：hostApp / 各插件 healthy、bridgeCount、
       declared toolNames、liveToolCount、catalogLiveToolCount、hint
    3. 若 playbook 在跑，叠 L4
  模型:
    读 L-env。若 at.terminal 已声明 list_ssh_servers：
      立刻 ops_select_tools {pluginIds:["at.terminal"]}
      不要 ops_get_tool / ops_search_tools
    select 后 exposed 非空 → 直接 list_ssh_servers / get_terminal_context /
      run_remote_command（只读）
    select 后 exposed 仍空 或 healthy=false：
      用中文告诉用户「AT Terminal 桥未就绪（N 座桥 unhealthy），
      请在 IDE 确认 SSH 终端仍连接」——禁止再 search/get_tool 空转
```

多主机 / 多插件面才 `ops_dispatch_subagent`。

## 4. 落地项（本轮 P0）

### 4.1 发现层（`src/runtime/discovery-tools.ts`）

- `listProviders` **包装** hub 结果：增加 `catalogLiveToolCount`、每插件 `liveToolCount`、顶层 `hint`（live=0 但有声明工具时必填）。
- `searchTools`：live catalog 命中优先；若 catalog 空/未命中，回退 `providers[].toolNames` 作 `live:false` stub（descriptionPreview 写清「请 select，不要 get_tool」）。
- `getTool`：live descriptor 优先；仅声明未 live 时返回 `error: "NOT_IN_LIVE_CATALOG"` + `pluginId` + `healthy` + `next: { tool:"ops_select_tools", args:{ pluginIds, mode:"add" } }`。真正未知才 `NOT_FOUND`。
- `ops_get_tool` / `ops_search_tools` 的 description 改为：声明名在 list_providers 里就直接 select，禁止对声明名循环 get/search。

不改 Hub 引擎；不把不健康桥的 MCP 工具假装 healthy。

### 4.2 L-env 现场注入（Claude 式 gather-context）

新模块 `src/prompts/env-snapshot.ts`：

```ts
formatEnvSnapshot(input: {
  hostApp: string;
  catalogLiveToolCount: number;
  exposed: string[];
  providers: Array<{ pluginId, healthy, bridgeCount, toolNames, liveToolCount? }>;
}): string  // 控制在 ~40 行内
```

`composeSystemPrompt` / `buildSystemPrompt` 增加可选 `envLayer`。L0–L1 仍不可覆盖。

Host 每条 `chat/prompt` 在 `runtime.prompt` 前：

1. `await hub.refresh()`
2. 合成 `envLayer` + 当前 L4
3. `runtime.setSystemPrompt(...)`

L4 注入器不得擦掉 L-env（`buildSystemPrompt` 必须同时带上两者）。

### 4.3 提示词（L0 / L2）

删除「调用前先 ops_get_tool」。改为：

- 先读 L-env；有声明工具 → `ops_select_tools`；一等工具名直接调用。
- `ops_get_tool` 只用于 live catalog 里、参数不清楚的工具。
- `healthy:false` 不是「没有这个插件」：select 后 exposed 空 → 向用户交代桥，停止发现循环。
- 同一发现工具连续失败禁止换关键词重搜。

### 4.4 主会话发现空转软顶（DeepSeek nudge）

runtime 包装 `ops_search_tools` / `ops_get_tool`：同一工具 + 规范化参数连续 ≥2 次空结果，在 JSON 里附加 `nudge`：「停止 search/get_tool，对 list_providers 的 pluginIds 做 ops_select_tools；若 unhealthy 告知用户。」不 block。

### 4.5 明确不做（本轮）

- 不 fork / 不替换 pi `agentLoop`。
- 不按 NL 关键词自动 `ops_start_playbook`（仍由模型决定）。
- 不自动 select 全部插件（tools 税）。可以在 L-env hint 里点名「巡检应 select at.terminal」，不由 host 静默 select（选择仍要可审计）。若后续要 harness 预选，必须写 timeline 事件。
- 不打开 pi bash/write/edit。

## 5. 验收

- 单元：catalog 空 + provider 声明 `list_ssh_servers` → search 有 stub；get_tool 返回 `NOT_IN_LIVE_CATALOG` 且带 next；list_providers 带 hint。
- 单元：`formatEnvSnapshot` 含 unhealthy 插件与「不要 get_tool」。
- 单元：L2 不再包含「调用前先确认参数」/「调用前先看清参数」。
- typecheck + 全量 vitest + compile。
- 人工：VSIX 对已连接但桥短暂 unhealthy 的终端说「巡检」——不得再出现 search total=0 空转；应 select 或明确说桥未就绪。
