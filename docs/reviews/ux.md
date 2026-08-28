# at-opsAgent 用户友好度 / 首跑体验 / 错误恢复 评审报告

评审对象：`/workspace`（at-ops-agent v0.1.0，VS Code 运维 Agent 扩展）
评审方法：以「新装用户 2 分钟内完成一次 LLM 问答」为验收线，逐文件走查用户旅程代码路径，并与 Cline / Kilo / OpenCode 的 onboarding 设计对照。
核心结论：**用户反馈的「连 LLM 问答配置都完不成」成立**——首跑路径上没有任何引导性入口，配置成功与否没有即时验证，失败反馈是含工程术语的纯文本，且存在一处会话切换协议 bug（webview 与 host 字段名不一致，静默失败）。

---

## 1. 关键用户旅程现状（逐步，标出断裂点）

### 旅程 1：安装扩展 → 打开侧边栏

| 步骤 | 现状 | 代码位置 |
|------|------|----------|
| 激活 | `onStartupFinished`，activate 只注册 Chat WebviewView + 状态栏 + 命令 | `src/host/activate.ts` |
| 侧边栏 | 活动栏仅一个「对话」视图（Cline 式单视图，方向正确） | `package.json` contributes.views |
| 空态 | 标题「开始一次运维调查」+ 副标题 + 6 张 playbook 建议卡 | `src/webview-chat/components/WelcomeState.vue` |

**断裂点 1-A（P0）：欢迎页对「模型未配置」零感知。**
`WelcomeState.vue` 只渲染 playbook 卡片；host 在 hydrate 里其实已经下发 `hasApiKey` 与 `models`（`src/host/hostController.ts` `chatModelsExtra()`），但 chat store 的 `absorbHydrateModels`（`src/webview-chat/store-helpers.ts`）根本不吸收 `hasApiKey`，欢迎页也不消费。新用户看到的是「描述问题、粘贴告警文本…」的邀请，实际上此时发什么都会失败。对比 Cline：welcome 视图第一屏就是 provider 选择 + API key 输入。

**断裂点 1-B（P2）：无 `contributes.walkthroughs`、无 `viewsWelcome`。** `package.json` 里没有任何 VS Code 官方新手引导面。README 的「快速开始」要求用户跑命令面板命令「AT Ops Agent: Open Models」（`README.md` §快速开始 3），这对 IDE 新手不可发现。

### 旅程 2：配置 provider + API key + 选模型

入口有三个，发现性都弱：
1. 视图标题栏齿轮（`package.json` menus `navigation@9`，鼠标悬停才出现图标）；
2. 命令面板 `atOpsAgent.openSettings` / `openModels`（`src/host/commands.ts`）；
3. Composer 模型下拉里的**禁用**占位项「去设置添加模型」（`src/webview-chat/components/ModelSelector.vue` 第 66 行）——它是原生 `<select>` 里的 `disabled option`，必须先点开下拉才看得到，且**点了没有任何跳转**。

设置页 Models 页签（`src/webview-settings/components/ModelsTab.vue`）现状：
- 一张「API Key」卡：Base URL、模型 ID、显示名、thinking 勾选、thinkingLevel 下拉、API Key 密码框；
- 一张「Compat」卡：thinkingFormat / supportsDeveloperRole；
- 一张「OAuth」卡：手填 provider id + 开始登录；
- 底部「保存」+「打开 models.json」。

**断裂点 2-A（P0）：保存 ≠ 可用，且没有任何验证。**
`saveModelsForm`（`src/host/modelsView.ts` 第 251–316 行）唯一校验是 `Base URL 与模型 ID 不能为空`。URL 拼错、模型 id 不存在、**API key 压根没填**都能「已保存」成功。API key 输入框 placeholder 是「留空 = 保持现有 key」（`mApiKeyPlaceholder`，`src/webview-settings/i18n.ts`）——首跑时根本没有「现有 key」，这句话诱导用户跳过必填项。下方虽有「尚未保存 API key」小字（`keyState`），但保存成功的绿色「已保存」会盖过它的警示作用。

