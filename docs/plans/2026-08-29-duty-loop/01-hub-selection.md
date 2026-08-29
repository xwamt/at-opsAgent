# Plan 01 · Hub 选择面：关闭 idle TTL、对账 selectedNames、任务结束 clear

> Status: Ready to execute
> Source: docs/15 P0-A；docs/reviews/round2/03-mcphub.md §2.1–2.3、§4 P0-1/P0-2
> Depends on: 无（clear 的 close 挂钩在 Plan 03 成功路径上补一刀，本 plan 先把 API 与 eviction 清完）
> Parallel-safe with: 05、07、09
> Module: `src/hub-host`、`src/host/services/playbookService.ts`、`src/host/services/chatService.ts`

## 0. 一句话目标 + 完成判据

嵌入 Hub 不再用包默认 120s idle 自动 clear；adapter 的 `selectedNames` 与引擎暴露面始终一致；playbook 成功 closed 与会话驱逐时调用 `hub.selection.clear()`。

完成判据：select 后即使 `refreshCatalog` 被反复调用，暴露面不缩；`closePlaybook` 成功后 `selection.state().selected` 为空；investigating 中模型调 `ops_clear_tool_selection` 仍被 policy 拒绝。

## 1. 背景与运维影响

`createHubRuntime` 在 `src/hub-host/index.ts:223` 使用 `this.options.selectionIdleMs ?? DEFAULT_TOOL_SELECTION_IDLE_MS`。`DEFAULT_TOOL_SELECTION_IDLE_MS` 来自 `@at-series/mcp-hub`（0.3.3 包内为 `120000`）。引擎在 `refreshCatalog` / `listTools` / `callTool` 入口 `maybeAutoClearSelection`：120s 无 callTool 即清空。

值班场景：用户读输出、write/exec 审批挂起（闸门在 `hub.invoke` 之前，不产生 selection activity）都会触发。后果：L-env 显示「exposed: 无」；investigating 下 `replace` 被 policy 拒绝，只能瞎试 `add`。

同时 `AtSeriesHubHost.selectedNames` 只在自己的 `selectTools` / `clearSelection` 里更新（`:418`、`:431`）。引擎 idle-clear 不经过 adapter → `selection.state().selected` 撒谎。

`closePlaybook`（`playbookService.ts:232-256`）只 `selectCounts.set(sid, 0)`，从不 `selection.clear()`。`onSessionEvicted`（`chatService.ts:240-246`）清审批/playbook/L-env，也不清 Hub 选择。

## 2. 硬约束

- selection **不是 ACL**（Hub v2 / `discovery-tools.ts` 文件头）。关 TTL 只影响 `tools/list` 暴露，不改变 `invoke` 路由。
- 调查中禁止 clear：`src/policy/index.ts` 规则保留；本 plan 只在 **成功 closed** 与 **驱逐** 清。
- 不要把 `selectionIdleMs: 0` 写成 installer 环境变量；嵌入路径显式传 0。
- 不要 `syncHubBundle`。

## 3. 现状代码

**启动（未传 0）：**

```217:228:src/hub-host/index.ts
        this.runtime = await createHubRuntime({
          hostApp: this.options.hostApp,
          hubVersion: AGENT_HUB_VERSION,
          home: this.options.home,
          discoveryMode: this.options.discoveryMode,
          discoveryThreshold: this.options.discoveryThreshold,
          selectionIdleMs: this.options.selectionIdleMs ?? DEFAULT_TOOL_SELECTION_IDLE_MS,
          selectionMaxCalls: 0,
```

`AtSeriesHubHostOptions.selectionIdleMs` 已可选（`:47`），host `activate.ts` 创建 HubHost 时**没传**该字段。

**公开 API 已有 clear：**

```194:198:src/hub-host/index.ts
  readonly selection: SelectionController = {
    state: () => this.selectionState(),
    select: (input) => this.selectTools(input),
    clear: () => this.clearSelection(),
```

**close 不清选择：** `playbookService.ts:253-256` 只删 run、reset selectCount。

**驱逐不清选择：** `chatService.ts:240-246`。

