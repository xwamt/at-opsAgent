# Verifying · 发布与回滚

独立 Verifier（只读）：
- `jenkins_get_build` 确认构建结果；`jenkins_get_build_log` 尾部扫异常行；
- 经 terminal / jumpserver（若已 add）核对每个实例实际版本 / digest 与
  readiness——不用控制器摘要替代实例核对；
- 观察窗内错误率 / 延迟 vs 基线过健康门。

禁止：以「构建 SUCCESS」宣称发布成功。
命中中止阈值 → 回滚支线：回滚是新部署，重走 preflight + 新简报，
不自动回滚。