**断裂点 2-B（P0）：没 key 时的失败发生在「另一个界面、另一个时刻」。**
保存后 `saveModelsFromSettings` 会静默重建 runtime（`src/host/hostController.ts` 第 577 行）。若 SecretStorage 无 key，`createPiRuntime` 里 `setRuntimeApiKey` 不执行，models.json 的 `${secret:atOpsAgent.llmApiKey}` 占位符按注释所述「会被当成真实 bearer token 发出去」（`src/runtime/index.ts` 第 805–816 行），或 `resolveModel` 抛「没有任何配置了有效凭证的模型（缺少 API key）」（第 622 行）→ 落到 `createFallbackRuntime`。用户在设置页看到「已保存」，回聊天发消息才收到失败——因果链完全断裂，这正是「配置完不成」的直接来源。

**断裂点 2-C（P1）：没有 provider 预设。** 表单只支持一个 openai-compatible provider（`DEFAULT_PROVIDER_ID = 'internal-gateway'`、`DEFAULT_API = 'openai-completions'`，`src/host/modelsView.ts` 第 46–47 行），Base URL 占位符是虚构的 `https://llm.example.internal/v1`。对比 Cline 的 provider 下拉（Anthropic/OpenAI/OpenRouter/…自动带 baseUrl 与模型清单）、Kilo 的 BYOK 多 provider 预设，这里要求用户自己知道网关地址、API 风格、模型 id 精确拼写。OAuth 卡还要求手填 provider id（placeholder "anthropic"），没有可选列表。

积极面：**API key 只进 SecretStorage、models.json 永远保留占位符、密码框永不回显**（`src/host/secrets.ts`、`modelsView.ts`），这一点与 Cline 同级甚至更严格；「打开 models.json」的高级逃生通道（缺文件写模板）也是好设计。

### 旅程 3：发第一条消息

- Composer 永远可发送（`src/webview-chat/components/Composer.vue`，`:disabled="!draft.trim()"` 只看文本非空），模型未配置时无占位符变化、无 banner、无拦截。
- `handlePrompt`（`src/host/hostController.ts` 第 431 行）→ `ensureRuntime()` → 失败落 FallbackRuntime → 用户收到一条**普通样式的 assistant 消息**：
  - runtime 模块在但缺 key：「未配置模型，请在设置中写入 API key；仍可通过**能力插件树**查看已注册 AT 工具。（原因：…）」（`src/runtime/index.ts` `FALLBACK_NOTICE`）；
  - runtime 模块缺席：「模型运行时（**src/runtime**）尚未就绪…当前可用：**Capabilities 树**…命令「AT Ops Agent: Diagnose Hub」…」（`src/host/fallback/fallbackRuntime.ts`）。

**断裂点 3-A（P0）：两条兜底文案都指向已被删除的 UI。** activate.ts 头注释明确「会话/能力/审批/技能/模型**不再注册 TreeView**」，但文案仍让用户去「能力插件树 / Capabilities 树」；还向普通用户暴露源码路径 `src/runtime` 与英文命令名。用户按提示找不到任何东西——错误恢复链在文案层就断了。

**断裂点 3-B（P0）：错误没有动作。** 所有失败（缺 key、401、网络断、模型不存在）最终都是 `text_delta` 纯文本（`src/runtime/index.ts` 第 1060–1067 行「模型调用失败：<原始错误>」；`hostController.handlePrompt` 的「⚠ 模型调用失败：…」）。没有「打开模型设置」按钮、没有错误分类、原始 HTTP/JSON 错误直接透传。Cline/Kilo/OpenCode 在 key 无效时都在**配置界面内**给出内联红字 + 重试入口。

### 旅程 4：错误处理矩阵

