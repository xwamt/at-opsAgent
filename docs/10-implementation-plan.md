# 10 · 施工计划

设计已冻结。实现按阶段交付，每阶段有可演示的 vsix。

## 阶段 0 — 骨架（可安装但不会「干活」）

- 扩展清单、esbuild、空 WebviewView、TreeView 壳
- `detectHostApp` + 只读扫描 registry，Capabilities 显示已装插件（即使还不能聊）
- Output Channel 诊断命令
- **验收**：装 At-grafana 后打开 Agent，树里出现 `at.grafana`

## 阶段 1 — 能对话 + 调工具

- pi SDK `createAgentSession` + SecretStorage 模型配置（最少 OpenAI 兼容一条）
- HubHost.invoke + 发现工具 + `setActiveTools`
- 流式 transcript、ToolCallCard、停止按钮
- AT Series MCP 去重
- **验收**：不问 MCP，能 `grafana_list_instances`；Cursor 里不出现双份 AT 工具

## 阶段 2 — 安全闸 + Database 兼容

- `beforeToolCall`：read 放行 / write-exec 简报
- ApprovalBar + approvalToken
- USER_CANCELLED、allowBackgroundAccess 原文透传
- at.database 200+ok:false 规范化
- **验收**：Terminal `run_remote_command` 先出 9 要素；拒绝后不 invoke

## 阶段 3 — Playbook + 子代理

- Orchestrator 状态机、YAML 加载
- 八条 playbook 最小可用（incident / metric / release GuidedManual / config GuidedManual / db / host / inspection / security）
- `ops_dispatch_subagent`、SubagentBoard、EvidenceBoard
- vendor SuperOps 镜像 + L0–L5
- **验收**：文档 05 §7.1 故事走通（可用 fixture Bridge）

## 阶段 4 — 运维 UI 打磨

- 看板 Panel、时间线、火花图、LogViewer URI
- PlaybookHeader 阶段 chips、结论三态
- Models 全页（OAuth / compat 字段）
- 第三方 MCP（可与 4 并行，非阻塞主路径）
- **验收**：05 §7.2；深色主题；CSP 无警告

## 阶段 5 — 性能、i18n、发布

- activate 动态 import、合批、虚拟列表
- 中英 nls
- 锁定 pi 版本回归集
- marketplace 元数据、图标

## 明确推迟

| 项 | 原因 |
|----|------|
| 插件 MCP 写面（Jenkins 触发、Nacos 发布） | 违背插件安全模型；用 GuidedManual |
| extension exports 注册 | ADR-004 |
| Copilot Chat Participant 主 UI | ADR-003 |
| 独立 core 进程 | 预留协议即可 |
| 项目级 pi extensions | 默认关 |
| 自动回滚 | 必须新简报 |

## 给 Hub 仓的并行 PR（建议）

在阶段 1 中后期：导出 annotations、`audit` option、`listAllTools`/`getProviders`/`getSelectionState`。不阻塞阶段 0–1。

## 给 At-Database 的问题单（建议）

invoke 错误体契约、write 确认弹窗、补 Skill。Agent 侧先兼容。

## 人力切分（模块，非日历）

| 模块 | 主要内容 |
|------|----------|
| hub-host | runtime 适配、watch、去重、Database 兼容 |
| runtime | pi session、模型、compaction、钩子 |
| orchestrator | playbook、子代理、证据板、令牌 |
| extension | TreeView、命令、SecretStorage |
| webview | 组件库、协议 hydrate |
| skills | YAML、提示词、vendor 同步 |
| qa | fixture Bridge、契约测 |
