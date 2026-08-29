# Skills 与 Playbook

本目录随扩展打包，由 `OpsResourceLoader` 加载。格式遵循 [Agent Skills](https://agentskills.io)（`SKILL.md` + YAML frontmatter）。

| 路径 | 作用 |
|------|------|
| `ops-agent-core/` | 身份、红线、证据/审批契约、playbook 路由（常驻 + 按需 references） |
| `playbooks/<id>/` | 一等运维链路：`SKILL.md` 给人与路由，`playbook.yaml` 给 Orchestrator，各阶段 `prompt` 指向 `references/*.md`（L4 注入） |
| `vendor/super-ops@0.1.0/` | SuperOps / AT 系列运维总纪律的**语义锁**：内容依据本仓设计文档原创压缩（见其 NOTICE.md），发布后禁止就地改语义 |
| `skills.lock.json` | vendor 树哈希；`npm test` 中 `test/skills-lock.test.ts` 重算，不一致即红 |

vendor 升级 = 新建 `vendor/super-ops@x.y.z/` 目录并**保留旧版本**（回归与
审计用），跑 playbook 回归后再切默认；绝不在既有版本目录里修改语义。

施工时不要把 SuperOps 全文复制进系统提示词；用渐进披露（命中 skill 后再读 references），并遵守「每假设 1 provider 附录 + 1 ops reference」。

## SuperOps vendor 升级（diff 仪式）

改 `skills/vendor/super-ops@*` 必须走这三步，禁止 silently 改字：

1. **锁文件**：重算 `skills/vendor/super-ops@x.y.z` 的稳定树哈希（排序相对路径 + 文件字节），写入 `skills/skills.lock.json` 对应 `version` / `sha256`。`test/skills-lock.test.ts` 不一致会失败并提示「vendor 升级走 diff 仪式」。
2. **PR 说明**：列出相对旧版本的语义 diff（增删改了哪些纪律 / references），说明回归范围。
3. **VERSION**：新目录带 `VERSION` 文件，内容与目录后缀及锁文件 `version` 一致；**保留**旧 `super-ops@旧版/` 目录，不要覆盖。
