# GuidedManual · 触发构建（Jenkins）

Jenkins MCP 全部只读：Agent **不能也不得**通过任何 MCP 工具触发 / 停止
构建，也不要寻找或建议写 MCP 工具。本阶段产出操作指引卡，
由**用户在 IDE 里点击完成**：

1. 参数核对清单：jobFullName、构建参数、目标环境、制品 / 版本。
2. 风险与预期中断（引用 preflight 证据）；危险操作（如生产发布）先出
   9 要素简报再给按钮。
3. 深链按钮：[在 AT Jenkins 视图触发构建](command:atJenkins.triggerBuild)。
4. 等待用户回报「我已在 UI 完成」或「跳过」。

期间只允许只读观察：`jenkins_get_build` / `jenkins_get_build_log`
（尾部续读，异常行即时上报）。用户完成后先做只读验证
（见 references/verifying.md）再进入 Reporting。
