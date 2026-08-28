# at-opsAgent

AT 系列运维专属 VS Code / Cursor Agent 插件。

AT Series 能力插件（Terminal / JumpServer / Grafana / Jenkins / Nacos / Database …）装上即向本 Agent **热注册工具**，无需再配 MCP 服务。Agent 内嵌 `@at-series/mcp-hub` 运行时，把「能力插件」当作一等公民。

## 这不是通用 Coding Agent

本仓库面向 **SRE / 运维值班**：故障排查、指标诊断、发布回滚、配置变更、主机应急、巡检与安全初判。内置运维链路（Playbook）、子代理编排、分级审批、证据时间线与专属 UI。

## 现状

骨架与主链路已落地，进入实现迭代：

- **扩展宿主**（`src/host`）：廉价 activate、TreeView（能力 / 会话 / 审批 / 技能 / 模型）、Chat 与 Ops 看板 webview、命令、Hub 诊断、Models 配置页
- **内嵌 Hub**（`src/hub-host`）：AT 系列能力插件热注册与渐进工具发现
- **对话运行时**（`src/runtime`）：pi SDK in-process 会话、`ops_*` 发现工具、L0–L2 系统提示词
- **编排与策略**（`src/orchestrator` / `src/policy`）：Playbook 阶段状态机、并行调查子代理 TaskSpec、9 要素审批简报、权限闸
- **运维链路**（`skills/playbooks`）：故障排查、指标异常、发布回滚、配置变更、主机应急、DB 慢查询、巡检、安全初判共 8 条

### 如何运行

```bash
npm install
npm run compile      # esbuild 打包 extension + webview
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

在 VS Code 中打开本仓库后按 F5（Run Extension）启动开发宿主。

### 配置

- 设置项统一在 `atOpsAgent.*`：`discovery.mode` / `discovery.threshold`（渐进工具发现）、`approval.sessionRequiredFor`（会话审批门槛）、`subagent.maxParallel`（子代理并行上限）、`streaming.batchMs`（流式合批）等，见扩展设置页
- **模型**：配置在 `~/.at-series/agent/models.json`（OpenAI 兼容 provider）。命令「AT Ops Agent: Open Models」打开配置页；API key 只存 VS Code SecretStorage，文件中永远保留 `${secret:atOpsAgent.llmApiKey}` 占位符，不落明文
- **能力插件**：装上即用——插件把 Bridge 描述写入 `~/.at-series/bridges/<hostApp>/`，Agent 自动注册其工具，无需再配 MCP 服务

### 设计文档

导航见 [docs/README.md](docs/README.md)：

| 文档 | 内容 |
|------|------|
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