| 场景 | 现状 | 评价 |
|------|------|------|
| 无 key | 保存成功→聊天时兜底文案（见 3-A） | 断裂，文案过期 |
| 坏 key | 服务端 401 原文透传「模型调用失败：…」 | 无译文、无动作 |
| 无模型 | 同上（FallbackRuntime） | 同上 |
| 网络失败 | fetch 原始错误透传；`recoverFromPromptError` 只处理上下文溢出 | 无重试按钮 |
| 工具失败 | ToolCallCard 显示 `errorCode + errorMessage` 原文（`ToolCallCard.vue` 第 76–80 行），如 `OPS_APPROVAL_REQUIRED: 已发出 9 要素简报 b-xxx…` | 错误码直怼用户 |
| 审批 | ApprovalBar 出现在 composer 上方，批准/拒绝/简报展开、双确认提示、GuidedManual 变体齐全（`ApprovalBar.vue`） | 结构好，但见 4-A |

**断裂点 4-A（P1）：批准后没有任何可见的继续。** 权限闸的设计是「拒绝本次调用 + 出简报，批准后**模型重试**同一命令集放行」且「绝不在批准后代模型自动重放工具」（`hostController.requestSessionApproval` 注释）。但模型的当轮往往已经结束——用户点「批准」后 ApprovalBar 消失，界面静止，必须**自己再发一条「已批准，继续」**才会推进。没有任何文案告诉用户这一点。这是审批打断感的最大来源。

**断裂点 4-B（P2）：诊断与错误不接线。** `atOpsAgent.diagnoseHub`（`src/host/diagnose.ts`）输出到 Output Channel，内容对工程师很好，但聊天里任何错误都不提供「运行诊断」入口；审批/停止命令也没有 keybindings。

### 旅程 5：切会话 / 切 playbook / 中止

**断裂点 5-A（P0，实际 bug）：聊天历史抽屉的「切换会话」静默失败。**
chat webview 上行 `session/switch` 的 payload 是 `{ sessionId }`（`src/webview-chat/store.ts` 第 249 行），而 host 读的是 `payload.id`（`src/host/hostController.ts` 第 392 行，协议类型 `SessionSwitchReq = { id: string }`，`src/protocol/host-protocol.ts` 第 70 行）→ 恒返回 `{ ok:false }`，UI 只关抽屉不提示。chat 的 mock host 恰好也用 `sessionId`（`src/webview-chat/mock-host.ts` 第 275–279 行），所以开发态测不出来；设置页 Sessions 页签用 `{ id }`（`src/webview-settings/store.ts` 第 469 行）反而是通的。同一功能两个入口一好一坏，用户会认为「历史就是坏的」。

**断裂点 5-B（P1）：会话不持久。** `SessionStore` 纯内存（`src/host/sessionStore.ts`），重启窗口后历史清零、标题只有「会话 N」；docs/06 §10 承诺的 `~/.at-series/agent/sessions/*.jsonl` 只有 pi 侧在写，UI 不读回。对比 Cline 的任务历史（跨重启、可搜索、带成本），这是明显缺口。

Playbook 切换（欢迎卡 / `/playbook` / 标题栏按钮 → `PlaybookPicker`）与中止（流式中 composer「⏹ 停止」+ 标题栏命令）链路完整可用；`atOpsAgent.abort` 标题栏按钮在空闲时也常驻显示是小瑕疵。

---

## 2. 友好度问题清单

**文案**
1. 兜底文案指向已删除的「能力插件树 / Capabilities 树」，并暴露 `src/runtime` 源码路径（`src/runtime/index.ts` FALLBACK_NOTICE、`src/host/fallback/fallbackRuntime.ts`）。
2. 工程术语直怼用户：`OPS_APPROVAL_REQUIRED`、「9 要素简报」、`thinkingFormat（思考字段兼容格式）`、`${secret:atOpsAgent.llmApiKey}`、「hydrate」「L4」。设置页大量键名式标签「渐进披露模式（discovery.mode）」（`src/webview-settings/i18n.ts`）。
3. 「留空 = 保持现有 key」在首跑时误导（ModelsTab.vue / modelsView.ts）。
4. `package.json` configuration 大部分键无 `description`（只有 discovery.mode 有），VS Code 原生设置页里是裸键。

**空状态**
5. 欢迎页无「未配置模型」分支（WelcomeState.vue）。
6. 模型下拉空态是不可点的 disabled option（ModelSelector.vue）。
7. 能力插件空态文案好（capEmpty），是正面样板。

