# JumpServer（堡垒机）附录

工具前缀 `jumpserver_*`（不与 at.terminal 短名混用）。exec 类工具需要
**已连接的 IDE 终端**：先 `jumpserver_get_terminal_context` 按
`connectionKind`（ssh/mysql/redis）过滤；无连接 → 提示用户先在 IDE 连接
资产，Agent 不能后台直连。

- 资产：`jumpserver_list_assets`（search / limit 分页，默认 200）。
- SSH：优先 `jumpserver_run_terminal_command`（非交互，同终端串行执行）；
  `jumpserver_send_terminal_input` 仅交互兜底。命令纪律同 terminal 附录
  （`# Purpose:` 首行、有界、64KB 截断 → 收窄）。
- SQL：`jumpserver_mysql_execute_sql`——SELECT 必带 `LIMIT`；非只读 SQL
  会弹插件确认，但**会话审批依旧必需**。
- Redis：`jumpserver_redis_execute_command` 单条非阻塞；
  SUBSCRIBE / MONITOR / BLPOP 等阻塞命令会被直接拒绝。
- SFTP 先读后写；写侧恒弹确认，弹窗仍不等于会话批准。
