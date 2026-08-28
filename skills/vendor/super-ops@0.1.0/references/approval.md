# 审批与执行纪律（ops reference）

- **诊断不授权修复**。任何 write/exec（含 GuidedManual 中建议用户点击的
  危险按钮）先出 9 要素审批简报，模板见 ops-agent-core 的
  [references/approval-brief.md](../../../ops-agent-core/references/approval-brief.md)。
- 双通道：会话内 ApprovalBar 明确批准是唯一有效审批；插件 IDE 确认弹窗
  只是第三道防线，**永不等于会话批准**。
- 批准产生 `approvalToken`（简报 id + 命令集哈希 commandSetSha256）。
  目标 / 命令 / 影响 / 回滚任一实质变化 → 令牌作废，重新审批。
- 角色隔离：Investigator 只读硬顶（riskCeiling=read，提示词不可覆盖）；
  Executor 必须携带有效 approvalToken 且命令集与简报哈希一致，禁止即兴
  扩展；Verifier 独立只读复核；Writer 不碰业务工具。
- 子代理禁止：嵌套下发子代理、select / clear 工具选择。
- exec 并行度恒为 1；执行失败立即停后续步骤、保留现场；命中回滚触发
  条件 → 产**新的**回滚简报，不自动回滚。
- 只读插件域（Grafana / Jenkins / Nacos）的写意图 → GuidedManual：
  Agent 出操作说明 + IDE 深链，用户在插件 UI 完成后回报，Agent 只读验证。
