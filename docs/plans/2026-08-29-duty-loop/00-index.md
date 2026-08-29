# 值班闭环落地计划 · 总索引

> Status: Ready to execute
> 基线代码：`origin/main` `b099484`（本分支在其之上只加了审查文档）
> 需求真源：[docs/15-optimization-recommendations.md](../../15-optimization-recommendations.md)
> 分项审查：[docs/reviews/round2/](../../reviews/round2/)
> 执行约定：[AGENTS.md](../../../AGENTS.md)；冲突时 ADR > 本目录 > docs/15

本文档集把 docs/15 拆成**可对照直接写代码**的任务单。执行者不要再重新做竞品调研；遇到设计选择以各 plan「目标设计 / 明确不做」为准。

## 怎么用

1. 按下面「波浪」领取**一整份** plan 文件，不要拆开 T# 跨人改同一文件（除非 plan 写明可并行的 T#）。
2. 每个 T# 有 Done when。全部勾完再跑该 plan 的「执行命令」。
3. 一个 plan 的验收清单全绿才能开始依赖它的后续 plan。
4. 改契约（protocol / playbook yaml / Hub 选项）必须同步文档，见各 T#「文档同步」。
5. 每个 plan 合入前：`npm run typecheck && npx vitest run`（全量）必须绿。bundle 相关再跑 `npx vitest run test/bundle-smoke.test.ts`。

## 硬约束（全局，每份 plan 都适用）

- 不要 `exports` 注册、不要 `syncHubBundle` / `ensureAtSeriesMcpConfig`、不要读插件凭据。
- 不要默认打开 pi `bash`/`write`/`edit`。
- 调查中禁止 `ops_clear_tool_selection`（policy 已闸；不要为修 TTL 把 selection 改成 ACL）。
- 不要给 Jenkins/Nacos/Grafana 造写 MCP。
- `runtime` / `orchestrator` / `hub-host` / `policy` 禁止 `import * as vscode`。
- pi 三包精确锁定，禁用 `^`。安全依赖（command-policy）同样精确锁定。

## 波浪与依赖

```text
Wave 0  可完全并行（无互相文件冲突，建议同一 PR 迭代一起合）
  01-hub-selection          P0-A  TTL=0 + selectedNames 对账
  05-approval-hang          P0-C  审批 TTL + 软停解挂
  07-redact-and-retention   P0-D  刮密模块 + 落盘/导出/保留
  09-copy-and-export-ui     P0-E  复制按钮 + 导出入口（先修 cancel 落 tmp）

Wave 1  依赖 Wave 0 的接口，仍可并行
  03-playbook-close         P0-B  状态机单真源；成功 close 后调 hub.selection.clear()
  02-mcp-proxy-and-capabilities  P0-F + P1-8
  06-prompt-errors-and-runtime   P0-G + P1-3/17/18（sanitizeErrorText 放进 07 的 sanitize.ts）

Wave 2
  04-subagent-dispatch      P1-1/2/12/13/14（close 真通之后才好写 eval）
  10-richtext-and-ui-docs   P1-5/6/7/15
  11-ops-docs-and-ux        P1-4/10/11/16（写盘刮密调用 07.redactSecrets）
  08-compaction-and-memory  P1-9

Wave 3  全部 P0/P1 绿之后
  12-p2-trust-infra
```

**同一迭代必须一起做的两对：**

| 对 | 原因 |
|----|------|
| 01 + 03 | 01 的「任务结束 clear」挂在 03 的成功 close 上；03 不修则巡检 close 失败，clear 永远走不到 |
| 07 + 06 | 共用 `src/runtime/sanitize.ts`；06 先看 07 是否已建文件，有则追加 `sanitizeErrorText`，无则按 07 的 API 建 |

文件冲突提示：`src/runtime/index.ts` 被 04/06/07/08 都可能改——**06 的拆文件（P1-17）必须放在 06 的 P0-G 测试钉死后、且 04/07/08 合入之后**，单独一个 commit。

## 计划文件

