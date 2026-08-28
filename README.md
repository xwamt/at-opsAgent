# at-opsAgent

AT 系列运维专属 VS Code / Cursor Agent 插件。

AT Series 能力插件（Terminal / JumpServer / Grafana / Jenkins / Nacos / Database …）装上即向本 Agent **热注册工具**，无需再配 MCP 服务。Agent 内嵌 `@at-series/mcp-hub` 运行时，把「能力插件」当作一等公民。

## 这不是通用 Coding Agent

本仓库面向 **SRE / 运维值班**：故障排查、指标诊断、发布回滚、配置变更、主机应急、巡检与安全初判。内置运维链路（Playbook）、子代理编排、分级审批、证据时间线与专属 UI。

## 现状

当前阶段是 **设计冻结**：架构、接口、协议、技能与施工计划已齐备，尚未进入实现。请从这里开始：

| 文档 | 内容 |
|------|------|
| [docs/README.md](docs/README.md) | 设计文档导航 |
| [docs/00-overview.md](docs/00-overview.md) | 产品愿景、设计原则、关键决策 |
| [docs/01-architecture.md](docs/01-architecture.md) | 系统架构与进程模型 |
| [docs/02-capability-hub.md](docs/02-capability-hub.md) | **核心设计 1**：嵌入 Hub + 能力插件热注册 |
| [docs/04-ops-orchestration.md](docs/04-ops-orchestration.md) | **核心设计 2**：运维链路 / 子代理 / CoT / 提示词 |
| [docs/05-ui-system.md](docs/05-ui-system.md) | 运维专属前端 |

调研原文（六份子代理交叉验证）在 [docs/research/](docs/research/README.md)。

## 设计原则（一句话）

1. **插件零改动**：继续 Bridge v1 注册；Agent 换掉 stdio 壳、保留 Hub 引擎。
2. **凭据永不离开插件宿主**：SecretStorage + 插件内确认弹窗仍是最后一道闸。
3. **诊断不授权修复**：调查子代理只读；变更必须会话内审批 + 插件二次确认。
4. **基于 pi SDK，不 fork Studio**：`@earendil-works/pi-*` in-process；运维 UI 自研。
5. **渐进暴露工具**：Hub v2 discover → select → call，避免工具定义撑爆上下文。

## 许可

设计文档与后续实现代码以 MIT 发布。依赖链（pi SDK、`@at-series/mcp-hub`、pi-agent-studio 可移植模块）均为 MIT，见 [NOTICE](NOTICE)。
