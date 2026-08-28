# 06 · 接口与规范总表

实现时以本页 + `docs/schemas/*` 为真源。Hub 线协议仍以 `@at-series/mcp-hub` 的 v1/v2 文档为准，此处只列 Agent 侧增量。

## 1. HubHost（Agent 仓）

完整类型见 [`schemas/hub-host.ts`](schemas/hub-host.ts)。摘要：

```ts
interface HubHost extends Disposable {
  readonly hostApp: string;
  start(): Promise<void>;
  listExposedTools(): readonly AgentToolDescriptor[];
  listAllTools(): readonly AgentToolDescriptor[];
  getProviders(): ListProvidersResult;
  invoke(inv: ToolInvocation): Promise<ToolInvocationResult>;
  refresh(): Promise<void>;
  readonly selection: SelectionController;
  readonly onDidChangeTools: Event<ToolChangeEvent>;
}

interface ToolInvocation {
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;          // default 120_000
  abort?: AbortSignal;
}

interface AgentToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  risk: 'read' | 'write' | 'exec';
  pluginId: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: true;
  };
}
```

`ToolProvider` 抽象：`id` 为 `at-series` 或 `mcp:<server>`。Orchestrator 只依赖该抽象。

## 2. 发现工具（暴露给模型的稳定面）

| name | 参数 | 返回 |
|------|------|------|
| `ops_list_providers` | `{}` | 同 Hub `at_list_providers` |
| `ops_search_tools` | `{ query: string, pluginId?: string, limit?: number }` | `{ name, pluginId, title, risk, descriptionPreview }[]` |
| `ops_get_tool` | `{ name: string }` | 完整 `AgentToolDescriptor` |
| `ops_select_tools` | `{ pluginIds?: string[], names?: string[], mode?: 'replace'\|'add' }` | `{ selected, exposed }` |
| `ops_clear_tool_selection` | `{}` | `{ ok: true }` — **仅 Closed/任务边界** 放行 |
| `ops_dispatch_subagent` | `TaskSpec` | `{ taskId, status }` 异步；结果走事件 |

业务工具以协议短名注册为 pi `customTools`，`execute` → `hubHost.invoke`。

## 3. Playbook YAML

Schema：[`schemas/playbook.schema.json`](schemas/playbook.schema.json)。必填：`id`, `version`, `triggers`, `stages`。`stages[].select` 由 Orchestrator 执行，不依赖模型调用 `ops_select_tools`（模型仍可见当前选择，以便遵守纪律）。

## 4. Task spec

Schema：[`schemas/task-spec.schema.json`](schemas/task-spec.schema.json)。`specVersion: 1`。

## 5. Evidence note

```ts
interface EvidenceNote {
  contract: 'evidence-note@1';
  taskId: string;
  confidence: 'confirmed' | 'hypothesis' | 'pending';
  summary: string;                 // ≤800 tokens
  timeWindow?: { from: string; to: string };
  refs: Array<{
    kind: 'metric' | 'log' | 'config' | 'pipeline' | 'host' | 'other';
    toolName: string;
    pluginId: string;
    preview: string;               // 已截断
    artifactUri?: string;          // 完整结果
  }>;
  conflicts?: string[];
}
```

## 6. 审批简报

```ts
interface ApprovalBrief {
  id: string;
  playbookId: string;
  risk: 'write' | 'exec';
  pluginId: string;
  targetLabel: string;
  elements: {
    goal: string;
    evidence: string;
    impact: string;
    prechecks: string;
    backup: string;
    commands: Array<{ tool: string; command?: string; args?: object }>;
    successCriteria: string;
    rollback: string;
    unknowns: string;
  };
  commandSetSha256: string;        // canonical JSON sha256 of commands
  dualConfirmHint: boolean;
}
```

`approvalToken = hmac(briefId + commandSetSha256 + sessionId)` 仅存内存 + 会话 custom entry，不进 LLM。

## 7. Host ↔ Webview 协议

见 [`schemas/host-protocol.ts`](schemas/host-protocol.ts)。每条消息：

```ts
interface Envelope<T = unknown> {
  v: 1;
  id: string;                      // request_id；事件可空
  dir: 'req' | 'res' | 'evt';
  type: string;
  payload: T;
  ts: number;
}
```

