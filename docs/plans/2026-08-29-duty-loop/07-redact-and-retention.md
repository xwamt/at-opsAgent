# Plan 07 · 落盘刮密与保留期限

> Status: Ready to execute
> Source: docs/15 P0-D；docs/reviews/round2/04-memory.md M1/M3
> Depends on: 无。**本文件创建 `src/runtime/sanitize.ts`**，Plan 06 追加 `sanitizeErrorText`。
> Parallel-safe with: 01、05、09（09 的导出入口会调用本 plan 的 redact；若 09 先合，先用一个临时 no-op 再换——更好是本 plan 先合或同一 PR）
> Module: `src/runtime/sanitize.ts`、`src/runtime/index.ts` persist、`src/host/sessionStore.ts`、`src/host/exportReport.ts`

## 0. 一句话目标 + 完成判据

凡是本扩展**自己写到磁盘或导出文件**的文本，先过 `redactSecrets`。`tool-results/` 超过 30 天的文件在 activate 时尽力删除。

完成判据：含 `Authorization: Bearer secret-token` 的工具全文落盘后文件内无 `secret-token`；导出 md 同样；`redactSecrets` 返回 `hits>=1`。

## 1. 背景

`persistFullToolResult`（`runtime/index.ts:516-530`）`writeFile(file, json, 'utf8')` 原文。`sessionStore` 把 transcript preview 写入 `ui-sessions.json`。`exportReport` 拼接 items。pi 自己的 JSONL 由 SessionManager 写——**本仓可能没有 hook**。

`sanitizeErrorText` 已在 `modelsProbe.ts:76-80`（vscode 文件），只抹 Bearer 与 `sk-`。运行时不能 import 它。

## 2. 硬约束

- `src/runtime/sanitize.ts` **禁止** `import vscode`。
- 刮密不可逆；不要试图「解密回来」。
- 不要把 API key 写进测试期望的明文然后只在一个路径刮——测试输入用固定夹具 `Bearer aabbccdd`。
- 不修改插件 SecretStorage。
- 不声称已改写 pi JSONL，除非找到稳定 hook。

## 3. 现状代码

persist：`:521-527` 无 redact。export：`workbenchService.ts:77-98` 直接 `buildOpsReportMarkdown` 后 write；注释写「绝不包含审批令牌 / API key」但只是不放 token 字段，**preview 原文仍在**。sessionStore persist 见 `src/host/sessionStore.ts` `persistNow`。

pi compact API 已接受 `customInstructions?: string`（`compaction.ts:50`）——记忆压缩属 Plan 08。

## 4. 目标设计

### 4.1 `src/runtime/sanitize.ts` 公共 API

```ts
export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): { text: string; hits: number }

export function sanitizeErrorText(text: string): string
// Plan 06 实现体；本 plan 先提供：return redactSecrets(text).text
// 并保留 modelsProbe 现有的 Bearer/sk- 行为（被 redactSecrets 覆盖）
```

`redactSecrets` 规则（按顺序，计数每次替换次数）：

1. PEM：`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` → REDACTED
2. `Authorization\s*[:=]\s*Bearer\s+\S+` → `Authorization: Bearer [REDACTED]`
3. `Bearer\s+[A-Za-z0-9._\-+=/]{8,}` → `Bearer [REDACTED]`
4. `(?i)(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S+` → `$1=[REDACTED]`
5. `(?i)(mysql|postgres|mongodb|redis):\/\/[^@\s]+@` → 协议://[REDACTED]@
6. `sk-[A-Za-z0-9_-]{8,}` → `sk-[REDACTED]`
7. `(?i)x-at-series-token\s*[:=]\s*\S+` → 抹掉

空字符串 hits=0。不要用 `.*` 跨过整份日志。

### 4.2 调用点

| 点 | 文件 | 怎么接 |
|----|------|--------|
| 工具全文落盘 | `persistFullToolResult` | `writeFile(..., redactSecrets(json).text)` |
| 截断回模型的字符串 | `truncateForModel` 的输入 `full` | 先 redact 再截断，避免模型上下文带密钥 |
| ui-sessions 条目 text/preview | `sessionStore.ts` 序列化前 | 对 item 里 string 字段走 redact（至少 `text`、`call.preview`、`errorMessage`） |
| 导出 | `buildOpsReportMarkdown` 末尾或 write 前 | `redactSecrets(markdown)`；测试断言 hits |

