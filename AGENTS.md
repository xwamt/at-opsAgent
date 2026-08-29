# Agent 实现约定

施工前必读 [docs/README.md](docs/README.md)。冲突时以 ADR 与 `docs/schemas/*` 为准。

## 不可违反

- 不要让能力插件依赖本扩展的 `exports` 来注册工具。
- 不要 `syncHubBundle` / `ensureAtSeriesMcpConfig`（嵌入路径不需要）。
- 不要把插件凭据读进本扩展。
- 不要默认打开 pi 的 `bash`/`write`/`edit`。
- 不要在调查中允许 `ops_clear_tool_selection`。
- 不要把 Jenkins/Nacos 的 UI 写操作做成 MCP 工具「补全」。
- runtime / orchestrator / hub-host / policy **禁止** `import * as vscode`。
- pi 三包必须同号精确锁定，禁用 `^`。

## 建议实现顺序

会话 UX 骨架见 [docs/10-implementation-plan.md](docs/10-implementation-plan.md)（阶段 0–3 已落地）。

**下一阶段值班闭环**按 [docs/plans/2026-08-29-duty-loop/00-index.md](docs/plans/2026-08-29-duty-loop/00-index.md) 领取整份 plan，不要从 [docs/15](docs/15-optimization-recommendations.md) 或 [docs/11](docs/11-redesign-recommendations.md) 直接开写。
