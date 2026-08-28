# 09 · 扩展性

## 1. 新 AT 能力插件（核心路径）

作者只实现 Bridge v1。Agent 仓 **零 PR**。可选：

- 在 SuperOps vendor 镜像增加 provider 附录（系列仓，不在 Agent 仓）
- 新增 Playbook 或在现有 YAML 的 `select.pluginIds` 加上新 id
- 插件贡献 skill 目录（第二期 `atSeries.skills`）

Agent 不维护「支持的 pluginId 白名单」（除 Database 兼容特例与安全强制项）。

## 2. 新 Playbook

1. `skills/playbooks/<id>/playbook.yaml` 通过 schema 校验
2. `SKILL.md` 写触发描述（供路由）
3. 单测：非法阶段迁移被拒绝；select 由 orchestrator 代发
4. 不把 runbook 全文塞进 L0

## 3. 新模型 / 网关

用户 Settings → Models：加 provider（OpenAI 兼容或 Anthropic）。不改代码。若出现 pi-ai 不认识的 thinking 字段，先走 `compat.thinkingFormat`；不够再向 pi-ai 提 PR，不在本仓分叉 provider SDK。

## 4. 新第三方 MCP

`mcp.json` 增加 server。不要把 AT 插件再配进去。工具过多用 proxy search/call。

## 5. 新 UI 组件

在 `host-protocol.ts` 加事件 type，webview 注册渲染器。禁止 webview 直连 localhost Bridge。

## 6. 抽独立 Agent 进程（预留，不在 v1 做）

`packages/runtime` 已无 vscode。把 HostBridge 的 envelope 从 postMessage 换成 stdio/TCP 即可。HubHost 必须跟着走（仍要本机读 registry）——因此 **远程 window 的 Agent 应跑在远程 extension host**（Remote-SSH 默认如此），不要在本地跑 loop 去连远程 bridges。

## 7. 版本

| 对象 | 策略 |
|------|------|
| 本扩展 | semver；0.x 允许破坏 UI 协议但要升 `Envelope.v` |
| pi 三包 | 精确同号锁定 |
| `@at-series/mcp-hub` | `^` 小版本；protocolVersion 由 Hub 文档约束 |
| playbook.yaml | `version` 字段；Orchestrator 拒载未知 version |
| task-spec | `specVersion` |

## 8. 测试金字塔

| 层 | 覆盖 |
|----|------|
| 单测 | Hub 去重、selection 闸、riskCeiling、commandSetSha256、Database ok:false 兼容、playbook 迁移表 |
| 契约测 | 对 fixture registry JSON 跑 parse + 假 Bridge HTTP |
| 组件测 | Vue：ApprovalBar 双确认文案、截断、三态便签 |
| 集成（可选） | 起假 Bridge publish → Capabilities 出现 → invoke |

不在 CI 打真实 Grafana。用 `test/fixtures/bridges/`。