**错误提示**
8. 全部错误都是普通 assistant 文本，无样式区分、无动作按钮、无「打开设置/重试/诊断」深链。
9. 原始 HTTP/SDK 错误不做分类翻译（401/超时/DNS 同等对待）。
10. 保存成功与运行时可用脱钩：设置页绿「已保存」≠ 能问答（modelsView.saveModelsForm 无连通性验证）。

**发现性**
11. 设置入口仅靠悬停才出现的齿轮与命令面板；`openModels`、`diagnoseHub` 无 UI 入口。
12. 审批/中止命令无 keybindings；`@资产` 用 `window.prompt()`（Composer.vue 第 68 行）——原生阻塞弹窗、无文件选择器、无历史。
13. 状态栏只显示待审批数（activate.ts），不显示「未配置模型」这一最关键状态。

**认知负担**
14. 首次问答前用户需理解：provider / baseUrl / 模型 id / thinking / thinkingLevel / thinkingFormat / compat / SecretStorage / models.json / auth.json 十个概念；Cline 只需「选 provider → 贴 key」两步。
15. 同一「模型配置」存在双实现：设置页 Vue 版与 `modelsView.ts` 内嵌 HTML 版（后者 `showModelsPanel` 已无人调用，属死代码，但两份 UI 文案要同步维护）。

**中英文**
16. `<html lang="zh-CN">` 写死（`src/host/webviewHtml.ts` 第 39 行），hydrate 快照不带 `locale` 字段（`sessionStore.snapshot` / `hostController.snapshot`），因此 `setLocale(undefined)` 永远不切换——英文 VS Code 用户拿到中文界面，而设置面板标题却按 `vscode.env.language` 显示 "Settings"（settingsView.ts `panelTitle()`），首尾不一。
17. 组件内硬编码中文绕过 i18n：WelcomeState 的 RISK_LABEL、ApprovalBar 的 ELEMENT_LABELS 与 riskLabel、PlaybookHeader 的九阶段标签、ChatApp 的 aria-label「能力插件状态」、Composer 的「附件」。
18. host 侧所有 notice / 错误全是中文硬编码（hostController、runtime），英文用户不可读。

**审批打断**
19. 批准后无自动继续、无「等模型重试」的说明（见 4-A）。
20. 默认双确认（Agent 简报 + 插件弹窗）叠加 GuidedManual 时，一次写操作最多要确认三次；`dedupePluginModal` 埋在常规页且键名不可读。
21. ApprovalBar 展开简报后 9 行 dl 里空字段显示「—」，噪音大；commands 的 JSON.stringify 原文直出。

---

## 3. 与 Cline / Kilo / OpenCode 的 onboarding 差距

| 维度 | Cline | Kilo | OpenCode | at-opsAgent 现状 |
|------|-------|------|----------|------------------|
| 首跑引导 | welcome 视图内嵌 provider 向导：选 provider→贴 key→立即可聊 | 首启弹设置 UI + kilo.jsonc 双轨，BYOK 预设多家 provider | TUI 里 `/models` + provider 登录流程，配置即验证 | 无向导；欢迎页只有 playbook 卡，配置入口藏在齿轮/命令面板 |
| key 存储 | SecretStorage | 配置文件/密钥管理 | 本地 auth 存储 | SecretStorage（同级，优点） |
| key 验证 | 保存即校验，错误内联红字 | 保存时校验 | 登录流程内校验 | 无验证，失败延迟到聊天时 |
| 模型选择 | composer 常驻下拉，含搜索与能力徽标，空态可点去配置 | 设置 UI 下拉 + 预设 | composer 内模型选择器 | composer 有原生 select（160px 截断），空态 disabled 不可点 |
| provider 预设 | 十余家 + baseUrl 自动填 | 多家 BYOK | provider 注册表 | 仅手填 openai 兼容网关一种；OAuth 需手填 provider id |
| 错误恢复 | 错误卡片带「打开设置」按钮 | 设置内报错 | 命令行即时报错 | 纯文本 + 过期指引 |
| 历史持久 | 任务历史跨重启 | 有 | 会话文件 | 内存态，重启即失 |

