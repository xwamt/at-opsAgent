# at-opsAgent 设计文档

本文档集是施工真源。实现阶段以本目录的接口、ADR 与 schema 为准；调研附录只解释「为什么这样定」。

## 阅读顺序

| 顺序 | 文档 | 读者 |
|------|------|------|
| 0 | [00-overview.md](00-overview.md) | 全员：愿景、范围、硬约束、关键决策 |
| 1 | [01-architecture.md](01-architecture.md) | 架构：分层、进程、仓库布局、依赖 |
| 2 | [02-capability-hub.md](02-capability-hub.md) | **核心设计 1**：嵌入 MCP Hub、能力插件热注册 |
| 3 | [03-agent-runtime.md](03-agent-runtime.md) | 基于 pi SDK 的 Agent loop、模型、会话、MCP 并存 |
| 4 | [04-ops-orchestration.md](04-ops-orchestration.md) | **核心设计 2**：Playbook、子代理、CoT、提示词、Skill |
| 5 | [05-ui-system.md](05-ui-system.md) | 运维 UI 信息架构与组件规范 |
| 6 | [06-interfaces.md](06-interfaces.md) | TypeScript / JSON 接口总表（实现拷贝点） |
| 7 | [07-security.md](07-security.md) | 审批、凭据、注入、审计 |
| 8 | [08-performance.md](08-performance.md) | 激活、流式、工具爆炸、超时、崩溃恢复 |
| 9 | [09-extensibility.md](09-extensibility.md) | 新插件、新 Playbook、新模型、新 MCP |
| 10 | [10-implementation-plan.md](10-implementation-plan.md) | 分阶段施工与验收 |

配套：

- [adr/](adr/000-index.md) — 架构决策记录
- [schemas/](schemas/) — 机器可读契约（playbook / task-spec / host protocol）
- [../skills/](../skills/README.md) — 运行时技能包与 Playbook YAML 初稿
- [research/](research/README.md) — 对 AT 插件、Hub、piagent、业界的原始调研

## 已冻结的决策（速查）

1. **嵌入方式**：进程内 `createHubRuntime()`，工具映射为 pi `customTools`。不走 stdio `hub.js`，不把 Hub 再包一层 MCP InMemoryTransport。
2. **注册协议**：唯一真源仍是 `~/.at-series/bridges/<hostApp>/*.json` + Bridge HTTP。**不用** VS Code `exports` 做插件注册。
3. **运行时**：`@earendil-works/pi-*` SDK in-process，精确锁定同号版本。不 fork pi-agent-studio，不要求用户安装 pi CLI。
4. **主 UI**：自建 WebviewView 侧边栏（Vue 3）。不用 Copilot Chat Participant 做主入口。
5. **编排**：orchestrator-worker + agents-as-tools。调查与执行永不同体。不用 handoff / 自由 swarm。
6. **双入口共存**：Cursor/Kiro/Continue 继续用插件维护的 `hub.js`；本 Agent 是同一 registry 的另一个读者。
