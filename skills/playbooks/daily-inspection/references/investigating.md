# Investigating · 日常巡检

先看目标面：若 list_ssh_servers 只有一台已连接（connected=true）SSH，
主代理亲自用 run_remote_command 跑只读巡检命令
（hostname / uptime / df -h / free / ps / systemctl --failed），
不要派 inv-metrics / inv-configs / inv-hosts。

多主机或多插件面（主机 + Grafana/Nacos）才按组并行 ≤3，全部只读：
- inv-hosts：逐主机有界巡检命令（`# Purpose:` 首行）；
- inv-metrics：关键 SLO 面板当前值 vs 阈值 + firing alerts；
- inv-configs：Nacos 关键配置 md5 vs 基线、服务实例健康数。

逐项记录：检查方法 / 判定标准 / 实际结果 / 证据 / 状态。
无基线项标「待确认」，不发明阈值。
