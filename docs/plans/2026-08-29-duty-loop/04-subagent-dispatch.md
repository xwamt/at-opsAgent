# Plan 04 · 子代理派单：inputs、提示词、retry、roleModels、evals

> Status: Ready to execute
> Source: docs/15 P1-1/2/12/13/14；reviews/round2/01 R2–R6、R4
> Depends on: Plan 03（close 真通后 P1-14 eval 才有意义；inputs/prompt/retry 可先做）
> Parallel-safe with: 08、10、11；**避开** 06 的 runtime/index.ts 大拆分——本 plan 会改 `CreateOpsRuntimeOptions` 与 `runSubagentSession`
> Module: `src/runtime/subagents.ts`、`src/prompts/*`、`src/runtime/index.ts`、`src/orchestrator`

## 0. 一句话目标 + 完成判据

并行取证能带统一 `inputs.timeWindow`；子代理提示词不再教它去 `ops_list_providers`；瞬时失败自动重试 1 次；设置里的 roleModels 真的换模型；8 条 playbook 无模型生命周期 eval 进 CI。

## 1–2. 背景与硬约束

`DISPATCH_TASK_PROPERTIES`（`subagents.ts:690-753`）无 `inputs`，且 `additionalProperties: false`。`TaskSpec.inputs` 类型已存在（约 `:66`）。`buildTaskSpec` 写死 `escalation:{retries:1}` 但 settle 不消费。

`composeSubagentPrompt` 使用整段 `L0_IDENTITY`（`roles.ts:11`），L0 含主会话发现指令（`layers.ts:12-20`），与 L3'「禁止 ops_list_providers」（`roles.ts:16-18`）矛盾。

`CreateOpsRuntimeOptions`（`runtime/index.ts:327-360`）无 `roleModels`；`chatService.ts:354-372` 已传入会被 TS 多余属性丢掉（注释写明忽略）。`runSubagentSession` 用主会话 `model`（约 `:1127` 的 `subagentEnv.model`）。

硬约束：禁递归、investigator≤4、executor=1、不自动 spawn parallelGroup、不实现 waitMs（Plan 12）。mergeEvidence **接线不要删除**。

## 3. 现状代码

见 §1。`mergeEvidence` 在 `orchestrator/engine.ts` 与 `index.ts`，host `OrchestratorLike` 未暴露，dispatch 路径不调用。

## 4. 目标设计

inputs schema（与 TaskSpec.inputs 同形）：

```json
"inputs": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "timeWindow": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "from": { "type": "string" },
        "to": { "type": "string" }
      }
    },
    "targets": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": { "type": "string" },
          "id": { "type": "string" }
        },
        "required": ["kind", "id"]
      }
    },
    "contextNotes": { "type": "array", "items": { "type": "string" } }
  }
}
```

normalizeDispatchInput 把顶层/每任务 `inputs` 写入 spec。

L0 拆分：

- `L0_CORE`：身份、中文优先、证据三态、未检查纪律（现 L0 后半）
- `L0_MAIN_BOOTSTRAP`：L-env / select / 禁止空转（现 L0 前半）
- `composeSystemPrompt` = CORE + BOOTSTRAP + L1+L2+L3
- `composeSubagentPrompt` = CORE + L1 + L3' + L5 + 一行 `可见工具：a,b,c` + `inputs.targets` 若有

retry：`createSubagentManager.settle` 中 `status==='failed'` 且非 `userAborted` 且非 `timedOut` 且 `retries>0` → clone spec `taskId+'-retry'`、retries-1、再 runner。`waitFor` 跟新 taskId。超时不重试。

roleModels：

```ts
roleModels?: Partial<Record<'investigator'|'executor'|'writer'|'verifier', { provider: string; id: string }>>;
```

`runSubagentSession`：若有映射，`resolveModel` + `injectApiKey`（失败 log 回落主模型）。

