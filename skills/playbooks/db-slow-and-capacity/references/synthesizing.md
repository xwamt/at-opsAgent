# Synthesizing · 数据库慢查询与容量

用 batchId / trace 贯穿 指标 → 日志 → SQL 样本；链断即止。
优化建议给出但**不执行任何 DDL**。

出口：kill 会话 / 加索引 / 清理表 → 9 要素简报进 AwaitingApproval
（kill 可能回滚大事务、DDL 逻辑回滚不可行须明示）；否则 → Reporting。
