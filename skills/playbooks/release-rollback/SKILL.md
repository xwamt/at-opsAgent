---
name: release-rollback
description: 发布、回滚、构建失败、金丝雀。Jenkins MCP 只读；触发构建走 GuidedManual。
---

# 发布与回滚

先用 `at.jenkins` 只读确认制品与构建；回滚是一次新部署。触发/停止构建：`guidedManual.command = atJenkins.triggerBuild`（用户在 IDE 点击，Agent 不得调用写 MCP）。

阶段细则见 `references/`；Jenkins 纪律见
`../../vendor/super-ops@0.1.0/references/jenkins.md`。