结构性差距一句话：**三个对标产品都把「配置正确性」在配置界面内闭环；at-opsAgent 把验证推迟到聊天运行时，且两处之间没有任何回指链接。**

---

## 4. 整改建议（P0 / P1 / P2）

### P0（不修则首跑必挂）

**P0-1 修复 session/switch 字段不一致（真 bug）**
- 痛点：历史抽屉点击切换无任何反应。
- 目标交互：点击历史条目 → 立即载入该会话 transcript；失败时 toast。
- 改动：`src/webview-chat/store.ts`（`{ sessionId }` → `{ id }`）；或 `src/host/hostController.ts` 兼容两键；同步 `src/webview-chat/mock-host.ts`；补 `test/` 协议一致性用例。

**P0-2 欢迎页「模型未配置」分支 + Composer 拦截提示**
- 痛点：新用户不知道要先配模型，发消息才失败。
- 目标交互：`modelOptions.length===0 || !hasApiKey` 时，欢迎页顶部渲染一张主 CTA 卡「① 配置模型与 API Key（约 1 分钟）→ 按钮：打开模型设置」，playbook 卡降为次要；composer placeholder 换成「先完成模型配置即可开始问答」，发送时弹内联提示而非静默失败。
- 改动：`src/webview-chat/store-helpers.ts`（吸收 `hasApiKey`）、`store.ts`、`WelcomeState.vue`、`Composer.vue`；host 无需改（`chatModelsExtra` 已下发）；新增上行 `settings/open` 或复用 `command:atOpsAgent.openModels` 深链（chatView 已 `enableCommandUris`）。

**P0-3 保存即验证（「保存并测试」）**
- 痛点：设置页「已保存」与真实可用完全脱钩；缺 key 也提示成功。
- 目标交互：保存按钮变「保存并测试」；host 用当前配置发一次最小请求（1 token 或 models 列表探测），成功显示「✓ 连接成功，可以开始问答」，失败内联显示分类后的原因（缺 key / 401 / 网络 / 模型不存在）+ 不清除表单；`hasKey=false` 且 key 输入为空时保存前黄字警告「尚未填写 API Key，问答将失败」。
- 改动：`src/webview-settings/components/ModelsTab.vue`、`webview-settings/store.ts`、`helpers.ts`（新 req `models/test`）；`src/host/hostController.ts` 路由；`src/runtime/index.ts` 暴露一个 `probeModel()`。

**P0-4 错误消息可行动化 + 清除过期文案**
- 痛点：失败文案指向不存在的「能力插件树」、暴露 `src/runtime`，且无任何按钮。
- 目标交互：runtime 失败以专用 `notice` transcript 卡片呈现（区别于 assistant 气泡）：一句人话原因 + 按钮「打开模型设置」/「运行诊断」/「重试」；文案改为「还没有可用的模型。点击下方按钮完成配置（约 1 分钟）」。
- 改动：`src/runtime/index.ts`（FALLBACK_NOTICE、prompt catch 处发结构化事件）、`src/host/fallback/fallbackRuntime.ts`、`src/host/hostController.ts`（`emitAssistantNotice` → `emitActionNotice`）、`src/protocol/host-protocol.ts`（TranscriptItem 增 `notice` kind）、`ChatTranscript.vue` + 新组件。

### P1（完成首跑后最先撞到的墙）

**P1-1 Provider 预设下拉**
- 痛点：手填 baseUrl / 模型 id 门槛高、易拼错。
- 目标交互：Models 页第一项是「Provider」下拉：内部网关（预填模板 URL）/ OpenAI / Anthropic(OAuth) / DeepSeek / Qwen / 自定义；选择后自动填 baseUrl、api、compat.thinkingFormat，模型 id 提供常见值 datalist。
- 改动：`ModelsTab.vue`、`webview-settings/helpers.ts`（预设表）、`src/host/modelsView.ts`（saveModelsForm 支持指定 providerId 而非恒取第一个）。

