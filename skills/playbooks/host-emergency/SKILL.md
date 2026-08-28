---
name: host-emergency
description: 单机 CPU/内存/磁盘/服务挂死/OOM。使用 at.terminal 或 at.jumpserver。高危命令必须审批。
---

# 主机应急

命令首行 `# Purpose:`。默认禁止无界 journalctl -f、nginx -T、全盘 find。变更前备份并验证备份。

阶段细则见 `references/`；provider 纪律见
`../../vendor/super-ops@0.1.0/references/terminal.md` 或 `jumpserver.md`。
