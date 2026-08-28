# Skills 与 Playbook

本目录随扩展打包，由 `OpsResourceLoader` 加载。格式遵循 [Agent Skills](https://agentskills.io)（`SKILL.md` + YAML frontmatter）。

| 路径 | 作用 |
|------|------|
| `ops-agent-core/` | 身份、红线、证据/审批契约、playbook 路由（常驻 + 按需 references） |
| `playbooks/<id>/` | 一等运维链路：`SKILL.md` 给人与路由，`playbook.yaml` 给 Orchestrator，各阶段 `prompt` 指向 `references/*.md`（L4 注入） |
| `vendor/super-ops@0.1.0/` | SuperOps / AT 系列运维总纪律的**语义锁**：内容依据本仓设计文档原创压缩（见其 NOTICE.md），发布后禁止就地改语义 |

vendor 升级 = 新建 `vendor/super-ops@x.y.z/` 目录并**保留旧版本**（回归与
审计用），跑 playbook 回归后再切默认；绝不在既有版本目录里修改语义。

施工时不要把 SuperOps 全文复制进系统提示词；用渐进披露（命中 skill 后再读 references），并遵守「每假设 1 provider 附录 + 1 ops reference」。
