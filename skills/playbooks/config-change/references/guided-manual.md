# GuidedManual · 发布配置（Nacos）

Nacos MCP 全部只读：发布 / 回滚 / 删除配置、实例上下线只能由
**用户在 AT Nacos 编辑器 / 树视图完成**，Agent 不得调用任何写 MCP，
也不要寻找或建议写工具。操作指引卡内容：

1. 目标四元组（instance / namespace / group / dataId）与 diff 草案；
2. 影响面清单与风险（引用 Investigating 证据）；危险变更（生产关键
   配置）先出 9 要素简报再给按钮；
3. 深链按钮：[在 AT Nacos 中发布配置](command:atNacos.publishConfig)；
4. 回滚指引：如需回滚，同一入口按历史版本 nid 操作。

用户回报完成后（进入 Reporting 前）只读复核：`nacos_get_config` 复读
新值、`nacos_list_config_listeners` 确认 md5 收敛、（若已 add grafana）
关键指标无劣化。