**P1-2 批准后的可见继续**
- 痛点：点「批准」后界面静止，用户不知道要再发话。
- 目标交互：批准后 host 自动向模型回灌一条系统性提示「审批已通过（简报 b-xxx），请继续执行原命令集」（复用 `deliverToMain` 思路，不代模型执行工具，红线不破）；transcript 里出现「✓ 已批准，Agent 正在继续…」状态行。
- 改动：`src/host/hostController.ts` `applyApproval`（approved 分支触发 `runtime.prompt(…, {mode:'followUp'})`）、`ApprovalBar.vue`（批准后本地状态行）。

**P1-3 会话持久化**
- 痛点：重启丢历史，与 Cline 差距最直观。
- 目标交互：历史抽屉跨重启保留最近 N 条会话（标题取首条用户消息前 30 字），点击恢复 transcript。
- 改动：`src/host/sessionStore.ts`（落盘/回载 `~/.at-series/agent/sessions/index.json` + 每会话 jsonl）、`activate.ts`（启动回载）、`hostController.ts`。

**P1-4 i18n 闭环**
- 痛点：英文用户拿到中文 UI；组件内硬编码中文绕过 i18n。
- 目标交互：hydrate 携带 `locale: vscode.env.language`；webviewHtml 按语言注入 lang；把 RISK_LABEL、ELEMENT_LABELS、阶段标签、aria-label、host 侧 notice 全部进 i18n 表。
- 改动：`hostController.snapshot`、`webviewHtml.ts`、`WelcomeState.vue`、`ApprovalBar.vue`、`PlaybookHeader.vue`、`ChatApp.vue`、`Composer.vue`、两份 `i18n.ts`。

**P1-5 模型下拉空态可点 + 常驻可读**
- 痛点：disabled option 不可点、160px 截断。
- 目标交互：空态时整个选择器渲染成按钮「＋ 配置模型」直接打开设置 Models 页；有模型时显示「模型名 · provider」并加宽/悬浮提示。
- 改动：`ModelSelector.vue`、`webview-chat/store.ts`（新 action）、host 路由或 command 深链。

### P2（体验打磨）

- **P2-1** `contributes.walkthroughs` 三步引导（配模型→装能力插件→跑第一条 playbook）；`package.json` + `package.nls*.json`。
- **P2-2** `@资产` 从 `window.prompt` 换成 host 侧 QuickPick/文件选择（`Composer.vue`、`hostController` 新 req `asset/pick`）。
- **P2-3** 审批/停止 keybindings（`contributes.keybindings`），ApprovalBar 显示快捷键提示。
- **P2-4** 全部 `atOpsAgent.*` 配置键补 `description` + nls；`abort` 标题栏按钮加 `when` 上下文只在运行中显示（需 context key）。
- **P2-5** OAuth 页 provider 改为下拉（从 pi `getRegisteredProviderIds()` 取），`ModelsTab.vue` + `hostController.loginOAuth`。
- **P2-6** 移除 `src/host/modelsView.ts` 里已无人调用的 `showModelsPanel` 内嵌 HTML（保留 saveModelsForm 等纯函数），消除双份文案。
- **P2-7** 状态栏在未配置模型时显示 `$(warning) AT Ops 未配置`，点击直达 Models 页（`activate.ts`）。
- **P2-8** ToolCallCard 错误码映射人话短语（`OPS_APPROVAL_REQUIRED`→「等待审批」等，映射表放 `webview-chat/i18n.ts`，错误原文折叠保留）。

---

## 5. 推荐的「首次 2 分钟能问答」向导（步骤文案级）

触发条件：`modelOptions.length === 0 || !hasApiKey`（hydrate 已含两字段）。渲染于欢迎页顶部（不做全屏遮罩，保留 playbook 卡在下方降饱和显示）。

**第 0 步 · 欢迎卡（chat 空态内）**
> **欢迎使用 AT Ops Agent**
> 完成一次模型配置（约 1 分钟），就可以开始排障问答。
> 〔开始配置〕　〔我先看看 →（进入只读浏览，composer 显示提示条）〕

