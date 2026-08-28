# Investigating · 数据库慢查询与容量

只读并行 ≤2：
- inv-sql（`jumpserver_mysql_execute_sql`）：全部带 LIMIT——慢日志 top-N、
  PROCESSLIST 摘要、information_schema 容量、单条可疑 SQL 的 EXPLAIN；
- inv-metrics（grafana，若已 add）：窄窗 Com_* 分解、连接数、锁指标。

QPS 尖峰模式必做：同窗业务日志找 batch / job / approve 触发。

禁止：全表扫、无界 `SELECT *`、批量 EXPLAIN、先杀会话。
停止条件：batchId/trace 链断即止，不造链接；疑入侵 → 转 pb.security-triage。
DoD：Top SQL / 驱动维度定位；尖峰有触发证据或降级 hypothesis。
