---
name: db-slow-and-capacity
description: 数据库慢查询、QPS 尖刺、连接打满、锁等待。优先 JumpServer SQL 或 AT Database，指标用 Grafana。
---

# 数据库慢查询与容量

SQL 必带 LIMIT。禁止无界 SELECT *。At-Database 的 write 在插件补确认前必须走会话审批。

阶段细则见 `references/`；provider 纪律见
`../../vendor/super-ops@0.1.0/references/jumpserver.md` 与 `database.md`。
