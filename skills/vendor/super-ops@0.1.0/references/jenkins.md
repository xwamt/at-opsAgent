# Jenkins 附录

工具前缀 `jenkins_*`，**全部只读**。触发 / 停止构建不是 MCP 工具：走
GuidedManual，由用户在 IDE 的 AT Jenkins 视图点击完成
（深链 `command:atJenkins.triggerBuild`）。**不得**为 Agent 寻找写接口。

- `jenkins_list_instances` 是唯一不需要后台访问授权的工具；其余工具在
  实例未开「Allow Agent background access」时会被拒，此时引导用户去 UI
  开启，不要重试绕过。
- 构建定位：`jenkins_list_jobs` → `jenkins_list_builds`（分页）→
  `jenkins_get_build`。
- 日志：`jenkins_get_build_log` 默认尾部 64KiB（`tailBytes ≤ 256KiB`）；
  用返回的 `start/endByte/hasMore` 做偏移续读，不要一次拉全量。
- 任务参数中的 password/credential 默认值已被脱敏，不要尝试还原。
