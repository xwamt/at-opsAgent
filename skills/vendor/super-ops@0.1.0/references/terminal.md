# Terminal（直连 SSH）附录

`at.terminal`：read / write / exec 三级风险。`run_remote_command` 是 exec；
SFTP 读侧 read、写侧 write。插件确认弹窗只是第三道防线，**≠ 会话审批**。

- 先 `get_terminal_context`；多目标可能时**问用户，不猜 serverId**。
- 每条 `run_remote_command` 首行 `# Purpose:` 注释；非交互、有界：禁
  编辑器/TUI/pager/密码提示/`tail -f`/无界 find/`nginx -T`/cat 大日志。
- 输出 `maxOutputBytes` 默认 64KB（硬顶 256KB）；`truncated` → 收窄命令
  而不是提限额。
- SFTP：先 `sftp_stat_path` / `sftp_read_file`（默认 64KB）再写；
  `sftp_list_directory` 默认 500 条。
- 不打印 secrets 或整份 `.env`；只查变量名 / 存在性。
- 汇报必须含 stdout/stderr、exit code、时长、是否截断；exit 0 ≠ 恢复。
