# 调研附录

设计文档的结论来自六路并行深度调研（2026-08-28），交叉验证了 xwamt 全部 AT 系列公开仓库、`@at-series/mcp-hub` 协议与源码、官方 pi SDK（`earendil-works/pi`）、pi-agent-studio、以及 Continue / Cline / Cursor / Claude Code / MCP SDK / Anthropic Tool Search 等外部资料。

| 文件 | 覆盖 |
|------|------|
| [findings/01-at-plugins-core.md](findings/01-at-plugins-core.md) | At-Terminal / JumpServer / Grafana / Database：工具目录、Bridge、零改动验证 |
| [findings/02-at-plugins-newer.md](findings/02-at-plugins-newer.md) | At-jenkins / At-Nacos / `@at-series/command-policy` |
| [findings/03-mcp-hub-embedding.md](findings/03-mcp-hub-embedding.md) | Hub v1/v2 字段级协议、嵌入方案对比、SuperOps 提炼 |
| [findings/04-piagent-stack.md](findings/04-piagent-stack.md) | pi SDK vs Studio vs RPC；路线 D 推荐 |
| [findings/05-tech-landscape.md](findings/05-tech-landscape.md) | VS Code Agent API、同类产品、MCP、LLM、多 Agent、性能 |
| [findings/06-ops-ux-and-chains.md](findings/06-ops-ux-and-chains.md) | 运维 IA、8 条 Playbook、子代理、UI 组件 |

正文若与附录冲突，以 `docs/00`–`10` 与 ADR 为准（附录中个别建议在交叉验证后被否决，见 ADR-001、ADR-004）。
