# AT Database 附录

`at.database`（`db_*`）直连 MySQL / Redis。**特殊风险**：其 write 工具
（`db_execute_query` 任意 SQL、`db_redis_set` 等）当前**没有插件确认
弹窗**——因此经 at.database 的一切 write/exec 在本 Agent 内一律
**强制会话审批**（9 要素简报），无一例外。

- 诊断查询有界：SQL 必带 `LIMIT`；慢日志 / 进程 / 容量走聚合与 top-N，
  不全表扫、不无界 `SELECT *`。
- EXPLAIN 只对单条可疑 SQL，不批量跑。
- DDL（加索引 / 清理表等）：简报必须明示「逻辑回滚是否可行」；
  不可行的 DDL 单独列为不可逆项。
- kill 会话可能回滚大量事务，简报中必须写明该影响。
