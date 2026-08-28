# Investigating（Locate + Impact）· 配置变更

全程 MCP 只读。

- 定位：`nacos_list_namespaces` → `nacos_list_configs`（无正文）→
  `nacos_get_config`（默认脱敏；`raw:true` 仅用户明说）。
- 影响面：`nacos_list_config_listeners`（谁在听）+
  `nacos_list_service_subscribers`（谁在消费）→ 影响面清单落时间线。
- 回滚点：`nacos_list_config_history` 取 nid。

易错：`nacos_list_instances` 是插件连接；服务主机在
`nacos_list_service_instances`。
禁止：dump 整个命名空间。
DoD：目标配置 + 影响面清单 + 回滚 nid 齐备 → Synthesizing。
