# Triage（Plan）· 日常巡检

第一步认目标：先读 L-env。at.terminal 已声明则立刻 ops_select_tools，
再 list_ssh_servers / get_terminal_context 确认已连接（connected=true）的
SSH 目标并记下 serverId。没认到可操作目标前不进入后续阶段。
没有 L-env 才 ops_list_providers。禁止对声明名 get_tool / search。

载入巡检清单（同目录 `checklist.yaml`）：主机组 / 看板组 / 中间件组。
确认范围（全量 or 指定组）与本次判定基线。

禁止：就地修复——发现问题转开对应 playbook
（pb.incident / pb.host-emergency）并在看板挂接。