核心 type：

| type | dir | payload |
|------|-----|---------|
| `chat/prompt` | req | `{ text, attachments?, mode?: 'steer'\|'followUp' }` |
| `chat/abort` | req | `{}` |
| `model/set` | req | `{ provider, model, thinkingLevel? }` |
| `playbook/start` | req | `{ playbookId }` |
| `approval/respond` | req | `{ briefId, decision: 'approved'\|'rejected' }` |
| `subagent/abort` | req | `{ taskId }` |
| `transcript/patch` | evt | `{ itemId, patch }` |
| `tool/start` `tool/update` `tool/end` | evt | ToolCallCard 数据 |
| `thinking/delta` | evt | `{ itemId, text }` |
| `subagent/upsert` | evt | SubagentCard |
| `timeline/upsert` | evt | TimelineEvent |
| `approval/request` | evt | ApprovalBrief |
| `capabilities/snapshot` | evt | providers |
| `hydrate` | evt | 全量快照（webview resolve 后） |

大 payload 禁止走 envelope：改传 `artifact://` URI，webview 用 `command:atOpsAgent.openArtifact`。

## 8. package.json 扩展清单（目标）

```jsonc
{
  "name": "at-ops-agent",
  "displayName": "AT Ops Agent",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "atOpsAgent", "title": "AT Ops Agent" }] },
    "views": { "atOpsAgent": [ /* chat webview + 5 tree views */ ] },
    "configuration": {
      "properties": {
        "atOpsAgent.discovery.mode": { "enum": ["auto", "always", "off"], "default": "auto" },
        "atOpsAgent.discovery.threshold": { "default": 20 },
        "atOpsAgent.plugins.autoEnableNew": { "default": true },
        "atOpsAgent.approval.sessionRequiredFor": {
          "enum": ["write-exec", "exec-only", "never"],
          "default": "write-exec"
        },
        "atOpsAgent.approval.dedupePluginModal": { "default": false },
        "atOpsAgent.models.defaultThinkingLevel": { "default": "medium" },
        "atOpsAgent.models.toolCallPromptFallback": { "default": true },
        "atOpsAgent.workspaceShell.enabled": { "default": false },
        "atOpsAgent.subagent.maxParallel": { "default": 3, "maximum": 4 },
        "atOpsAgent.streaming.batchMs": { "default": 40 }
      }
    },
    "commands": [
      "atOpsAgent.newSession",
      "atOpsAgent.pickPlaybook",
      "atOpsAgent.openSettings",
      "atOpsAgent.openModels",
      "atOpsAgent.refreshBridges",
      "atOpsAgent.diagnoseHub",
      "atOpsAgent.approveChange",
      "atOpsAgent.rejectChange"
    ]
  }
}
```

Cursor 与 VS Code 共用同一 vsix。`detectHostApp` 决定 registry 目录。

## 9. 错误码

Hub 的 `BridgeErrorBody.code` 原样向上。Agent 增量：

| code | 何时 |
|------|------|
| `OPS_SELECTION_FORBIDDEN` | 调查中 clear / 第二次 replace |
| `OPS_RISK_CEILING` | 子代理越权 |
| `OPS_APPROVAL_REQUIRED` | 无有效 token |
| `OPS_APPROVAL_STALE` | 命令哈希不匹配 |
| `OPS_PAYLOAD_CAP` | 参数超过 caps |
| `OPS_PROVIDER_SKIPPED` | 用户 MCP 里的 AT Series 被跳过（仅日志） |
| `OPS_DATABASE_OK_FALSE` | Database 200+ok:false 兼容路径 |

## 10. 日志与审计

- Hub 业务调用：`~/.at-series/logs/<hostApp>/agent-ops-YYYY-MM-DD-<pid>.jsonl`（脱敏、字段 4096 截断、30 天）
- 会话：`~/.at-series/agent/sessions/*.jsonl`
- 扩展 Output Channel：`AT Ops Agent`，含 Hub 刷新失败、MCP 去重、激活耗时
- 禁止：token、Authorization、私钥、SecretStorage 键值
