# Skills 与 Playbook

本目录随扩展打包，由 `OpsResourceLoader` 加载。格式遵循 [Agent Skills](https://agentskills.io)（`SKILL.md` + YAML frontmatter）。

| 路径 | 作用 |
|------|------|
| `ops-agent-core/` | 身份、红线、证据/审批契约（常驻 + 按需 references） |
| `playbooks/<id>/` | 一等运维链路：`SKILL.md` 给人与路由，`playbook.yaml` 给 Orchestrator |
| `vendor/super-ops@<ver>/` | 实现阶段从 `at-series-mcp-hub` 锁版本镜像，禁止改语义 |

施工时不要把 SuperOps 全文复制进系统提示词；用渐进披露（命中 skill 后再读 references），并遵守「每假设 1 provider 附录 + 1 ops reference」。
