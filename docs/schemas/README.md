# 机器可读契约

| 文件 | 用途 |
|------|------|
| `playbook.schema.json` | `skills/playbooks/*/playbook.yaml` |
| `task-spec.schema.json` | `ops_dispatch_subagent` 参数 |
| `hub-host.ts` | 嵌入 Hub 适配层 |
| `host-protocol.ts` | webview ↔ host envelope |

实现阶段将这些文件移到 `packages/protocol` 并被扩展与 webview 同时引用，避免两份拷贝。
