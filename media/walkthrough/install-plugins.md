# 安装 AT 能力插件（零 MCP 配置）

Agent 的取证能力来自 **AT 系列能力插件**：装好即用，**不需要写任何 MCP 配置文件**。

## 1. 安装插件

在扩展市场搜索并安装你环境里用得到的 AT 插件：

- **AT Terminal** —— 连接主机 / 堡垒机做只读取证（`Ctrl+Shift+X` 搜索 `AT Terminal`）。
- **AT Grafana** —— 查询指标面板与告警。
- 还有 AT Jenkins、AT Nacos 等，按需安装即可。

## 2. 无需任何配置

插件装好后会通过进程内 Hub **自动注册**到 Agent：

- 不需要 `mcp.json`，不需要命令行参数，不需要重启 VS Code。
- 插件的登录凭据留在插件自己手里，Agent 只能调用它暴露的工具，**拿不到你的密码 / token**。
- 写操作和执行类操作永远先经过 IDE 内审批，插件端还可能二次确认。

## 3. 验证接入

打开 [设置 → 能力插件](command:atOpsAgent.openSettings)，应能看到刚装的插件已列出（显示健康状态与工具数）。

没出现？运行 [刷新 Bridge](command:atOpsAgent.refreshBridges) 重新扫描；仍有问题用 [诊断 Hub](command:atOpsAgent.diagnoseHub) 查看每一步的接入日志。

## 完成标志

回到聊天，问一句「我的环境里有哪些可用的能力插件？」——Agent 会列出已接入的插件与工具。
