# Selecting · 日常巡检

默认首组 at.terminal（编排器已代发一轮 replace）：直接用一等工具名
list_ssh_servers / get_terminal_context / run_remote_command 巡检已连接主机。
需要看板/中间件面时用一次 mode=add 扩面（at.grafana / at.nacos / at.jenkins），
不要二次 replace。
按 checklist 分组推进（组间是任务边界——巡检是少数多轮 select 合法的链路）；
组内仍禁止 clear 与二次 replace。
