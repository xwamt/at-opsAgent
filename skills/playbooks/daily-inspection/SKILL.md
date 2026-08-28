---
name: daily-inspection
description: 日常/周巡检。先认已连接客户端；单机由主会话直查。只读取证，发现问题转开其它 playbook，不就地修复。
---

# 日常巡检（pb.inspection）

本 skill 路径：`playbooks/daily-inspection/`（playbook id 是 `pb.inspection`，
目录名不是 inspection；ops_read_skill 用本目录路径，如
`playbooks/daily-inspection/SKILL.md`、`playbooks/daily-inspection/checklist.yaml`）。

## 单机流程（仅一台已连接 SSH）

1. ops_list_providers 识别 AT 客户端；
2. at.terminal 健康 → list_ssh_servers + get_terminal_context
   （connected=true 优先，记下 serverId）；
3. 工具不在暴露集时 ops_select_tools mode=add
   names=[list_ssh_servers, get_terminal_context, run_remote_command]
   或 pluginIds=[at.terminal]；
4. 主会话直接 run_remote_command 跑只读命令
   （hostname / uptime / df -h / free / ps / systemctl --failed）
   ——禁止为此派 investigator；
5. 产出巡检结论（未检查项写「未检查」）→ ops_close_playbook。

## 多目标流程

多主机或多插件面（主机 + Grafana/Nacos/Jenkins）才用 ops_dispatch_subagent /
tasks[] 按 checklist 分组并行（≤3），清单见同目录 `checklist.yaml`。

未检查项标「未检查」，禁止标「正常」。
阶段细则见 `references/`。
