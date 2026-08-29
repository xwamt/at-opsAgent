# 03 · Agent 运行时（pi SDK）

## 1. 会话工厂

每个 VS Code 窗口一个 **主会话**（侧边栏单例）。Playbook 子代理是同进程内的 **子会话**，不占用第二个侧边栏。

```ts
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  defineTool,
  type AgentSession
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

const session = await createAgentSession({
  cwd: workspaceFolder ?? os.homedir(),
  agentDir: join(homedir(), '.at-series', 'agent'),
  sessionManager: SessionManager.create(agentSessionsDir),
  settingsManager,
  modelRuntime: ModelRuntime.create({
    authPath: secretBackedAuthPath,      // 见 §3
    modelsPath: join(agentDir, 'models.json'),
    credentials: vscodeSecretStore
  }),
  resourceLoader: new OpsResourceLoader({
    bundledSkillsDir,                    // extensionPath/skills
    userSkillsDir: join(agentDir, 'skills'),
    systemPromptOverride: buildPrompt({ layers: ['L0','L1','L2','L3'], playbook })
  }),
  tools: [],                             // 不要默认 coding 四件套
  customTools: [
    ...hubHost.toPiTools(),              // 暴露集，动态
    ...workspaceReadOnlyTools(),         // 可选：read skill 文件
    ...externalMcpProxyTools()           // 可选
  ],
  thinkingLevel: settings.thinkingLevel
});
```

动态工具：Hub `onDidChangeTools` 与 Playbook select 完成后调用 pi 的 `setActiveTools(names)`（0.84 类型已包含）。未选中的业务工具从 schema 中摘除，但仍可通过 `HubHost.invoke` 走协议（selection ≠ ACL）。权限闸挂在 invoke 前。

## 2. 内置工具策略

| 工具 | 默认 |
|------|------|
| pi `read` | 仅允许 `skills/`、`~/.at-series/agent/`、当前 workspace 的只读路径 |
| pi `bash` / `write` / `edit` / `grep` 全盘 | **关闭**。运维变更走 AT 插件 |
| Hub 业务工具 | 由暴露集与权限闸共同约束 |
| `ops_*` 发现工具 | 常驻 |
| `ops_dispatch_subagent` | 常驻，仅主会话；子会话不得再派发（禁止递归） |

若用户在设置中打开「允许工作区 shell」，再注入受限 `bash`（working directory = workspace，走 command-policy 预判 + 会话审批）。默认关。

## 3. 自定义 LLM

对齐 pi `models.json` 能力，路径独立：

```jsonc
{
  "providers": {
    "internal-gateway": {
      "baseUrl": "https://llm.corp.example/v1",
      "api": "openai-completions",
      "apiKey": "${AT_OPS_LLM_KEY}",
      "headers": { "X-Tenant": "sre" },
      "compat": {
        "thinkingFormat": "deepseek",
        "supportsDeveloperRole": false
      },
      "models": [
        { "id": "qwen3-max", "name": "Qwen3 Max", "thinking": true }
      ]
    }
  }
}
```

凭证优先级：VS Code SecretStorage → 环境变量 → models.json 明文（UI 警告）。OAuth 流移植 Studio `oauth-flow.ts`，落地到 SecretStorage 而非随意写 `auth.json`；若 pi SDK 强制文件，则写 `~/.at-series/agent/auth.json` 权限 0600，并在 UI 说明。

支持的协议以 pi-ai 为准：`anthropic-messages`、`openai-completions`、`openai-responses`、Azure、Bedrock、Gemini、Mistral。国产（通义 / DeepSeek / Kimi / 智谱）走 OpenAI 兼容 + `compat.thinkingFormat`。

**thinking 归一化**：pi-ai 已做一层。Agent 事件对外只暴露 `thinking_delta` / `thinking_end`。UI 不解析各厂字段。弱工具调用模型：设置项 `atOpsAgent.models.toolCallPromptFallback` 默认开。

模型路由（设置，非模型自律）：

