# Plan 08 · 运维感知压缩：指令、证据回灌、交接新会话

> Status: Ready to execute
> Source: docs/15 P1-9；docs/reviews/round2/04-memory.md §1.3 / P0-M2
> Depends on: 无硬依赖。L-mem 注入走已有 `StageLayerInjector.applyLayers`。
> Parallel-safe with: 04（避开 `runtime/index.ts` 大拆）、10、11。**不要**与 Plan 06 T4 同时改 `runtime/index.ts`。
> Module: `src/runtime/compaction.ts`、`src/host/services/stageLayers.ts`、`src/host/services/chatService.ts`

## 0. 一句话目标 + 完成判据

压缩按值班语义保留证据/阶段/审批，而不是 coding 摘要；compact 之后模型上下文里能再次看到证据板 digest；压缩仍溢出时，host 一键开新会话并自动带上交接包，而不是让人肉复制。

完成判据：

1. `compact()` 被调用时带上运维 `customInstructions`（断言字符串含 `evidence-note` 与 `playbook`）。
2. compact 事件之后下一条 prompt 的 system 层含 L-mem digest（≤20 行），且 digest 含本会话已有 evidence 摘要。
3. 溢出兜底路径：notice 带「携带交接包开新会话」action；新会话首条 system/notice 含同一 digest；用户不必手抄。

## 1. 背景与运维影响

`recoverFromPromptError`（`src/runtime/compaction.ts:74-98`）在溢出时 `compact.call(input.session)` **不传参数**。`CompactableSessionLike.compact` 已声明 `customInstructions?: string`（`:50`），接线闲置。

压缩后证据便签仍在 `sessionStore`（UI），但模型上下文里的便签被摘要掉。docs/03 §5「EvidenceBoard 不被 compact 丢掉」目前只对 UI 成立。

`COMPACTION_NEW_SESSION_MESSAGE`（`:18-20`）要求用户「把关键结论带到新会话」——host 明明持有 `itemsOf` 里的 evidence 与 timeline 审批事件。

## 2. 硬约束

- `src/runtime/compaction.ts` **禁止** `import vscode`。digest 合成若需要 store，放在 **host** `stageLayers.ts` / 新 `src/host/services/memoryDigest.ts`。
- 不要从工具结果自动抽取长期记忆（docs/15 §5.11）。本 plan **没有** `ops_memory` / `ops_recall`——那是 Plan 12。
- 不要改 pi 包内 compact 实现；只传 `customInstructions`。
- 严格「compact 一次 + retry 一次」不变（`:13`）。
- 不要把完整工具 stdout 塞进 digest。

## 3. 现状代码

**压缩入口（未传指令）：**

```84:92:src/runtime/compaction.ts
  const compact = input.session.compact;
  if (typeof compact !== 'function') {
    throw new Error(COMPACTION_NEW_SESSION_MESSAGE);
  }
  let compactionResult: unknown;
  try {
    compactionResult = await compact.call(input.session);
```

**现场注入器：** `src/host/services/stageLayers.ts` 目前叠 L-env + L4，没有第三层工作记忆。`applyLayers` 已按「内容未变则跳过」。

**证据在 store：** `sessionStore.itemsOf(sessionId)` 含 `{ kind:'evidence', note }`。审批决议在 `appendTimeline({ kind:'approval', briefId, decision })`（`approvalService.ts:346-348`），**不在** transcript item 上（item 仍是 `{ kind:'approval', id, briefId }` 无 decision——Plan 10 P1-7 会补 transcript；本 plan digest 先读 timeline）。

**新会话：** `ChatService` / `hostController.ts:177-179` `session/new` → `store.newSession()`，空 transcript。没有「seed digest」参数。

**测试：** 仓库无 `test/compaction.test.ts`。`recoverFromPromptError` 行为在 `test/runtime.test.ts` 若已覆盖则扩展；否则新建 `test/compaction.test.ts`。

## 4. 目标设计

```text
溢出
  → compact({ customInstructions: OPS_COMPACT_INSTRUCTIONS })
  → onCompaction(summary)
       host: 合成 digest ≤20 行
       StageLayerInjector.applyLayers(sessionId, { memLayer: digest })
  → retry 同一 prompt
  → 仍失败
       抛错 + host 拦截 COMPACTION_NEW_SESSION_MESSAGE
       notice actions: [携带交接包开新会话] [仅提示（默认旧文案）]
       点前者: newSession({ seed: digest }) → 首条 system item + L-mem 注入
```

### 4.1 `OPS_COMPACT_INSTRUCTIONS`（runtime 常量）

英文短句（pi compact 接口是英文模型指令），必须包含：

- Keep every evidence-note with confidence (confirmed/hypothesis/pending).
- Keep approved/rejected command-set summaries and pending approvals.
- Keep current playbook id, stage, DoD, unchecked items.
- Keep identified hosts/targets; drop duplicate MCP list/search dumps and long stdout (cite toolCallId instead).
- This is an SRE/on-call session, not a coding session.

### 4.2 digest 合成（host，纯函数可单测）

新文件 `src/host/services/memoryDigest.ts`：

```ts
export const MEM_LAYER_MAX_LINES = 20;

export function buildDutyDigest(input: {
  playbook?: { id: string; stage: string };
  evidence: Array<{ confidence: string; summary: string }>;
  approvals: Array<{ briefId: string; decision?: string }>;
  exposed?: string[];
}): string
```

