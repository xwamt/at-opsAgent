# Grafana / Prometheus / Loki 附录

工具前缀 `grafana_*`，**全部只读**、无确认弹窗。写操作（改面板、静默告警等）
不存在于 MCP，需要时引导用户去 Grafana UI 或 IDE 深链。

- `grafana_list_instances` 永远第一步；只列开启「Allow Agent background
  access」的实例，为空 → 引导用户去插件 UI 开启，**不许猜 instanceId**。
- 看板：`grafana_get_dashboard` 优先 `fields:"targets"`（仅 panel expr +
  datasource）；单次调查调用 ≤ 2 次。
- 指标/日志：优先类型化 `grafana_query_prometheus` / `grafana_query_loki`；
  Loki `limit ≤ 100`（建议 50–100）；窄窗查询；`truncated` → 收窄不放大。
- 告警线：`grafana_list_alert_rules(states: firing)` →
  `grafana_get_alert_rule` → `grafana_get_alert_history`。
- 部署窗口相关性可用 `grafana_list_annotations`（limit 上限 100）。
- `grafana_query_datasource` 是逃生舱，仅限非常规 datasource；
  禁止用于普通 PromQL / LogQL。
