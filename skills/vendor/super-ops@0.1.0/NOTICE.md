# NOTICE

`skills/vendor/super-ops@0.1.0/` 是 AT 系列 **SuperOps 运维纪律**在
at-opsAgent 中的语义锁定（semantic lock）目录：

- 内容为 at-opsAgent 维护者依据本仓已冻结的设计文档
  （`docs/04-ops-orchestration.md`、`docs/research/findings/06-ops-ux-and-chains.md`）
  **原创压缩撰写**，使用 AT 系列自己的表述；不包含从 pi-agent-studio、
  at-series-mcp-hub 或其他第三方仓库逐字复制的文本。
- 目录名中的版本号即语义版本：**本目录内容一经发布不得再修改语义**。
  与上游 SuperOps 规则同步或本地修订时，新建 `super-ops@x.y.z` 目录，
  保留旧版本目录以供回归与审计。
- 运行时按目录名版本选择加载；新版本须通过 playbook 回归后方可设为默认。
