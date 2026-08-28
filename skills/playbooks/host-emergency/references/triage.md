# Triage · 主机应急

先 `get_terminal_context` / `jumpserver_get_terminal_context`；
多目标可能时**问用户，绝不猜 serverId**。
确认：主机、症状（磁盘 / CPU / OOM / 服务挂死 / 证书）、起始时间。

禁止：未知原因默认重启。
DoD：目标主机与症状确认 → Selecting。
