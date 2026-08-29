# Plan 05 · 审批悬挂：TTL 与软停解挂

> Status: Ready to execute
> Source: docs/15 P0-C；docs/reviews/round2/05-runtime.md §1.2、P0-1
> Depends on: 无
> Parallel-safe with: 01、07、09（文件：approvalService / chatService.abort，避免同时大改 chatService prompt 路径——那是 Plan 06）
> Module: `src/host/services/approvalService.ts`、`src/host/services/chatService.ts`、`src/protocol/host-protocol.ts`

## 0. 一句话目标 + 完成判据

待审批 promise 必须在超时或软停/硬停时落定，席位不能永久 busy。

完成判据：注入短超时后无人点批准 → waiter 以 rejected 结束且 runtime 收到结构化 JSON（非抛错盲试）；`abort('cancel')` 与 `abort('stop')` 一样 `rejectWaitersFor`。

## 1. 背景

`resolveSessionApproval`（`approvalService.ts:248-253`）把 promise 放进 `approvalWaiters`，只在 `applyApproval` / `rejectWaitersFor` / `clearSession` / `dispose` 决议。

`chatService.abort`（`:197-206`）：**仅 `mode==='stop'`** 调用 `rejectWaitersFor`。`cancel`（软停）只 `pool.abort(sid,'cancel')`，runtime 等 in-flight 工具结束——而 in-flight 正是卡在 `await requestApproval` 的 execute。软停永不完成。

无 TTL：用户走开，两席（`runtimePool` max 2）可被审批占满 → `SessionPoolExhaustedError`。

## 2. 硬约束

- 超时必须是 **rejected**，不能当 approved（fail-closed）。
- 拒绝结果必须是结构化 JSON（与现有审批拒绝同形），让模型「勿原样重试」，不要 throw 成 isError 成功假象。
- 令牌超时后不得留在 `currentApprovals`。
- runtime / policy 继续零 vscode；超时配置从 host 读，经已有 handlers 传入，或 approvalService 直接读 `vscode.workspace.getConfiguration`（该文件**已经** import vscode，合法）。

## 3. 现状代码

Waiter 登记：`:248-253`。决议：`resolveApprovalWaiter` `:365-371`。stop 才拒：`chatService.ts:199-200`。

`OPS_ERROR`（`host-protocol.ts:257-265`）无 TIMEOUT。runtime `applyToolGate` 已处理 rejected → 结构化 JSON（不要改这条语义，超时走同一 rejected 分支即可）。

## 4. 目标设计

```text
atOpsAgent.approval.timeoutMs   默认 900000（15min），最小 1000，0=禁用超时（仅测试/调试）

resolveSessionApproval
  登记 waiter 后：
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (resolveApprovalWaiter(briefId, 'rejected')) {
          // 同步清 UI：resolveBrief + broadcast approval/resolve
          // timeline { kind:'approval', decision:'timeout' } 或 decision:'rejected' + reason
          log 审批超时
        }
      }, timeoutMs)
      在 resolveApprovalWaiter 里 clearTimeout
    }

applyToolGate 看到 rejected
  → 现有拒绝 JSON；若 brief 已标 timeout，resultJson.code = OPS_APPROVAL_TIMEOUT
    （host 可在 waiter 上带 reason；runtime 已只区分 approved/rejected。
     推荐：reject 仍是 rejected，JSON 由 host 在 requestApproval 返回值
     扩展为 { decision, reason?: 'timeout'|'stop'|'user' }。
     若现有 requestApproval(): Promise<'approved'|'rejected'> 改动面大，
     保持 union，超时当 rejected；另在 result JSON 用文案「审批超时（N 分钟无人处理），不要原样重试」。）

abort('cancel') 也 rejectWaitersFor(sid)
```

**推荐最小改动：** 不改 `Promise<'approved'|'rejected'>` 类型。超时 = rejected。把超时文案放在 ApprovalBar 消失后的 notice：`ctx.emitAssistantNotice('审批已超时，已按拒绝处理', sessionId)`。runtime 拒绝 JSON 维持现状即可（模型看到拒绝）。席位释放靠 waiter resolve → execute 结束 → idle。

Waiter 结构扩展：

```ts
type ApprovalWaiter = {
  sessionId: string;
  commandSetSha256: string;
  promise: Promise<'approved'|'rejected'>;
  resolve: (d: 'approved'|'rejected') => void;
  timer?: ReturnType<typeof setTimeout>;
};
```

`resolveApprovalWaiter` 开头 `if (waiter.timer) clearTimeout(waiter.timer)`。

