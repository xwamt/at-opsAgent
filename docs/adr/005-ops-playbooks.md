# ADR-005 · 运维 Playbook 与四类子代理

## 状态

Accepted

## 背景

需求：运维专属链路、子代理下发、思维链、提示词；参考 MCP Hub 内 SuperOps skills。业界选项包括 OpenAI handoff、swarm、Claude Code subagents、Anthropic orchestrator-worker。

## 决策

1. **Playbook 是一等对象**（`skills/playbooks/*/playbook.yaml`），不是提示词里的散文。Orchestrator 驱动阶段迁移；模型只在阶段内决策。
2. **编排 = orchestrator-worker（agents-as-tools）**。主代理不移交指挥权。拒绝 handoff（事故指挥权不可转移）和自由 swarm（审计困难）。
3. **四类角色**：Investigator（只读）/ Executor（持 approvalToken 的精确命令集）/ Writer（无业务工具）/ Verifier（只读复核）。调查与执行永不同体。
4. **子代理默认不跑工具发现**（无 L2），`select.mode = inherit`，避免并行 select/clear 打架。
5. **权限闸在 extension host / runtime `beforeToolCall`**，不信任模型自律。插件弹窗是第三道闸，不是第一道。
6. **并行度**：调查 ≤3（硬顶 4）；exec 恒为 1。失败路径 retry → degrade → escalate，Executor 失败保留现场、不自动回滚。

Playbook 清单见 [04-ops-orchestration.md](../04-ops-orchestration.md)。
