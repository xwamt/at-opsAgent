# Plan 03 · Playbook 状态机单真源：investigating 能一次收尾

> Status: Ready to execute
> Source: docs/15 P0-B；docs/reviews/round2/01-orchestration.md R1
> Depends on: Plan 01 T4 挂钩已存在（clear 调用点）；本 plan 让 close 从 investigating 真正走到 ok
> Parallel-safe with: 02、05、06（避开 playbookService.ts 的 close 段时）
> Module: `src/orchestrator`、`src/host/services/playbookService.ts`、`src/host/hostTypes.ts`、`src/runtime/playbook-tools.ts`

## 0. 一句话目标 + 完成判据

host 不再维护 `DEFAULT_NEXT_STAGE`；缺省推进与收尾全部走 orchestrator 的 `advanceStage` / `legalNextStages` / `closeRun`。`pb.inspection` 在 investigating 调一次 `ops_close_playbook` 成功，阶段事件 synthesizing→reporting→closed，并触发 Plan 01 的 selection.clear。

## 1. 背景

`PlaybookService.closePlaybook`（`:241-250`）硬编码：非 reporting/escalated 时 `tryAdvance('reporting')`，再 `tryAdvance('closed')`。

`STAGE_TRANSITIONS.investigating = ['synthesizing','escalated']`（`engine.ts:13`），**没有** investigating→reporting。于是 `tryAdvance(run,'reporting')` 进 catch、返回 undefined，stage 仍是 investigating，再 `tryAdvance('closed')` 也非法 → `{ ok:false, error:'无法从 investigating 收尾到 closed' }`。

`advancePlaybookForPrompt` 把首条消息推到 investigating（`:300-314`）。巡检 yaml 声明了 synthesizing/reporting/closed（`skills/playbooks/daily-inspection/playbook.yaml`），orchestrator 的 `closeRun` BFS 能走 investigating→synthesizing→reporting→closed，但 host **不用** `closeRun`。

缺省 `advancePlaybook` 用 `DEFAULT_NEXT_STAGE`（`playbookService.ts:25-35`）。`guidedManual` host 映射到 `verifying`，orchestrator `legalNextStages[0]` 因表顺序 `['reporting','verifying']` 是 **reporting**。docs/04 §2.2 要求用户完成后 → Verifying。

`tryAdvance` 吞掉 `IllegalStageTransitionError` 的允许列表，工具结果只有「无法从 X 迁移到 Y」（`:226`），与 `playbook-tools.ts` 描述「列出合法下一步」不符。

`OrchestratorLike`（`hostTypes.ts:89-115`）没有 `advanceStage` / `legalNextStages` / `closeRun`，但 `src/orchestrator/index.ts:232-281` 已经实现。

## 2. 硬约束

- 模型不能直接把 stage 写成 closed；必须经 closeRun/advanceTo。
- `ensureVisibleInspectionReport` 在 close 前调用，保留（`playbookService.ts:238`）。
- 不要 NL 正则自动开链路。
- `pb.security-triage` 仍不能进入 executing（yaml 未声明）。
- runtime/orchestrator 继续零 vscode。

## 3. 现状代码

见 §1。`closeRun` 已存在且有 `test/orchestrator.test.ts` / `test/playbook-eval.test.ts` 覆盖 BFS。host 的 `tryAdvance` 只调 `advanceTo`。

`IllegalStageTransitionError` 已含允许下一步（`engine.ts:26-41`）。

## 4. 目标设计

```text
OrchestratorLike 增加：
  advanceStage?(run, stage?: StageId): PlaybookRunLike
  legalNextStages?(run): StageId[]
  closeRun?(run): PlaybookRunLike

PlaybookService.advancePlaybook(stage?)
  → orchestrator.advanceStage(run, stage as StageId | undefined)
  → catch IllegalStageTransitionError → { ok:false, error, allowedNext }

PlaybookService.closePlaybook
  → ensureVisibleInspectionReport
  → orchestrator.closeRun(run)
  → 逐步已由 closeRun 内部 advanceTo emit
  → runs.delete / selectCounts=0
  → await hub.selection.clear()   // Plan 01 T4
  → { ok:true, stage:'closed' }

engine.ts
  guidedManual: ['verifying', 'reporting']   // 缺省下一步 = verifying
```

host 删除整个 `DEFAULT_NEXT_STAGE` 常量。

`tryAdvance` 改为返回 `{ ok, stage, error?, allowedNext? }` 或让 `advancePlaybook` 直接 catch。推荐：新增 `advanceOrError` 把 error 对象抬出来，`tryAdvance` 若仍被 `advancePlaybookForPrompt` 使用，**首条消息推进失败继续只 log**（不要把 allowedNext 抛给用户）。

## 5. 任务拆分

### T1. 扩展 OrchestratorLike 并接线 createOrchestrator 返回值

- 文件：`src/host/hostTypes.ts`、确认 `src/core/index.ts` / host 拿到的 orchestrator 就是 `createOrchestrator()` 的对象（已含 closeRun）。
- 目标：接口增加三个可选方法，签名与 `src/orchestrator/index.ts` 一致（stage 用 `string` 以保持 hostTypes 不依赖 StageId，或 import StageId from core）。
- 测试：TypeScript 编译过即可；行为测在 T3。
- Done when：`OrchestratorLike` 含 `closeRun` / `advanceStage` / `legalNextStages`

### T2. 调整 guidedManual 迁移表顺序