**第 1 步 · 选择 Provider（设置页 Models，或内嵌在 chat 卡片中）**
> **第 1 步 / 共 3 步：连接哪个模型服务？**
> ◉ 公司内部网关（OpenAI 兼容）——已为你预填地址模板
> ○ OpenAI　○ Anthropic（支持浏览器登录，无需手输 key）　○ 通义 / DeepSeek　○ 自定义
> 提示：不确定选哪个？问一下你的平台组，通常是「内部网关」。

**第 2 步 · 填 Key 与模型**
> **第 2 步：粘贴 API Key**
> 〔●●●●●●●●〕
> 🔒 Key 只保存在 VS Code 安全存储（SecretStorage），不会写入任何文件或日志。
> **模型**：〔qwen3-max ▾〕（按 provider 给出常见项，可手输）
> 〔验证并保存〕
> - 成功：「✓ 连接成功（qwen3-max · 首 token 0.8s）」→ 自动进第 3 步
> - 失败：「✗ 服务返回 401：Key 无效或已过期。请检查后重试。〔重试〕〔查看详细错误〕」（错误原文折叠）

**第 3 步 · 试一问（回到 chat，composer 预填）**
> **第 3 步：试试第一条消息**
> composer 预填：「介绍一下你能做什么，我的环境里有哪些可用的能力插件？」
> 副文案：装好 AT Terminal / Grafana 等插件后无需任何 MCP 配置，Agent 会自动接入 →〔查看能力插件〕
> 回答成功后向导卡收起，欢迎页恢复 playbook 建议卡，并 toast：「配置完成 🎉 随时点 ⚙ 调整模型」。

设计要点：每一步都有「跳过 / 打开 models.json（高级）」逃生口；向导状态存 `agentDir/settings.json`（如 `onboarded: true`），不新增 VS Code 全局键；全部文案进 i18n 双语表。

---

## 6. 设置页信息架构（IA）：哪些留在设置、哪些进 chat chrome

**必须留在设置页（低频、危险、需要完整表单）**
- Models：provider 预设、Base URL、API Key（SecretStorage）、OAuth、compat/thinkingFormat、models.json / auth.json 高级入口 —— 现有 `ModelsTab.vue` 承载，补验证与预设。
- 第三方 MCP：mcp.json 脱敏编辑（`McpTab.vue`，现状合理）。
- 常规：discovery、autoEnableNew、dedupePluginModal、workspaceShell、subagent 并行、streaming 合批（`GeneralTab.vue`）——但每项标签去键名化。
- 能力插件详情与诊断（`CapabilitiesTab.vue` + diagnose，现状合理）。

**应在 chat chrome（高频、会话内即时决策）**
- 模型切换：composer 内选择器（已有，需空态可点、加宽）；thinkingLevel 建议一并挪进该下拉的二级项，而不是只在设置页。
- 会话：历史抽屉（已有，修 P0-1）+ 新会话按钮；设置页 Sessions 页签在修好 chat 侧后可降级甚至移除（双入口反而分散）。
- Playbook 选择、审批、GuidedManual、中止：已在 chat 内，维持。
- 能力插件健康：composer 上方点簇（已有）+ 点击应跳设置 Capabilities 页（补深链）。
- 「未配置模型」CTA、连接失败重试：必须出现在 chat 内（P0-2/P0-4），不能只活在设置页。

**判据**：会话中 10 秒内要用到的（模型、审批、中止、playbook、会话切换）进 chrome；改一次管一个月的（key、URL、MCP、策略开关）进设置页；两边通过按钮/深链互指，任何错误提示必须携带通往修复界面的入口。

---

### 附：本次走查确认的正面设计（建议保留）
- 单 Chat 视图 + 设置 Webview 的 Cline 式收敛（activate.ts）。
- SecretStorage + 占位符 + 永不回显的 key 生命周期（secrets.ts / modelsView.ts）。
- 审批 9 要素简报、双确认提示、GuidedManual「去 IDE 操作/我已完成」三态（ApprovalBar.vue）。
- mcp.json 脱敏往返（`***` 回填，hostController.saveMcp）。
- 大输出走 artifact URI 不撑爆 webview（ToolCallCard / openArtifact）。
- 流式中 Steer / 结束后追问的 composer 三态（Composer.vue + store-helpers.buildPromptPayload）。