格式（示例）：

```
# L-mem 交接（compaction 后回灌，勿丢）
playbook: pb.inspection @ investigating
evidence:
- [confirmed] 18:02 发布后错误率上升
approvals:
- brief abc123 approved
exposed: at.grafana, at.terminal
```

截断规则：evidence 最多 8 条（summary 各 ≤80 字），approvals 最多 4 条，总行数 ≤20；超出在末行写 `… truncated N`。

`redactSecrets`：若 Plan 07 已合入，digest 过一遍；否则至少不要放入 `preview` 原文。

### 4.3 L-mem 注入

`StageLayerInjector.applyLayers` 增加可选 `memLayer?: string`。`composeSystemPrompt` / `buildSystemPrompt` 增加 `memLayer?: string`，拼在 L-env 之后、L4 之前（现场 → 工作记忆 → 阶段纪律）。

内容哈希：playbook 键 + L-env 文本 + mem 文本 都不变才跳过（现有短路要带上 mem）。

### 4.4 交接新会话

`store.newSession` 保持无参。host `ChatService.startHandoffSession(fromSessionId)`：

1. `const digest = buildDutyDigest(...)` 用 **from** 会话的 items/timeline/playbook。
2. `store.newSession('交接 ' + oldTitle)`。
3. `store.appendItem({ kind:'system', id, text: digest })` + broadcast。
4. `stageLayers.applyLayers(newId, { memLayer: digest })`。
5. hydrate 新会话。

notice action：`{ id:'handoff-new-session', label:'携带交接包开新会话' }`。`store.runNoticeAction` 已有通道；host 识别 id 调 `startHandoffSession`。**不要**自动在 compact 失败时静默开新会话——必须用户点。

更新 `COMPACTION_NEW_SESSION_MESSAGE`：追加一句「可点击下方按钮，把证据与阶段带到新会话。」旧测试若精确匹配全文则改断言。

## 5. 任务拆分

### T1. 传入 customInstructions

- 文件：`src/runtime/compaction.ts`；导出 `OPS_COMPACT_INSTRUCTIONS`
- 测试：`test/compaction.test.ts` mock `session.compact = vi.fn(async (x) => x)`，`recoverFromPromptError` 后 `expect(compact).toHaveBeenCalledWith(expect.stringMatching(/SRE|on-call|evidence/i))`
- 无 compact 方法 / compact throw / retry throw：仍抛 `COMPACTION_NEW_SESSION_MESSAGE`（行为回归）
- Done when：溢出路径必带指令；非溢出仍原样 rethrow

### T2. `buildDutyDigest` + 单测

- 文件：新 `src/host/services/memoryDigest.ts`、`test/memory-digest.test.ts`
- 用例：空输入仍有 playbook 行或 `(no playbook)`；8+ 条 evidence 截断；不含 preview 长文本
- Done when：行数 ≤20 有断言

### T3. StageLayerInjector 叠 L-mem

- 文件：`stageLayers.ts`、`src/prompts/layers.ts` 的 `composeSystemPrompt`（读准现签名再加字段）
- 测试：对 injector 抽纯函数或 mock runtime `applyLayers`；compact 回调后 `composeSystemPrompt` 结果含 `# L-mem`
- 接线：`chatService` / runtime `onCompaction` 已发 `{ type:'compaction' }`——在同一回调里 `buildDutyDigest` + `applyLayers`
- Done when：compact 后下一次 `syncLayers`/`inject` 带 mem

### T4. 交接新会话 notice

- 文件：`chatService.ts` prompt catch（识别 compaction 文案）、notice actions、`startHandoffSession`
- webview：`store.runNoticeAction` 对未知 id `post('notice/action', { id })`；hostController 加 case
- 测试：`test/handoff-session.test.ts` 或 chatService 单测：from 会话有 1 条 evidence → 新会话 `itemsOf` 含 system digest 且含该 summary
- Done when：用户一点按钮即有新会话 + digest，无需手抄

### T5. 文档

- `docs/03-agent-runtime.md` §5 改为「compact 后 host 回灌 L-mem digest；仍溢出可一键交接」
- Done when：不再写「存在 orchestrator 内存 + custom entry」这种未接线描述

## 6. 执行命令

```bash
npx vitest run test/compaction.test.ts test/memory-digest.test.ts test/runtime.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] compact 调用带运维 customInstructions
- [ ] compact 后 system 含 L-mem digest
- [ ] 溢出 notice 可一键开带交接包的新会话
- [ ] 工具结果不会被写成长期记忆文件
- [ ] runtime 无 vscode import

## 8. 明确不做

- `ops_memory` / `ops_recall` / `memory/environment.json` / `OPS.md`（Plan 12）
- 自动从工具 JSON 抽事实
- 改 pi compact 算法或 fork pi
- session 全文 grep 搜索（P1-11 是历史标题搜索，Plan 11）

## 9. 风险与回滚

- digest 把未脱敏 preview 带进 system：只取 `note.summary` 与 briefId/decision，不取 tool.preview。
- L-mem 与 L-env 重复「exposed」：允许一行重复，胜过模型失忆。
- 回滚：`compact.call(session)` 恢复无参；删除 memLayer 字段。