| 角色 | 默认建议 |
|------|----------|
| 主代理（编排 + 综合） | 用户选的强模型 |
| Investigator | 可降级到性价比模型（DeepSeek 等） |
| Executor | 与主代理同模型或指定「谨慎」模型 |
| Writer | 可小模型 |

## 4. 会话持久化

使用 pi JSONL v3（树、fork、compaction checkpoint）。目录：`~/.at-series/agent/sessions/`。

额外 `custom` entry（不进 LLM 上下文，进审计）：

```ts
type OpsCustomEntry =
  | { kind: 'playbook_transition'; playbookId: string; from: string; to: string }
  | { kind: 'approval'; briefId: string; decision: 'approved' | 'rejected'; token: string }
  | { kind: 'subagent_spawn'; taskId: string; role: string }
  | { kind: 'subagent_result'; taskId: string; status: string }
  | { kind: 'guided_manual'; command: string };
```

崩溃恢复：扩展重启后加载最近会话到最后完整 `turn_end`；进行中的 tool_call 标 `interrupted`。

## 5. Compaction

运维数据比代码 diff 更大。三层：

1. **工具结果裁剪**：超过 `payloadCaps` 的 result 落 `globalStorageUri/tool-results/<id>.json`，喂给模型的是摘要 + URI；UI LogViewer 用 URI 打开。
2. **pi 自带 compaction**：调用时带运维 `customInstructions`（保留 evidence-note 与置信度、审批摘要、playbook 阶段/DoD、已识别主机；丢弃重复 MCP list/search 与长 stdout，改引 toolCallId）。这是 SRE/on-call 会话，不是 coding 摘要。
3. **`prompt_too_long` 重试**：强制 compact 一次并 retry 一次；仍失败则停。host 拦截后发 notice（「携带交接包开新会话」+「仅提示」），**不**自动开新会话。

compact 之后 host 从本会话 evidence 便签与审批时间线合成 ≤20 行 L-mem digest，经 `StageLayerInjector.applyLayers({ memLayer })` 回灌系统提示词（L-env → L-mem → L4）。EvidenceBoard 的结构化便签留在 `sessionStore`（UI 不丢）；模型侧靠 L-mem digest 再看见证据板，而不是 orchestrator 内存或 JSONL `custom` entry。仍溢出时可一键开新会话并自动带上同一交接包，不必手抄。

## 6. 流式事件 → UI

pi `AgentEvent` 映射为 host-protocol（见 schemas）：

| pi 事件 | UI |
|---------|-----|
| `message_update` text | ChatTranscript 流式 markdown（合批 30–50ms） |
| `message_update` thinking | ThinkingTrace（默认折叠） |
| `tool_execution_start/update/end` | ToolCallCard |
| `agent_end` | 解锁输入；Playbook 阶段评估 |

Steering：用户在运行中再发送 = pi `steer`（插入本 turn）。Alt/修饰键发送 = `followUp`（排队下一 turn）。UI 按钮文案用运维语言：「追加约束」/「排队下一问」。

## 7. 权限钩子

```ts
config.beforeToolCall = async (ctx, signal) => {
  const gate = policy.evaluate({
    toolName: ctx.toolName,
    args: ctx.args,
    risk: hubHost.riskOf(ctx.toolName),
    task: orchestrator.currentTask,      // 子代理则有 riskCeiling
    approval: orchestrator.approvalState
  });
  if (gate.block) return { block: true, reason: gate.reason, terminate: false };
  if (gate.needSessionApproval) {
    const decision = await host.requestApproval(gate.brief);
    if (decision !== 'approved') return { block: true, reason: 'user_rejected' };
  }
  return { block: false };
};
```

规则见 [07-security.md](07-security.md)。**禁止**用 selection 当授权。

## 8. 自定义 MCP（非 AT）

`~/.at-series/agent/mcp.json`：

```jsonc
{
  "servers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "directTools": []
    }
  }
}
```

传输：stdio 与 Streamable HTTP。Idle 断连、元数据磁盘缓存移植 pi-mcp。AT Series 去重见 02 §5。

Settings UI 提供增删改；与「能力插件」页严格分开，避免用户以为还要「配一个 AT MCP」。
