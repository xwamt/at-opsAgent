---
name: host-emergency
description: 单机 CPU/内存/磁盘/服务挂死/OOM。使用 at.terminal 或 at.jumpserver。高危命令必须审批。
---

# 主机应急

命令首行 `# Purpose:`。默认禁止无界 journalctl -f、nginx -T、全盘 find。变更前备份并验证备份。
