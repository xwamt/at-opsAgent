---
name: incident-response
description: >
  线上故障、5xx、超时、错误激增、可用性下降时使用。
  走 Grafana 只读取证，必要时 add 主机/Jenkins，禁止未批准变更。
---

# 故障排查 Playbook

机器状态机见同目录 `playbook.yaml`。人读流程：

1. 确认环境与时间窗，不要先写长报告。
2. Orchestrator 会 `replace` 选择 `at.grafana`。
3. 并行取证：指标、日志、近期变更。指标相关 ≠ 根因。
4. 需要主机或构建证据时 **add** 一次第二 provider，调查中禁止 clear。
5. 变更必须 9 要素审批；Grafana/Jenkins 写操作走 GuidedManual。
