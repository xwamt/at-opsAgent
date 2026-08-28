---
name: super-ops
version: 0.1.0
description: >
  AT 系列 SuperOps 运维总纪律的锁版本镜像（语义锁 0.1.0）。当需要
  provider 级工具纪律、payload 上限、审批/证据契约的权威依据时加载；
  每个假设最多追加阅读 1 个 provider 附录 + 1 个 ops reference。
---

# SuperOps 运维总纪律（语义锁 0.1.0）

本目录是 SuperOps / AT 系列运维规则在 at-opsAgent 中的**语义锁定版**：
内容依据本仓已冻结的设计文档（`docs/04-ops-orchestration.md`、
`docs/research/findings/06-ops-ux-and-chains.md`）原创压缩撰写，不是上游
skill 树的逐字拷贝。升级 = 新建 `super-ops@x.y.z` 目录并保留本目录，
**禁止**就地修改本目录语义（见 [NOTICE.md](NOTICE.md)）。

## 十条硬纪律

1. **证据优先**：没有应用侧日志（或等价触发事件）不得宣称根因，只能标
   `hypothesis`；结论必须显式标 `confirmed` / `hypothesis` / `pending` 三态。
2. **快速路径**：窄窗确认尖刺 → top-N 放大面 → 业务日志 → 才允许谈根因。
3. **传播链 ≠ 根因**：MQ/RPS/QPS 同涨说明的是传播，不是源头。
4. **payload 上限**：Loki `limit ≤ 100`；命令 / SFTP 输出默认 64KB（硬顶
   256KB）；SQL 必带 `LIMIT`；`truncated` → 收窄查询而不是放大限额。
5. **诊断不授权修复**：任何 write/exec 先出 9 要素审批简报，会话内明确批准
   （ApprovalBar）才有效；插件 IDE 确认弹窗 ≠ 会话批准。
6. **只读矩阵**：Grafana / Jenkins / Nacos 的 MCP 工具全部只读；触发构建、
   发布/回滚配置等写操作是 GuidedManual——由用户在 IDE 插件 UI 完成，
   Agent 只出指引与深链，**不得**寻找或扩展写 MCP 面。
7. **渐进披露**：每个假设最多加载 1 个 provider 附录 + 1 个 ops reference；
   假设换了换文件，不累积。
8. **发现纪律**：每任务一轮 select；中途只允许一次 `add`；调查中禁止 clear
   （clear 只挂在 Closed 出口）。
9. **子代理**：Investigator 只读硬顶；Executor 必须携带有效 approvalToken
   且命令集与已批简报哈希一致；子代理禁止嵌套下发、select、clear。
10. **安全初判只读**：疑似入侵一律取证心态；kill / 禁号 / 隔离不在链路内
    执行，只出遏制方案简报升级人工。

## 附录索引（按需读，1+1 上限）

| 场景 | provider 附录 | ops reference |
|------|---------------|---------------|
| 指标 / 日志 / 告警 | [grafana.md](references/grafana.md) | [evidence.md](references/evidence.md) |
| 构建 / 发布 | [jenkins.md](references/jenkins.md) | [approval.md](references/approval.md) |
| 配置中心 | [nacos.md](references/nacos.md) | [approval.md](references/approval.md) |
| 直连主机 | [terminal.md](references/terminal.md) | [approval.md](references/approval.md) |
| 堡垒机 / SQL / Redis | [jumpserver.md](references/jumpserver.md) | [evidence.md](references/evidence.md) |
| 数据库客户端 | [database.md](references/database.md) | [approval.md](references/approval.md) |
