# at-opsAgent

AT 系列运维专属 VS Code / Cursor Agent 扩展。**这是运维 Agent，不是通用 Coding Agent**：面向 SRE / 值班场景的故障排查、指标诊断、发布回滚、配置变更、主机应急、巡检与安全初判，内置运维链路（Playbook）、并行调查子代理、分级审批、证据时间线与专属 UI。

## 它是什么

- 内嵌 `@at-series/mcp-hub` 运行时：AT 系列能力插件（Terminal / JumpServer / Grafana / Jenkins / Nacos / Database …）**装上即向本 Agent 热注册工具**，无需配置任何 MCP 服务。
- 基于 `@earendil-works/pi-*` SDK in-process 运行 Agent loop；渐进工具发现（discover → select → call）避免工具定义撑爆上下文。
- 调查与执行永不同体：调查子代理只读；任何写 / 执行类变更必须先出 9 要素审批简报，会话内批准后仍要过插件宿主的二次确认。

## 快速开始

### 1. 安装

从本仓库打包 vsix 安装（见下文「打包」），或在开发模式下 F5 运行。装好后侧边栏出现「AT Ops Agent」。

### 2. 接入能力插件（零配置）

安装任意 AT 系列能力插件即可——插件把 Bridge 描述写入 `~/.at-series/bridges/<hostApp>/`，本 Agent 自动发现并注册其工具，**不需要**再写 MCP server 配置。装上 At-grafana 后打开 Capabilities 树即可看到 `at.grafana`。

### 3. 配置模型

运行命令 **「AT Ops Agent: Open Models」** 打开模型配置页（OpenAI 兼容 provider）。配置持久化在 `~/.at-series/agent/models.json`；**API key 只存 VS Code SecretStorage**，文件中永远是 `${secret:atOpsAgent.llmApiKey}` 占位符，不落明文。

### 4. 开始会话

「AT Ops Agent: New Session」发起对话，或「AT Ops Agent: Start Playbook」直接进入运维链路。设置项统一在 `atOpsAgent.*`（渐进发现、审批门槛、子代理并行上限、流式合批等）。

## 内置运维链路（Playbook）

| Playbook | 说明 |
|----------|------|
| `pb.incident` 故障排查 | 可用性 / 错误率 / 延迟事故的证据优先排查 |
| `pb.metric-anomaly` 指标异常诊断 | 告警、CPU / QPS / 延迟异常定位 |
| `pb.release` 发布与回滚 | Jenkins / pipeline，写操作走 GuidedManual 引导人工执行 |
| `pb.config-change` 配置变更 | Nacos 等配置中心，写操作走 GuidedManual |
| `pb.db` 数据库慢查询与容量 | 慢查询、锁等待、连接数、容量 |
| `pb.host-emergency` 主机应急 | OOM、磁盘打满、load 高、服务挂 |
| `pb.inspection` 日常巡检 | 周期健康检查与日报 |
| `pb.security-triage` 安全事件初判 | 异常登录、可疑进程、凭据泄漏初判 |

Jenkins 触发、Nacos 发布这类插件 UI 写操作**不会**被做成 MCP 工具自动执行——按设计走 GuidedManual：Agent 生成步骤与校验点，由人操作插件 UI 完成。

## 开发

```bash
npm install
npm run compile      # esbuild 打包 extension + webview
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

在 VS Code 中打开本仓库后按 F5（Run Extension）启动开发宿主。

### 打包

```bash
npm run package      # compile 后经 npx @vscode/vsce 生成本地 .vsix
```

产物为仓库根目录下的 `at-ops-agent-<version>.vsix`（已被 gitignore），仅本地打包，不发布 marketplace。

## 硬约束（一句话版）

1. **插件零改动**：注册唯一真源是 Bridge v1（`~/.at-series/bridges/`），绝不用扩展 `exports` 注册。
2. **凭据永不离开插件宿主**：SecretStorage + 插件内确认弹窗是最后一道闸；本扩展不读插件凭据。
3. **诊断不授权修复**：调查子代理只读；变更必须会话内审批 + 插件二次确认。
4. **基于 pi SDK，不 fork Studio**：`@earendil-works/pi-*` 三包 in-process 且同号精确锁定（禁 `^`）。
5. **渐进暴露工具**：Hub v2 discover → select → call。
6. **不补插件写面**：Jenkins / Nacos 的 UI 写操作永远走 GuidedManual，不做成 MCP 工具。

## 状态

本仓库是[已冻结设计](docs/README.md)的实现。施工计划见 [docs/10-implementation-plan.md](docs/10-implementation-plan.md)：

- **阶段 0–3 已落地**：扩展骨架与 TreeView / Webview、pi 会话 + Hub 工具调用 + 模型配置、审批安全闸与 Database 兼容、Playbook 状态机 + 子代理编排 + SuperOps 技能包。
- **阶段 4–5 进行中**（由并行分支补齐）：运维看板 UI 打磨、Models 全页、第三方 MCP、性能合批、中英 i18n 与发布收尾。

## 设计文档

导航见 [docs/README.md](docs/README.md)：

| 文档 | 内容 |
|------|------|
| [docs/00-overview.md](docs/00-overview.md) | 产品愿景、设计原则、关键决策 |
| [docs/01-architecture.md](docs/01-architecture.md) | 系统架构与进程模型 |
| [docs/02-capability-hub.md](docs/02-capability-hub.md) | **核心设计 1**：嵌入 Hub + 能力插件热注册 |
| [docs/04-ops-orchestration.md](docs/04-ops-orchestration.md) | **核心设计 2**：运维链路 / 子代理 / CoT / 提示词 |
| [docs/05-ui-system.md](docs/05-ui-system.md) | 运维专属前端 |

调研原文（六份子代理交叉验证）在 [docs/research/](docs/research/README.md)。

## 许可

MIT。依赖链（pi SDK、`@at-series/mcp-hub`、pi-agent-studio 可移植模块）均为 MIT，见 [NOTICE](NOTICE)。