**syncOnce：** `hub-host/index.ts:453` 起 `refreshCatalog` 后重算 `exposedTools`。此处没有「引擎已空选但 selectedNames 非空 → 对齐」的逻辑。

## 4. 目标设计

```text
activate / 测试创建 HubHost
  → options.selectionIdleMs = 0  （默认；测试可注入非 0 验证对账）
  → createHubRuntime({ selectionIdleMs: 0, selectionMaxCalls: 0 })

refresh/syncOnce
  → 读引擎当前 exposed 业务工具名集合 E
  → 若 E 为空且 this.selectedNames.length > 0
       则 this.selectedNames = [] 并 fire selectionEmitter
  → （TTL=0 时这条是防御；TTL>0 的测试夹具仍能测对账）

closePlaybook 成功（stage===closed）
  → try { await ctx.hub.selection.clear() } catch 只 log
  → 可选 timeline { kind:'selection', action:'clear', reason:'playbook-closed' }

onSessionEvicted
  → 同样 try clear（失败 log）
```

默认 0 的位置：**两处都写死 0**，避免漏传。

1. `AtSeriesHubHost.start`：`selectionIdleMs: this.options.selectionIdleMs ?? 0`（改默认，不再用包常量）。
2. `activate.ts` 创建 options 时显式 `selectionIdleMs: 0`。

`selectionState().idleMs` 必须反映真实传入值（改 `??` 链后自然变成 0）。

## 5. 任务拆分

### T1. 默认 idleMs=0

- 文件：`src/hub-host/index.ts`
- 符号：`start()` 里 `createHubRuntime` 参数；`selectionState()` 的 `idleMs`
- 当前：`?? DEFAULT_TOOL_SELECTION_IDLE_MS`
- 目标：`?? 0`。可删除对 `DEFAULT_TOOL_SELECTION_IDLE_MS` 的 import（若无其它引用）。
- 测试：`test/hub-host.test.ts` 新增 `selection idleMs defaults to 0`：`host.selection.state().idleMs === 0`。另保留一个用例 `options.selectionIdleMs: 1` 透传。
- 文档：`docs/02-capability-hub.md` §3.1 删除「嵌入路径用运行时默认 120s」；改为「嵌入路径强制 0，选择纪律由 policy + playbook 负责」。
- Done when：
  - [ ] `rg DEFAULT_TOOL_SELECTION_IDLE_MS src/hub-host` 为空（或仅注释）
  - [ ] 新单测绿
  - [ ] docs/02 已改

### T2. syncOnce 对账 selectedNames

- 文件：`src/hub-host/index.ts` `syncOnce`
- 当前：刷新 catalog、重算 exposed，不碰 `selectedNames`
- 目标：在写出 `this.exposedTools` 之后：

```ts
const exposedBusiness = this.exposedTools.filter((t) => !META_TOOL_NAMES.has(t.name));
if (exposedBusiness.length === 0 && this.selectedNames.length > 0) {
  this.selectedNames = [];
  this.selectionEmitter.fire(this.selectionState());
}
```

注意：discovery mode=off 或低于 threshold 时「未 select 也全量暴露」，`exposedBusiness.length === 0` 只在「真的没有 winner / 已被 clear」时成立，不会误清「用户刚 select 但仍在 sync」的窗口——若担心竞态，改为：比较引擎 `at_list_providers` 或 runtime 若导出 selection；**不要**在「有业务工具暴露」时清空。

若包 API 能读当前 selection，优先对账「引擎 selected vs adapter selectedNames」而不是「exposed 为空」。执行时先读 `node_modules/@at-series/mcp-hub` 是否有 `getSelectionState`。没有则用 exposed 启发式，并在 docs/02 记一笔「P2 向上游要 getSelectionState」（Plan 12）。

- 测试：用现有 fake bridge。步骤：select 一个 pluginId → 断言 selected 非空 → 直接调 `host.selection.clear()` → sync → selected 空。对账用例：若可 mock runtime 使 refresh 后 exposed 为空，断言 adapter selected 被清空。做不到 mock 就测 clear 路径 + 注释「引擎 TTL 已关，对账为防御」。
- Done when：
  - [ ] 对账代码有注释说明为何不是 ACL
  - [ ] 单测覆盖 clear 后 state.selected=[]

