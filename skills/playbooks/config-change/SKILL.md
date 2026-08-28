---
name: config-change
description: Nacos 配置查询、对比、发布/回滚指引。MCP 只读；发布走 GuidedManual。
---

# 配置变更

`nacos_list_instances` 是插件连接，不是服务主机。服务实例用 `nacos_list_service_instances`。正文默认脱敏。发布/回滚：`guidedManual.command = atNacos.publishConfig`（用户在 IDE 点击，Agent 不得调用写 MCP）。

阶段细则见 `references/`；Nacos 纪律见
`../../vendor/super-ops@0.1.0/references/nacos.md`。
