# Plan 06 · Prompt 错误、command-policy、runtime 拆分、bundle minify

> Status: Ready to execute
> Source: docs/15 P0-G、P1-3/17/18；reviews/round2/05-runtime.md
> Depends on: Plan 07 T1（`src/runtime/sanitize.ts` 已有）。**拆文件 T4 必须在 04/07/08 合入之后单独 commit。**
> Parallel-safe with: 02、03（T1–T3）；T4 独占 `src/runtime/index.ts`
> Module: runtime、policy、esbuild、approvalGate

## 0. 目标 + 判据

prompt 期错误脱敏、401 不当成「未配置」、429/5xx 严格重试一次。远程命令风险以 `@at-series/command-policy` 为准。bundle-smoke 用 minify:true。runtime/index.ts 纯搬移拆分。

## 2. 硬约束

runtime 零 vscode。command-policy **精确版本**（如 `0.1.1`，禁用 `^`）。不要 OS 沙箱。拆分零行为变化。不要 fork pi。

## 3. 现状

`chatService.ts:183-186` prompt catch：`emitAssistantNotice(\`⚠ 模型调用失败：${describeError(err)}\`)` 无脱敏、无重试、无 action。

`looksLikeMissingModelConfig`（`runtime/index.ts:585+`）含 `unauthorized` 与 `\\b401\\b`。

`inferEffectiveRisk` 在 `src/policy/index.ts` 手写只读表。`package.json` 无 `@at-series/command-policy`。

`CompactableSessionLike.compact?: (customInstructions?: string)` 已存在。

bundle-smoke 用 sharedBundleOptions，harness minify 与产物可能不一致——读 `test/bundle-smoke.test.ts` 里 esbuild 调用，把 `minify:true` 对齐 `esbuild.extension.mjs` 主产物。

## 4. 设计

### 错误路径（host chatService.handlePrompt catch 不够：应在 runtime.prompt 内部）

在 runtime `prompt()` 的 catch（不是 host）：

1. 若 `isPromptTooLongError` → 已有 recoverFromPromptError，不动
2. `sanitizeErrorText(message)`（从 `./sanitize.ts`，Plan 07 已提供；若只有 redactSecrets，本 plan 实现 sanitizeErrorText：至少 Bearer/sk-/PEM）
3. 分类：
   - 401/403/unauthorized（且不像「缺配置」）→ notice + OPEN_SETTINGS_NOTICE_ACTION，文案「凭证失效或无权限，请打开设置检查 API key」
   - 429/5xx/ECONNRESET/ETIMEDOUT/fetch failed → **sleep 一次**（500ms，测试可注入）再 retry **同一 prompt 一次**；仍失败 notice + Retry action（webview 已有 retryable）
   - 缺配置 → 保持 FALLBACK_NOTICE
4. 从 `looksLikeMissingModelConfig` 删除 `unauthorized` 与 `401`，避免吊销 key 说成没配

429 重试必须与 compact 重试一样「严格一次」，用闭包 flag。

### command-policy

```
npm install @at-series/command-policy@0.1.1 --save-exact
```

`inferEffectiveRisk(toolName, args)`：

- 仅当工具名是远程执行类（`run_remote_command`、以及 args 里有 `command` 字符串的 jumpserver 同类——**列白名单，不要对 grafana_query 跑 shell 分析器**）
- `createShellPolicyEvaluator().evaluate({ sourceText: command, cwd: args.cwd })`
- allow → 有效风险 read；review/deny → 保持申报风险（write/exec）
- import 失败 → 现有手写表兜底，log 一次

`approvalGate.buildApprovalElements` 增加要素「命令策略：allow|review|deny」+ reason 截断。docs/07 §5 对账。

测试：`ls` 类只读 → read；`rm -rf` → 仍 exec 且 needSessionApproval。

### 拆分（T4 最后）

| 新文件 | 搬出 |
|--------|------|
| `src/runtime/session-factory.ts` | createPiRuntime 主体 |
| `src/runtime/tool-gate.ts` | applyToolGate、executeBusinessTool、persist、truncate |
| `src/runtime/fallback.ts` | FallbackRuntime、FALLBACK_* |
| `src/runtime/session-events.ts` | subscribeSessionEvents、toUsageView |
| `src/runtime/index.ts` | 装配 + re-export |

每文件 <400 行。`npm run typecheck` + 全量 vitest 与拆前对比零失败。

## 5. 任务

### T1. sanitizeErrorText + 分类 + 去掉 401=未配置

- 文件：`sanitize.ts`、`runtime/index.ts` looksLikeMissingModelConfig、prompt catch、`modelsProbe` 已 re-export
- 测试：`test/runtime.test.ts` — 401 文案不含「未配置模型」；Bearer 不上屏
- Done when：分类表有单测

### T2. 429 一次退避

- 文件：runtime prompt()
- 注入 `retryDelayMs` 仅测试；生产 500
- 测试：mock prompt 第一次 throw 429、第二次 ok → 只两次调用；两次 429 → notice，不第三次
- Done when：与 compact 一样不无限循环

### T3. command-policy

- package.json exact；policy/index.ts；approvalGate.ts；test/policy.test.ts
- 文档 docs/07
- Done when：手写表仅作 catch 兜底；简报能看到 allow/review/deny

### T4. 拆 runtime/index.ts（独立 commit）

- Done when：行为测试全绿；index.ts 显著变短；无循环 import

### T5. bundle-smoke minify:true

- 文件：`test/bundle-smoke.test.ts` / harness 的 esbuild 调用
- 读主产物 `esbuild.extension.mjs` 是否 minify:true（生产构建是）。harness 对齐。
- 断言仍要：text_delta 来自 SSE、Authorization Bearer 注入 key
- Done when：`npx vitest run test/bundle-smoke.test.ts` 绿

## 6. 命令

```bash
npx vitest run test/runtime.test.ts test/policy.test.ts test/approval-loop.test.ts test/bundle-smoke.test.ts
npm run typecheck
```

T4 后全量 vitest。

## 7–9. 验收 / 不做 / 风险

- 验收：错 key→设置；429 只重试一次；ls 只读推断；smoke minify
- 不做：OS 沙箱、fork pi、29 hooks、把 Hub 确认 UI 搬进 agent
- 风险：command-policy 解析失败必须 fail 到「保持申报风险」而不是 allow。T4 用 `git mv` 风格保持 blame。
