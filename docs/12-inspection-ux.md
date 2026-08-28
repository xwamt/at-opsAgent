# 12 · 巡检实录整改设计（先设计后落地）

对照一次真实「对我当前连接的服务器进行服务器巡检」会话，以及 Cline / Kilo / OpenCode 的交互：

| 用户痛点 | 根因（代码） | 对标做法 |
|----------|--------------|----------|
| 最后才找到已连接服务器 | `pb.inspection` selecting 默认 `pluginIds: [at.grafana]`；L2 没要求先认客户端 | Cline/Kilo：先收集 editor/workspace 上下文再动手 |
| 一台机器却派一堆子代理 | L4 把 yaml `parallelGroup` 写成清单；模型照单全发 | Kilo：子代理是显式 task，单文件/单目标不拆 |
| 点了不知道子代理在干什么 | 详情藏在小按钮；`latest` 空则按钮不出现；无 inspector | Kilo Sub-Agent Viewer：点行打开只读 transcript |
| 找到终端就停 | 子代理拿不到 `run_remote_command`（risk=exec 被 investigator ceiling 滤掉）；主代理没有自己跑巡检 | 单目标由主会话直接调工具 |
| UI/设置不好看 | 设置模型页四张卡竖堆；子代理卡像日志 | Cline Settings：主表单一列，高级折叠 |

## 目标流程（单台已连接 SSH）

```text
用户：巡检当前连接的服务器
  1. ops_list_providers（识别 AT 客户端）
  2. 若 at.terminal 健康 → list_ssh_servers + get_terminal_context
     （connected=true 优先；serverId 记下）
  3. ops_select_tools mode=add names=[list_ssh_servers,get_terminal_context,run_remote_command]
     或 pluginIds=[at.terminal]
  4. 主会话直接 run_remote_command（只读命令：hostname/uptime/df/free/ps/systemctl --failed）
     —— 禁止为此派 investigator
  5. 产出巡检结论（未检查项写未检查）→ ops_close_playbook
```

多主机或多插件（Grafana+主机）才允许 `ops_dispatch_subagent` / `tasks[]`。

## 落地项（文件锁见各子代理 prompt）

1. **流程/提示词/Playbook**：L0+L2 强制「先认客户端」；dispatch 文案禁止单目标并行；`pb.inspection` 首 select 改为 terminal；skill 路径别名。
2. **Runtime/Policy**：allowTools 显式点名的工具必须注入子会话（不再被 riskCeiling 滤掉）；`run_remote_command` 对只读命令推断为 read；子代理事件带 goal/visibleTools。
3. **子代理 UI**：整卡可点开 inspector（目标、状态、可见工具、全文 latest）；聊天顶栏运行中条。
4. **Chat 视觉**：密度、卡片、空态与巡检友好文案。
5. **设置·模型页**：主路径（provider/url/model/key/保存并测试）一屏；兼容/OAuth/角色模型进「高级」折叠。