### 4.3 pi JSONL

读 `createAgentSession` / SessionManager 是否有 transform。若无：在 `docs/07-security.md` 写明「pi 会话 JSONL 可能含工具原文；本扩展控制的 tool-results / ui-sessions / 导出已刮密」。不要 fork pi。

### 4.4 保留

新函数 `src/host/retention.ts`（可 import vscode 或纯 fs）：

- 目录：`~/.at-series/agent/tool-results/`
- 删除 `mtimeMs < now - 30d` 的 `*.json`
- 在 `activate.ts` start 末尾 `void pruneToolResults(agentDir).catch(log)`
- 会话 JSONL：若能列出 `sessions/*.jsonl` 且文件不在任何 `ui-sessions.json` 的 `sessionFile` 中、且 mtime>30d，删除。宁可漏删，不要删仍被引用的文件。

## 5. 任务拆分

### T1. 实现 sanitize.ts + 单测

- 新文件：`src/runtime/sanitize.ts`、`test/sanitize.test.ts`
- 用例名：
  - `redacts Bearer tokens and counts hits`
  - `redacts PEM private key blocks`
  - `redacts password= and mysql://user:pass@host`
  - `does not redact ordinary df -h output`（hits=0）
  - `sanitizeErrorText aliases redact for Bearer`
- Done when：7 条规则都有正例；无 vscode import。

### T2. persistFullToolResult + executeBusinessTool

- 文件：`src/runtime/index.ts`
- 对 `full` 先 `redactSecrets` 再判断长度/落盘/回模型。
- 测试：`test/runtime.test.ts` 调 executeBusinessTool 或直接 persist：写入含 Bearer 的 json，读回文件不含明文。
- Done when：tool-results 夹具断言。

### T3. sessionStore

- 文件：`src/host/sessionStore.ts` `persistNow`（或 `serializeItem`）
- 测试：`test/session-store.test.ts` 追加带 preview 的 tool item，persist 后读 json 无明文。
- Done when：ui-sessions 刮密。

### T4. exportReport

- 文件：`src/host/exportReport.ts` `buildOpsReportMarkdown` return 前 redact
- 测试：`test/export-report.test.ts` 已有「不含令牌」——再加一条 preview 含 Bearer → 输出 `[REDACTED]` 且不含 `secret-token`
- `workbenchService` 取消对话框仍写 tmp 是 Plan 09 T1，本 plan 不改对话框。
- Done when：导出测试绿。

### T5. modelsProbe 改 re-export

- 文件：`src/host/modelsProbe.ts` `sanitizeErrorText` 改为从 `../runtime/sanitize` import 再 export，避免两套规则。
- 测试：既有 modelsProbe 测试若有。
- Done when：host 不再维护第二套正则。

### T6. 30 天 prune

- 文件：新 `src/host/retention.ts`；`activate.ts` 调用
- 测试：`test/retention.test.ts` 用 temp dir：一个 mtime 伪造旧文件（`fs.utimes`）+ 一个新文件，prune 后只剩新文件。
- Done when：activate 不 await prune（不挡启动）；失败只 log。

### T7. 文档

- `docs/07-security.md` 增加「落盘刮密范围 / JSONL 限制 / 30 天 tool-results」
- Done when：文档与代码一致。

## 6. 执行命令

```bash
npx vitest run test/sanitize.test.ts test/runtime.test.ts test/session-store.test.ts test/export-report.test.ts test/retention.test.ts
npm run typecheck
```

## 7. 验收清单

- [ ] Bearer 夹具在 tool-results、ui-sessions、导出三处消失
- [ ] 普通巡检输出 hits=0
- [ ] 旧 tool-results 能被 prune
- [ ] runtime 无 vscode import

## 8. 明确不做

- 不做加密存储工具全文（刮密即可）
- 不建向量数据库
- 不自动从工具结果抽长期记忆（Plan 08/12）
- 不改 pi 包内写 JSONL 的代码

## 9. 风险与回滚

- 过度刮密：误伤 `token=` 出现在 nginx 配置讲解。规则 4 要求 `password|token` 作为键。评测用「does not redact ordinary df」。
- 回滚：persist 改回原文（安全倒退，不建议）。
