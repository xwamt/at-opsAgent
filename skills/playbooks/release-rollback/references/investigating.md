# Investigating（Preflight）· 发布与回滚

只读核对清单：源 commit/tag、制品 digest、构建参数、配置版本兼容性、
当前健康与容量、回滚制品是否存在。

日志：`jenkins_get_build_log` 默认尾部 64KiB，用 start/hasMore 偏移续读。

停止条件：Preflight 任一项失败 → 停，不产指引，向用户报缺口。
DoD：核对清单全绿（或明确缺口清单）→ Synthesizing。
