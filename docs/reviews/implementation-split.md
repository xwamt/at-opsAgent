# 落地拆分（子代理文件锁）

主代理只调度。各子代理 **必须** 使用 `claude-fable-5-thinking-xhigh`。协议类型已写入 `src/protocol/host-protocol.ts`，按这些 type 接线，不要另起一套信封。

规范真源：[11-redesign-recommendations.md](../11-redesign-recommendations.md)。**逐项落地 P0 + P1 + 你名下的 P2，不要只做一半。**

完成后：`npm run typecheck` 与你改动相关的 `npm test` 必须通过。不要 `git commit` / `git push`。不要改别人 OWN 的文件；缺接口就按下面契约扩展，并在最终回复列出「需要 host/runtime 接线的点」。

---

## 文件锁

| 代理 id | OWN（只许改这些） | 禁止 |
|---------|-------------------|------|
| A-build | `esbuild.extension.mjs`、`test/bundle-smoke.test.ts`（新建，可另建 `test/helpers/mock-openai-sse.mjs`） | `src/**`、`package.json`（vitest 已 include `test/**/*.test.ts`） |
| B-chat | `src/webview-chat/**`、`src/host/webviewHtml.ts` | 其它 host、runtime、settings |
| C-settings | `src/webview-settings/**`、`src/host/modelsView.ts`、`src/host/modelsCatalog.ts`、`src/host/secrets.ts`、`src/host/oauthLogin.ts` | `hostController.ts` |
| D-runtime | `src/runtime/**`、`src/policy/**`、`src/prompts/**`、`src/mcp-client/**`、`src/orchestrator/**`、相关 `test/*.test.ts`（runtime/policy/orchestrator/mcp/playbook） | `src/host/**`、webview |
| E-host | `src/host/**` **除** `webviewHtml.ts` `modelsView.ts` `modelsCatalog.ts` `secrets.ts` `oauthLogin.ts`；以及 `src/host/hostTypes.ts`、`src/extension.ts`、`package.json` contributes/nls/commands/walkthroughs/keybindings/config description、`src/host/exportReport.ts`（新建）、`test/` 里 host/session/settings 测试 | webview-chat、webview-settings、runtime 实现（可改 hostTypes 形状对齐 runtime） |
| F-board | `src/webview-board/**`、`media/icons/**`、`media/walkthrough/**`（新建） | host 业务（walkthrough 内容你写 md；package.json 由 E 注册） |

`src/protocol/host-protocol.ts` 已由主代理改好，**六人都不许再改协议文件**，除非要修编译错误且只加可选字段。

---

## 契约（跨代理）

### Runtime（D 实现，E 调用）

`CreateOpsRuntimeOptions` 增加：

- `resumeSessionFile?: string`
- `getApiKey?: (providerId?: string) => Promise<string \| undefined>`（按 provider 取；兼容无参）
- `onCatalogNeedsRebuild` 语义改为「会话 idle 后再重建」，D 侧可在 agent_end 后调；E 不要在事件到达时立刻 dispose。

`OpsRuntime` 增加：

- `sessionFile?: string`（当前 JSONL 路径）
- `abort(mode?: 'cancel' | 'stop')`
- `probeModel?(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>`
- 事件 `OpsRuntimeEvent` 增加 `{ type: 'usage'; ...UsageView }`、`{ type: 'compaction'; summary: string }`、`{ type: 'notice'; variant; text; actions? }`

`OpsRuntimeHandlers.beforeToolCall` ctx 增加：

```
origin?: { kind: 'main' } | { kind: 'subagent'; taskId: string; role: string; riskCeiling: string; approvalToken?: string }
```

`requestApproval?(input): Promise<'approved' | 'rejected'>`：当 policy `needSessionApproval` 时，**在 tool execute 内 await**，不要抛错让模型重试。

`ops_dispatch_subagent`：**阻塞**到子代理终态，工具结果 = 摘要 JSON；删除 `deliverToMain`。

Playbook 工具增加 `ops_advance_stage` / `ops_close_playbook`（`PlaybookToolHost` 扩 `advance`/`close`）。

`FALLBACK_NOTICE`：仅无凭证时说「未配置模型」；其它创建失败说「模型运行时初始化失败」+ 原因，不要提「能力插件树」「src/runtime」。

模型 json 字段：写 `reasoning` 而非 `thinking`（读端兼容旧 `thinking`）。

`getRegisteredProviderIds()[0]` 启发式注入删除，按实际选中 provider 注入 key。

事件 id 用 `randomUUID()`，禁止 `msg-${counter}`。

Policy：`PolicyContext` 增加 `sessionReadAllowlist?: string[]`（本会话已免审的 read 工具名）；read 且命中则 `needSessionApproval=false`。`mcp_list_servers`/`mcp_search_tools` risk=read，`mcp_call_tool` 缺省 write。

### Secrets（C 实现，E 调用）

- 键：`atOpsAgent.apiKey.<providerId>`；读时若新键空则回退 `atOpsAgent.llmApiKey` 并一次性迁移。
- `getLlmApiKey(providerId?: string)` / `setLlmApiKey(value, providerId?: string)` 保持旧方法兼容。
- models.json 占位符：`${secret:atOpsAgent.apiKey.<providerId>}`。