- 文件：`src/orchestrator/engine.ts:20`
- 当前：`guidedManual: ['reporting', 'verifying']`
- 目标：`guidedManual: ['verifying', 'reporting']`
- 测试：`test/orchestrator.test.ts` 断言 `legalNextStages` 在 guidedManual 的 `[0]==='verifying'`；既有「可以迁 reporting」仍合法。
- 文档：`docs/04-ops-orchestration.md` mermaid：`GuidedManual --> Verifying` 为主箭头，`GuidedManual --> Reporting` 保留为跳过。
- Done when：缺省 advance 从 guidedManual 到 verifying；显式 reporting 仍可。

### T3. closePlaybook 改 closeRun

- 文件：`src/host/services/playbookService.ts`
- 删除 `:241-250` 的两步 tryAdvance。改为：

```ts
try {
  const updated = this.orchestrator.closeRun?.(run) ?? this.orchestrator.advanceTo?.(run, 'closed');
  stage = updated?.stage ?? this.currentStage(run, sid);
} catch (err) {
  return { ok: false, stage: this.currentStage(run, sid), error: describeError(err) };
}
if (stage !== 'closed') {
  return { ok: false, stage, error: `无法从 ${stage} 收尾到 closed` };
}
```

`closeRun` 必须存在；不要长期保留 advanceTo('closed') 回退（非法）。若类型上 closeRun 可选，测试里用真 orchestrator。

保留 `ensureVisibleInspectionReport` 在 try 之前。

成功后保留 Plan 01 的 `selection.clear()`。

- 测试：`test/playbook-tools.test.ts` 或新建 `test/playbook-close.test.ts`：
  1. `pb.inspection` start → `advancePlaybookForPrompt` → stage investigating → `closePlaybook` → ok、stage closed。
  2. 监听 stage 事件顺序包含 synthesizing、reporting、closed（若事件从 orchestrator emit 到 host 有桥，断言桥被调用；至少 orchestrator.getRun.stage==='closed'）。
  3. 无 run → 仍 `{ ok:false, error 包含 没有进行中 }`。
- Done when：巡检 investigating 一次 close 成功。

### T4. advancePlaybook 改 advanceStage + allowedNext

- 文件：`playbookService.ts` `advancePlaybook`；`src/runtime/playbook-tools.ts` 把 `allowedNext` 放进返回 JSON。
- 删除 `DEFAULT_NEXT_STAGE`。
- `advancePlaybook(undefined)` → `orchestrator.advanceStage(run)`。
- catch：若 `err` 是 `IllegalStageTransitionError`（用 `err.name` 或 `err.code==='OPS_ILLEGAL_TRANSITION'`，**不要**让 host import engine 破坏分层——在 orchestrator/index 导出 `isIllegalStageTransitionError`）。

```ts
return {
  ok: false,
  stage: current,
  error: err.message,
  allowedNext: err.allowedNext ?? orchestrator.legalNextStages?.(run)
};
```

playbook-tools execute 把 `allowedNext` 序列化进工具结果。

- 测试：从 investigating `ops_advance_stage` 不带参数 → synthesizing（表第一项）。从 investigating 显式 `closed` → ok=false 且 `allowedNext` 含 `synthesizing`。
- 文档：playbook-tools 描述已承诺「列出合法下一步」——实现与描述对齐。
- Done when：`rg DEFAULT_NEXT_STAGE src/` 为空；非法 advance 的 JSON 含 allowedNext 数组。

### T5. advancePlaybookForPrompt 保持只 log

- 文件：同 playbookService `tryAdvance` 用于首条消息。
- 目标：继续吞异常只 log，**不要**把首条用户消息变成工具错误。可继续用 `advanceTo` 显式 selecting/investigating（这两步是合法的，不必改 closeRun）。
- 测试：既有 playbook-eval 首轮 select 不红。
- Done when：巡检首条消息仍自动到 investigating。

## 6. 执行命令

```bash
npx vitest run test/orchestrator.test.ts test/playbook-tools.test.ts test/playbook-eval.test.ts test/playbooks.test.ts
npm run typecheck
```

建议新增文件也纳入：`test/playbook-close.test.ts`。

## 7. 验收清单

- [ ] `pb.inspection`：start + 首条 prompt 驱动后 close → closed
- [ ] 阶段路径经过 synthesizing 与 reporting（事件或 getRun 历史）
- [ ] 非法 advance 含 `allowedNext`
- [ ] guidedManual 缺省下一步 verifying
- [ ] close 成功触发 selection.clear（与 Plan 01 联调）
- [ ] `ensureVisibleInspectionReport` 仍在 close 前运行（`test/inspection-summary.test.ts` 不红）

## 8. 明确不做

- 不在 host 再复制一份迁移表
- 不让模型直接写 stage 字段
- 不自动 spawn parallelGroup
- 不把 close 做成跳过中间阶段的「瞬移」（必须走 closeRun BFS，事件逐步发）

## 9. 风险与回滚

- BFS 最短路对 incident 可能走 synthesizing→reporting 而跳过 awaitingApproval——这是「收尾」语义，正确。需要变更时应 `ops_advance_stage` 到 awaitingApproval，而不是 close。
- 若某 yaml 漏声明 synthesizing，closeRun 会 throw；测试 8 条 yaml 都含到达 closed 的路径（Plan 04 P1-14 会扩 eval）。本 plan 至少锁 inspection + incident。
- 回滚：恢复两步 tryAdvance（不推荐，那是 bug）。