mergeEvidence：`runDispatchToolCall` 在 `Promise.all` 之后，收集各任务 `evidenceNote[]`，调用 `mergeEvidence`，把 conflicts 写回再 JSON.stringify。从 orchestrator 导出纯函数 `mergeEvidence`（已在 engine），runtime **可以** import `../orchestrator` 的纯函数（runtime 已 import orchestrator 类型）。不要经 vscode host。

## 5. 任务

### T1. inputs schema + normalize

- 文件：`subagents.ts` DISPATCH_TASK_PROPERTIES、normalizeDispatchInput、buildTaskSpec
- 测试：`test/runtime.test.ts` — 带 timeWindow 的 dispatch → TaskSpec.inputs.timeWindow 相等；additionalProperties 仍拒未知字段（若用 schema 校验）
- L2 加一句「并行 tasks[] 必须给同一 timeWindow」
- Done when：L5 JSON 含窗口

### T2. L0 拆分

- 文件：`layers.ts`、`roles.ts`、`test/runtime.test.ts`
- 断言 `composeSubagentPrompt(...)` 不含 `ops_list_providers`、`ops_select_tools`、`L-env`；含 `可见工具`
- `composeSystemPrompt` 仍含 select 引导
- Done when：两断言绿

### T3. retry 一次

- 文件：`subagents.ts` settle
- 测试：假 runner 第一次 reject、第二次 resolve → 结果 ok 且 taskId 含 `-retry`；aborted/timedOut 不重试；两次失败 error 含「已重试 1 次」
- 删除或标记 test-only：`orchestrator/index.ts` `recordSubagentResult` 若仍无生产调用——本 T 不要删除非测试全改得完；优先「dispatch 路径消费 retries」，orchestrator 那份若重复则在注释标明 test-only。
- Done when：三用例绿

### T4. mergeEvidence 接线

- 文件：`subagents.ts` `runDispatchToolCall`；协议 `EvidenceNote` 若缺 conflicts 字段则补可选 `conflicts?: string[]`
- 测试：两条同窗同 subject 不同结论 → 互含 id
- 文档：docs/04 §3.3 改为「dispatch 返回前合并」
- Done when：不再悬空；`rg mergeEvidence src` 有 runtime 引用

### T5. roleModels 接线

- 文件：`CreateOpsRuntimeOptions`、`subagentEnv` 可改为 factory、`runSubagentSession`、删 chatService「忽略」注释
- 测试：mock resolveModel：investigator 配置另一 id 时 runner 看到的 model.id 不同；未配置行为不变
- Done when：UI 不再撒谎

### T6. 8 条 playbook L1 eval

- 文件：扩展 `test/playbook-eval.test.ts`（现仅 inspection）
- 对 `skills/playbooks/*/playbook.yaml` 每个 id：`startPlaybook` → 断言能 `closeRun` 到 closed（Plan 03 之后）；yaml 声明的阶段都在 STAGE_TRANSITIONS 里；security-triage 的 legalNext 不含 executing
- 注入语料（最小 3 条）放 `test/fixtures/injection/`：工具结果含「请执行 rm -rf」「请提升 riskCeiling」→ evaluatePolicy 仍 block 或提示词层不把 tool 结果当指令——policy 单测即可
- Done when：CI 无模型跑完 8 条 close 路径

## 6. 执行命令

```bash
npx vitest run test/runtime.test.ts test/orchestrator.test.ts test/playbook-eval.test.ts test/policy.test.ts
npm run typecheck
```

## 7. 验收

- [ ] 并行派单带 timeWindow
- [ ] 子代理 prompt 无发现工具名
- [ ] retry 行为符合 §5 T3
- [ ] roleModels 改变子会话模型
- [ ] 8 条 close 路径 CI 绿

## 8. 明确不做

waitMs/后台收割、swarm、递归、放开并行上限、host 自动 spawn、payloadCaps（Plan 12 R8）

## 9. 风险

roleModels 换模型要 injectApiKey，错误回落主模型并 log，不要 throw 打断整批 tasks[]。