### Host（E）

- chat webview `attach` 后会发 `hydrate` req；你必须处理 `dir:'req' type:'hydrate'` 回 `res` 或再推 `evt hydrate`。`ChatViewProvider.resolve` 不要在 html 赋值后立刻 postHydrate 作为唯一路径，或保留 push 同时接受 pull。
- `session/switch` 读 `payload.id`，兼容 `sessionId`。
- `SessionStore` 落盘 `~/.at-series/agent/ui-sessions.json`（或 agentDir 下），activate 回载。
- `requestSessionApproval` **不要求** `activeRun`；无 run 时仍出 9 要素简报 + ApprovalBar；`requestApproval` Promise 挂起工具。
- 批准后 `runtime.prompt('审批已通过…请继续', { mode: 'followUp' })`。
- `models/test` `models/fetch`：C 的 settings store 会发这些 req，E 必须路由到探测（可用 runtime.probeModel 或直接 GET `{baseUrl}/models` + 1-token）。
- `asset/pick`：VS Code QuickPick，返回 AssetPickRes。
- `chat/export`：`exportReport.ts` 把 transcript+timeline+approvals 写成 Markdown 并存/打开。
- `chat/abort` payload.mode：cancel=软停（等当前工具结束）stop=立即 abort。
- 删除 `src/host/modules.ts` 与 `src/host/fallback/**`（P1-8），host 静态 import runtime/orchestrator/hub-host/mcp-client。创建失败用 runtime 自带 `createFallbackRuntime`（文案已由 D 改）。
- 删除 `src/host/trees/**` 死代码；删除 `showModelsPanel` 若仍在 modelsView（C 的文件——C 删）。
- 状态栏：无模型时 `$(warning) AT Ops 未配置`，点击 `atOpsAgent.openModels`。
- `contributes.walkthroughs` 三步（内容 md 在 `media/walkthrough/`，F 写文件，E 注册）。
- 所有 `atOpsAgent.*` configuration 补 `description`。
- `abort` 标题栏 `when` 仅运行中（context key `atOpsAgent.running`）。
- keybindings：`ctrl+esc` 聚焦聊天，`ctrl+shift+esc` 新会话（mac cmd）。
- 只读免审：配置或 session 内存 Set，批准 read 时可「本会话不再问」；E 把 allowlist 传给 policy。
- 并行会话 ≤2：允许两个 runtime 同时 prompt（查库+查主机）；超出排队。若侵入太大，至少不要破坏现有单会话，并留下 `maxConcurrentSessions` 配置与第二会话骨架。
- 定时巡检：`atOpsAgent.inspection.cron` 或 VS Code 相对简单的 `setInterval` + InformationMessage「启动 pb.inspection」；人点才跑。
- IM：`atOpsAgent.im.webhookUrl`，待审批时 POST 脱敏摘要 JSON（无 token、无 key），深链说明回 IDE 批准。
- per-role 模型：settings.json `roleModels?: Record<string, {provider, model}>`；E 在 dispatch 子代理时传入；C 提供 UI。
- OpsCore：新建 `src/core/index.ts` 把 createOpsRuntime + createOrchestrator + createAtSeriesHubHost + evaluatePolicy 收成 `createOpsCore()`，hostController 改为依赖它（可渐进：先 facade 再把 gate/approval 迁入）。这是 P2，E 负责（D 不改 core 文件以免冲突——E 只封装已有导出）。

### Chat UI（B）

必须完成：Markdown（markdown-it，禁 raw html）、codicon（`@vscode/codicons` 经 webviewHtml 注入 css，CSP font-src 已放行）、ApprovalBar 两段式、WelcomeState 未配置 CTA、Composer 拦截未配置、ModelSelector 空态可点「配置模型」、`session/switch` 发 `{ id }`、hydrate pull、处理 `dir:'res'`、notice/system 项、Retry 按钮、usage 条、工具卡默认折叠+只读聚合、PlaybookHeader 去掉与 view/title 重复的历史/Playbook 按钮、i18n 补漏、`window.prompt` 改为 `asset/pick`、软停/硬停两按钮、最近会话进空态。

### Settings UI（C）

Provider 预设下拉、保存并测试（`models/test`）、拉取模型（`models/fetch`）、未填 key 禁止「已保存」、placeholder 首跑不要「留空=保持现有」、`thinking`→`reasoning`、OAuth provider 下拉、编辑器背景、MCP 卡片化、Sessions 可保留但切会话用 `{ id }`、per-role 模型映射表、只读免审规则展示（配置键 `atOpsAgent.approval.sessionReadAllowlist` 或类似）。

### Build（A）

```js
define: { 'import.meta.url': '__importMetaUrl' },
banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" }
```

`test/bundle-smoke.test.ts`：用**同一套** define/banner 把引用 `createOpsRuntime` 的 harness 打成 CJS，起本地 mock OpenAI SSE，注入 key，断言收到 text_delta 且 Authorization Bearer 正确。把 define 去掉时该测试应失败（可用注释说明）。超时可 30s。

### Board（F）

severity 过滤、搜索、相对时间、日期分组、图标 `currentColor`、walkthrough 三篇中英 md。
