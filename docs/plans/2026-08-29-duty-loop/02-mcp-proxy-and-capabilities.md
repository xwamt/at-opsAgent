# Plan 02 · 外部 MCP 风险接线与 Capabilities

> Status: Ready to execute
> Source: docs/15 P0-F、P1-8；reviews/round2/03-mcphub.md §2.2、§2.5、§4
> Depends on: 无。P0-F 可进 Wave 1；P1-8 可同文件后半段，允许拆 PR。
> Parallel-safe with: 03、05、06（避开 approvalService 时：本 plan 改 `gateToolCall` 前 15 行，Plan 05 改 waiter——**可以同文件不同函数，合并时注意**）
> Module: `src/mcp-client/external.ts`、`approvalService.ts`、`runtimeEvents.ts`、settings webview、`activate.ts`

## 0. 一句话目标 + 完成判据

`mcp_list_servers` / `mcp_search_tools` 按 read 放行（默认 sessionRequiredFor=write-exec 时不弹 9 要素）；`mcp_call_tool` 仍 write。能力页展示 live 工具数、risk、断桥可诊断。

## 1. 背景

`RISK_BY_PROXY_TOOL`（`external.ts:367-373`）list/search=read、call=write，**gate 没用**。`gateToolCall`（`approvalService.ts:78-80`）：

```ts
const descriptor = ctx.hub.listAllTools().find((t) => t.name === toolName);
const risk = descriptor?.risk ?? (toolName.startsWith('ops_') ? 'read' : 'exec');
```

mcp_* 不在 Hub catalog → fail-closed **exec**。`runtimeEvents.ts:63-67` 同样逻辑，UI 红徽章。

CapabilitiesTab 只有 displayName/healthy/pluginId/toolCount/bridgeCount。

`activate.ts:53-58` discovery 只在创建时读一次，改设置不重建 Hub。

## 2. 硬约束

- 未知非 ops_ 工具继续 fail-closed exec
- 不把第三方 MCP 与 AT Bridge 一等并列、不合成一套 meta-tool
- selection 不是 ACL
- 不造 Jenkins 写工具

## 3. 现状代码

见 §1。`EXTERNAL_MCP_PROXY_TOOL_NAMES` 在 `external.ts:355`。已 `export * from './external'`（`mcp-client/index.ts`）。

## 4. 目标设计

```ts
import { RISK_BY_PROXY_TOOL, EXTERNAL_MCP_PROXY_TOOL_NAMES } from '../mcp-client';

function resolveToolRisk(toolName: string, descriptor?: { risk?: string }): Risk {
  if (descriptor?.risk) return descriptor.risk;
  if (toolName.startsWith('ops_')) return 'read';
  if ((EXTERNAL_MCP_PROXY_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return RISK_BY_PROXY_TOOL[toolName as keyof typeof RISK_BY_PROXY_TOOL];
  }
  return 'exec';
}
```

抽到 `src/policy/riskLookup.ts`（无 vscode）供 approvalService 与 runtimeEvents 共用，避免两处漂移。

## 5. 任务拆分

### T1. 抽出 resolveToolRisk + gate/UI 接线（P0-F）

- 文件：新 `src/policy/riskLookup.ts`（或放 `src/mcp-client/riskLookup.ts` 以免 policy 依赖 mcp 名）；`approvalService.ts:78-80`；`runtimeEvents.ts:63-67`
- 测试：`test/policy-gaps.test.ts`：
  - `mcp_list_servers` needSessionApproval === false（sessionRequiredFor write-exec）
  - `mcp_search_tools` 同
  - `mcp_call_tool` needSessionApproval === true，risk write
  - `unknown_tool` 仍 exec + 要审批
- Done when：三代理风险与 RISK_BY_PROXY_TOOL 一致；未知仍 exec

### T2. Capabilities 快照带 live 注解（P1-8 数据）

- 文件：`src/host/services/configService.ts` 现在 `getProviders()` 裸数据（约 :73-79）
- 目标：改用发现层 `listProviders` 同类结构：每插件 `toolNames`、`healthy`、`liveToolCount`、`catalogLiveToolCount`、`connectedTargets?`
- 协议：扩展 settings hydrate 的 provider 类型（`docs/schemas` 或 host-protocol settings 段）。缺字段旧 UI 仍能渲染。
- 测试：`test/settings-ui.test.ts` 或 mcp/hub 测试断言 snapshot 含 liveToolCount
- Done when：webview 能读到 live 计数

### T3. CapabilitiesTab UI

- 文件：`CapabilitiesTab.vue`、`webview-settings/i18n.ts`
- 卡片可展开：工具名列表 + risk 徽章（read/write/exec 三色已有 class）
- unhealthy：按钮「运行诊断」调已有 `store.diagnose()`（现在是页级按钮，复制到卡片）
- 空态文案保持；无插件时加一句「安装 AT Terminal / Grafana 等能力插件后会出现在这里」
- i18n zh+en 新键
- Done when：settings-ui 测试或至少 i18n 键双包齐全

### T4. discovery 配置热生效

- 文件：`activate.ts` 或 `configService`
- `vscode.workspace.onDidChangeConfiguration`，`affectsConfiguration('atOpsAgent.discovery')` 时：
  - **最小可用**：settings 页提示「需重载窗口」notice（P1 短期）
  - **目标**：销毁并重建 HubHost 很难（controller 已持有 hub）。更稳：HubHost 若支持 `setDiscovery({mode,threshold})` 就加；没有则 log + 状态栏「发现设置将在重载后生效」。
- 执行者先读 `AtSeriesHubHost` 能否在不 dispose runtime 的情况下改 mode。不能则只做提示，不要假装热生效。
- Done when：改 threshold 后用户能感知「未生效/已生效」之一，禁止静默 no-op

### T5. 断桥 notice

- 文件：`hostController` 或 configService `handleToolCatalogChange`
- 当 removed 工具名与当前 `hub.selection.state().selected` 相交非空 → `emitAssistantNotice('能力插件桥断开，N 个工具暂不可用', activeSession)`
- 恢复（added ∩ 曾选）发对偶 notice
- 测试：单测 removed→notice（mock emit）
- Done when：拔桥有聊天提示

### T6. directTools 白名单 enforce（P1 可选同 PR）

- 文件：`external.ts` search/call
- 若该 server 配置了 `directTools` 非空数组，call/search 结果过滤到名单；越界返回 JSON `{ error: 'TOOL_NOT_IN_DIRECT_TOOLS', name }`
- 测试：`test/mcp-proxy.test.ts`
- Done when：越界不真正 call

### T7. UNAVAILABLE 原文锁（P1）

- 文件：`test/hub-host.test.ts`、`src/prompts/layers.ts` L2 加一行
- 断言 Bridge 返回含 `UNAVAILABLE` 的 message 原样出现在 invoke 结果里
- Done when：单测 + L2 文案

## 6. 执行命令

```bash
npx vitest run test/policy-gaps.test.ts test/policy.test.ts test/mcp-proxy.test.ts test/mcp-client.test.ts test/hub-host.test.ts test/settings-ui.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] 列第三方 MCP 服务器不弹 9 要素
- [ ] 调用第三方工具仍弹
- [ ] 能力页能看到工具名
- [ ] 改 discovery 不再完全没反馈

## 8. 明确不做

- per-plugin MCP、selection=ACL、写 MCP、host 静默全选、exports

## 9. 风险

- 把 resolveToolRisk 放错层导致循环 import：mcp-client → 不要 import policy。riskLookup 放 `src/mcp-client/proxyRisk.ts` 最干净。
