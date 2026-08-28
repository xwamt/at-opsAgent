# Nacos 附录

工具前缀 `nacos_*`，**全部只读**。发布 / 删除 / 回滚配置、实例上下线走
GuidedManual：用户在 AT Nacos 编辑器/树视图完成
（深链 `command:atNacos.publishConfig`），Agent 不碰写接口。

- **易错**：`nacos_list_instances` 列的是插件连接，不是服务主机；服务注册
  主机在 `nacos_list_service_instances`。
- 命名空间：1.x/2.x 默认 ns 是空串 `""`，3.x 是 `public`，不能混标。
- `nacos_list_configs` 不含正文；正文用 `nacos_get_config`，默认脱敏
  （带 `isRedacted`），`raw:true` 仅在用户明确要求时使用。
- 不 dump 整个命名空间；用 group / dataId / search 收窄。
- 影响面：`nacos_list_config_listeners`（谁在听）+
  `nacos_list_service_subscribers`（谁在消费）。
- 回滚点：`nacos_list_config_history` 取 `nid`，正文经
  `nacos_get_config_history`（同样默认脱敏）。
- 发布后只读验证：`nacos_get_config` 复读新值 + listeners md5 收敛。
