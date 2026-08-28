# AwaitingApproval · 数据库慢查询与容量

简报除 9 要素外必须额外写明：kill 会话可能回滚大量事务；DDL 是否可
逻辑回滚，不可行则列为不可逆项。At-Database write 无插件弹窗 →
会话审批是唯一闸门。

DoD：ApprovalBar 明确批准 → Executing；拒绝 / 只要方案 → Reporting。
