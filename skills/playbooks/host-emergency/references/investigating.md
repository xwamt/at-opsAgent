# Investigating · 主机应急

单代理串行归因（一次验证一个主假设，并行度 1），有界只读命令，
每条首行 `# Purpose:`：

- 磁盘：`df -h`；`du -x --max-depth=2 <嫌疑目录> | sort -h | tail -20`
- 服务：`systemctl status X --no-pager`；`journalctl -u X -n 100 --no-pager`
- 负载：`top -b -n1 | head -20`；`ps aux --sort=-%cpu | head -10`

禁止：`nginx -T`、无界 find、cat 大日志、`tail -f`。
输出 64KB 截断 → 收窄命令而不是提限额。
停止条件：疑似入侵 → 立即转 pb.security-triage。
DoD：症状被有界只读命令证实。
