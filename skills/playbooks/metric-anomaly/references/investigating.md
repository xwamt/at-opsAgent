# Investigating · 指标异常

单 Investigator（只读）：窄窗基线 vs 峰值、驱动维度 top-N、firing alerts。

纪律：`grafana_get_dashboard` 优先 `fields:"targets"` 且 ≤2 次；
Loki limit≤100；truncated → 收窄。
告警路径：list_alert_rules(firing) → get_alert_rule → get_alert_history。

停止条件：多指标同涨 = 传播链 → 只记 hypothesis；预算尽 → 带缺口合成。
DoD：尖峰被窄窗证实（基线 vs 峰值数字）+ 驱动维度 top-N 定位。
