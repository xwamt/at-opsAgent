# Executing · 故障排查

唯一 Executor，命令集与已批简报 commandSetSha256 绑定，禁止即兴扩展。
顺序：时间戳备份 → 校验备份 → 最小变更 → 回读。每条命令首行 `# Purpose:`。

失败：立即停止后续 step、保留现场；命中回滚触发 → 产**新的**回滚简报
（回到 AwaitingApproval），不自动回滚。

DoD：计划内命令全部执行并逐条上报 exit code → Verifying。
