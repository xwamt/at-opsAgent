# Investigating · 故障排查

并行 ≤3 个 Investigator（只读硬顶）：inv-metrics 窄窗基线 vs 峰值、
inv-logs 同窗业务日志（limit≤100，找 batch/approve/job/发布）、
inv-changes 近期构建 / 配置变更。

快速路径顺序：确认尖刺 → top-N 放大面 → **必须查业务日志** → 才允许谈根因。
payload：Loki ≤100；命令输出 64KB；`grafana_get_dashboard` ≤2 次。

停止条件：
- MQ/RPS/QPS 同涨且窗口内无应用侧触发事件 → 结论降级 hypothesis；
- 发现疑似入侵证据 → 停止常规处置，转 pb.security-triage（Escalated）；
- 预算耗尽 → 带缺口进入 Synthesizing。

DoD：三个证据面各有便签（或如实标「未取证」）。