## 5. 任务拆分

### T1. 配置项

- 文件：`package.json` `contributes.configuration`；`package.nls.json` / `package.nls.zh-cn.json`
- 键：`atOpsAgent.approval.timeoutMs`
- 描述：中文「待审批超时（毫秒），超时按拒绝处理并释放会话；0 表示不超时」。默认 900000。
- Done when：设置页/JSON 能看到该项。

### T2. waiter TTL

- 文件：`approvalService.ts` `resolveSessionApproval`、`resolveApprovalWaiter`
- 读 `config.get('approval.timeoutMs', 900000)`，`Number.isFinite` 且 ≥0，非法当 900000。
- 测试：`test/approval-loop.test.ts` 新增：
  - `timeoutMs: 30` 且不调用 applyApproval → promise 在 200ms 内变为 rejected。
  - applyApproval 在超时前批准 → 不会随后又被 timer reject（timer 已 clear）；可用 fake timers。
- 需要把 timeoutMs 注入：测试若走真 vscode config 麻烦，给 `ApprovalService` 构造可选 `timeoutMs` 覆盖，或 `HostContext` 已有 config 替身。看现有 approval-loop 如何构造 service——**跟着现有 harness 加一个 setter/`_timeoutMsForTest`**。禁止为测 TTL 改生产默认成 30ms。
- Done when：上述两用例绿；生产默认仍 15min。

### T3. 超时后 UI 与 store

- 文件：同 `resolveApprovalWaiter` 当 decision 来自 timer：调用与 `applyApproval` 拒绝分支相同的 store 清理（`resolveBrief`、broadcast `approval/resolve`、timeline、删 briefMaps）。**不要**走 orchestrator.applyApproval 的 executing 推进。
- 抽 `finalizeRejection(briefId, reason: 'user'|'timeout'|'abort')` 避免复制。用户点拒绝仍走 `applyApproval`。
- 测试：超时后 `store.pendingBriefs` 不含该 brief；webview 协议 `approval/resolve` 被发（mock broadcast）。
- Done when：超时后 ApprovalBar 能消失（pending 清掉）。

### T4. abort('cancel') 解挂

- 文件：`chatService.ts:197-206`
- 目标：

```ts
abort(mode: 'cancel' | 'stop' = 'stop', sessionId?: string): void {
  const sid = sessionId ?? this.ctx.store.activeSessionId;
  this.ctx.approvals.rejectWaitersFor(sid); // stop 与 cancel 都拒 waiter
  if (mode === 'stop') {
    for (const taskId of ...) abortSubagentTask(...)
  }
  this.pool.abort(sid, mode);
}
```

软停仍等 in-flight **非审批**工具；审批等待视为立即结束（reject）。

- 测试：`test/runtime-pool.test.ts` 或 approval-loop：挂起审批 + abort cancel → waiter rejected 且 pool 能 markIdle（若测试能接到 runtime）。最低：单测 `rejectWaitersFor` 在 cancel 路径被调用——把 abort 里 reject 提前，用 mock approvals。
- 文档：`docs/07-security.md` 补一句「超时/软停/硬停均按拒绝落定 waiter」。
- Done when：软停不再依赖用户点拒绝。

### T5. 错误码（可选但建议同 PR）

- 文件：`host-protocol.ts` `OPS_ERROR.APPROVAL_TIMEOUT = 'OPS_APPROVAL_TIMEOUT'`
- runtime 拒绝 JSON：若能从 host 拿到 reason 再填 code；否则本 T 可只加常量，runtime 接线放到 Plan 06。
- Done when：常量存在；未接线也不要让测试依赖它。

## 6. 执行命令

```bash
npx vitest run test/approval-loop.test.ts test/runtime-pool.test.ts test/policy.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] 短超时测试：无人批准 → rejected → 席位可再 ensure
- [ ] 超时前批准：只批准一次，无二次 reject
- [ ] cancel 与 stop 都能解开 waiter
- [ ] 超时 fail-closed，不会 approved
- [ ] 默认 15 分钟，测试不改默认

## 8. 明确不做

- 不做超时自动批准
- 不把超时决策发到 IM 当「已批准」
- 不持久化 waiter（重载本就会丢，正确）

## 9. 风险与回滚

- fake timers 与真实 Promise 混用容易 flaky：优先 `timeoutMs: 50` + `await vi.waitFor`。
- 回滚：删 timer 与 cancel 那一行 reject，恢复仅 stop 解挂（会回到 hang bug）。