### T3. 驱逐时 clear

- 文件：`src/host/services/chatService.ts` `onSessionEvicted`
- 当前：清 approvals/playbooks/liveLayers/usage/subagents
- 目标：追加

```ts
void this.ctx.hub.selection.clear().catch((err) => {
  this.ctx.log(`[hub] eviction clear 失败: ${describeError(err)}`);
});
```

- 测试：若 `test/runtime-pool.test.ts` 或 chat 服务测试有 eviction，补「evict 调用 clear」。没有现成 host 集成测时，抽 `onSessionEvicted` 依赖注入困难——最低：给 HubHost 一个计数 mock 较难。可接受：在 `test/hub-host.test.ts` 只测 clear 本身；host 侧用一小段提取函数 `clearHubSelection(hub, log)` 单测「reject 不抛」。
- Done when：
  - [ ] eviction 路径有 clear
  - [ ] clear 失败不导致驱逐抛错

### T4. closePlaybook 成功后 clear（与 Plan 03 接口）

- 文件：`src/host/services/playbookService.ts` `closePlaybook`
- **本 T 只在 `return { ok: true }` 之前**调用 `await this.ctx.hub.selection.clear()`（try/catch log）。
- Plan 03 会改 close 的阶段推进；**不要在本 T 改 tryAdvance 逻辑**。先把挂钩打上：即使现在 investigating close 失败，挂钩也只在 ok 路径。Plan 03 修通后挂钩自动生效。
- 测试：Plan 03 的 playbook-tools 测试会覆盖「investigating close 成功 → selected 空」。本 plan 先加一个 **orchestrator 已在 reporting 的 close**：`tryAdvance('closed')` 当前能成功的阶段（reporting/escalated）→ 若测试能注入 fake hub，断言 clear 被调。做不到 fake hub：写 `test/playbook-tools.test.ts` 注释指向 Plan 03 T-close-clear。
- 文档：docs/02 §3.2 表「任务 Closed 时 Orchestrator 调用 selection.clear()」改为「host PlaybookService.closePlaybook 成功路径调用 hub.selection.clear()」。
- Done when：
  - [ ] `closePlaybook` ok 分支含 clear
  - [ ] 失败分支（无法收尾）**不** clear

### T5. activate 显式传 0

- 文件：`src/host/activate.ts` 创建 HubHost 处（约 :53-60）
- 目标：`selectionIdleMs: 0` 写进 options，双保险。
- 测试：不强制（T1 已覆盖默认）。
- Done when：activate 源码可见 `selectionIdleMs: 0`

## 6. 执行命令

```bash
npx vitest run test/hub-host.test.ts test/discovery-tools.test.ts test/policy.test.ts test/policy-gaps.test.ts
npm run typecheck
```

全量：`npx vitest run`

## 7. 验收清单

- [ ] 新 HubHost 的 `selection.state().idleMs === 0`
- [ ] 调查中 `ops_clear_tool_selection` 仍 block（既有 policy 测试不红）
- [ ] reporting 状态 close 成功后 selected=[]（或 Plan 03 合并后 investigating close 也如此）
- [ ] docs/02 §3.1 不再写 120s 嵌入默认

## 8. 明确不做

- 不把未 select 的 `tools/call` 改成拒绝（INV-5）
- 不在 investigating 自动 clear
- 不改 Hub npm 包源码（本仓只传参数）
- 不引入第二套 MCP server

## 9. 风险与回滚

- 风险：mode=auto 且工具数 ≤20 时本来全量暴露，idle clear 本来也很少被用户感知；关 TTL 后「上一任务工具面漂到下一任务」会更明显 → **必须靠 T4/T3 clear 兜住**。若只合 T1 不合 T4，暴露面会一直堆着。因此 T1+T3+T4 同一 PR。
- 回滚：把 `?? 0` 改回包默认，并删 clear 挂钩。