| 文件 | docs/15 | 模块 |
|------|---------|------|
| [01-hub-selection.md](01-hub-selection.md) | P0-A | hub-host + playbook/chat 挂钩 |
| [02-mcp-proxy-and-capabilities.md](02-mcp-proxy-and-capabilities.md) | P0-F, P1-8 | mcp-client + approval + settings |
| [03-playbook-close.md](03-playbook-close.md) | P0-B | orchestrator + playbookService |
| [04-subagent-dispatch.md](04-subagent-dispatch.md) | P1-1/2/12/13/14 | subagents + prompts + evals |
| [05-approval-hang.md](05-approval-hang.md) | P0-C | approvalService + chatService.abort |
| [06-prompt-errors-and-runtime.md](06-prompt-errors-and-runtime.md) | P0-G, P1-3/17/18 | runtime + policy + esbuild |
| [07-redact-and-retention.md](07-redact-and-retention.md) | P0-D | sanitize.ts + persist + export |
| [08-compaction-and-memory.md](08-compaction-and-memory.md) | P1-9 | compaction 指令 + L-mem digest + 交接新会话 |
| [09-copy-and-export-ui.md](09-copy-and-export-ui.md) | P0-E | 复制三处 + 导出三入口 + 取消零 IO |
| [10-richtext-and-ui-docs.md](10-richtext-and-ui-docs.md) | P1-5/6/7/15 | 流式 MD / LogViewer / 审批 ts / docs/05 |
| [11-ops-docs-and-ux.md](11-ops-docs-and-ux.md) | P1-4/10/11/16 | ops_write_ops_doc + GuidedManual + 历史 + nls |
| [12-p2-trust-infra.md](12-p2-trust-infra.md) | P2 | 记忆层 / waitMs / 审计链 / 策略下限 / OTLP / IM |

## P0/P1 覆盖对照（禁止漏项）

| ID | plan | 一句话 |
|----|------|--------|
| P0-A | 01 | Hub TTL=0 + selectedNames 对账 + close/evict clear |
| P0-B | 03 | closeRun；删 DEFAULT_NEXT_STAGE |
| P0-C | 05 | 审批 TTL + 软停 rejectWaitersFor |
| P0-D | 07 | redactSecrets 落盘/导出 + 30 天 prune |
| P0-E | 09 | 复制×3 + 导出×3 + 取消不写 tmp |
| P0-F | 02 | RISK_BY_PROXY_TOOL 进 gate |
| P0-G | 06 | 错误脱敏 + 401≠未配置 + 429 一次退避 |
| P1-1/2/12/13/14 | 04 | inputs、L0 拆分、roleModels、retry、eval |
| P1-3/17/18 | 06 | command-policy、runtime 拆文件、minify smoke |
| P1-4/10/11/16 | 11 | 写文档、GuidedManual、历史 CRUD、walkthrough |
| P1-5/6/7/15 | 10 | 流式 MD、ANSI 日志、审批留痕、docs/05 |
| P1-8 | 02 | Capabilities live + discovery 热生效 |
| P1-9 | 08 | compact 指令 + 证据回灌 + 交接包 |

## Wave 0+1 完成后的产品验收（docs/15 §6）

全新能问答的 profile 上：

1. 开 `pb.inspection`，等 >2 分钟（含一次审批挂起）→ `hub.selection.state().selected` 仍非空。
2. 在 investigating 调 `ops_close_playbook` 一次成功 → synthesizing→reporting→closed，随后 selected 为空，中文结论可见。
3. 触发 exec 审批不去点 → `atOpsAgent.approval.timeoutMs`（默认 15min，测试可注入 50ms）后席位 idle。
4. 软停在待审批时能结束（waiter rejected）。
5. 工具结果含 `Authorization: Bearer secret` → `tool-results/*.json`、导出 md、`ui-sessions.json` 预览均为 `[REDACTED]`。
6. 标题栏导出、历史条目导出、代码块/命令复制可用；Save 对话框取消不写 tmp。
7. `mcp_list_servers` 不弹 9 要素；`mcp_call_tool` 仍弹。

## 明确整轮不做

见 docs/15 §5。执行者若发现「加 OS 沙箱 / 云执行 / IM 批准 / Jenkins 写 MCP」能省事——那是偏航，停下来改 plan 而不是改红线。

## 实现代理怎么领任务

1. 一次只领 **一份** plan 文件（01–12），按该文件 §5 的 T# 顺序做。不要凭 docs/15 或 round2 审查再发明需求。
2. 实现前用 Read/Grep **复核** 文内行号（代码会动）；API 名以当时源码为准，行为以本 plan「目标设计」为准。
3. 合入前：`npm run typecheck && npx vitest run`；改 esbuild 再跑 `npx vitest run test/bundle-smoke.test.ts`。
4. 契约变更同步 `docs/schemas` 与对应 docs/0x。
5. Wave 3（12）拆多个 PR，不要一笔合完。
