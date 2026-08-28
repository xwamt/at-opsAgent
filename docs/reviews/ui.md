# at-opsAgent 前端 UI 美学评审与重设计方案

评审对象：`/workspace`（VS Code 运维 Agent 扩展，Vue 3.5 + Pinia，三个 webview：chat 侧边栏 / settings 编辑器页 / board 编辑器页）。
参照系：Cline（React 侧边栏聊天、composer、工具卡）、Kilo Code（SolidJS webview、Agent Manager 编辑器页、状态条）、OpenCode GUI 系（模型选择器、会话切换、context usage bar）。
评审方式：静态阅读 Vue/CSS/TS 结构（无法跑浏览器），逐文件核对。

---

## 1. 视觉现状

### 1.1 布局与信息架构（现状）

- Activity Bar 已收敛为**单一 Chat webview**（`package.json` `contributes.views` 只注册 `atOpsAgent.chat`；`src/host/activate.ts` 头注释明确「Cline 式单视图，TreeView 全部下线」）。这是正确且领先的决策，`src/host/trees/*` 五个 TreeView 文件已成死代码，建议删除以免误导。
- Settings 是编辑器区 `WebviewPanel` 单例（`src/host/settingsView.ts`），Board 也是按需打开的编辑器页（`src/host/boardView.ts`）。信息架构骨架与 Cline/Kilo 的最终形态一致。
- Chat 视图纵向结构（`src/webview-chat/components/ChatApp.vue`）：`PlaybookHeader` → 空态 `WelcomeState` / `ChatTranscript`（顶部钉一条 `tstrip` 事件脉络）→ dock 区（`PlaybookPicker` 浮层 + 健康点簇 + `ApprovalBar` + `Composer`）→ `HistoryOverlay` 侧滑。骨架合理，与 Cline 的 Header/MessagesArea/footer(AutoApproveBar+ActionButtons+InputSection) 同构。

### 1.2 密度与间距

- 间距基数 `--ops-density: 6px`（`src/webview-chat/ops-tokens.css` L13），但全库通过 `calc(var(--ops-density) * 1.5)`、`* 2`、`* 2.5`、`+ 2px`、`- 1px`、`- 2px` 等**十几种即兴算式**派生间距（如 `Composer.vue` L182、`ToolCallCard.vue` L89、`ApprovalBar.vue` L167）。`6 * 1.5 = 9px`、`6 * 2.5 = 15px` 这类奇数值会造成对不齐的视觉噪声，且无法整体调密度。
- `docs/05-ui-system.md` §2 写的是 `--ops-density: 4px`，代码是 6px——**文档与实现已经漂移**。
- transcript 主体 `padding: 12px; gap: 12px`（`ChatTranscript.vue` L245-248）为硬编码，未走 token。

### 1.3 字体

- 正文 `var(--vscode-font-size, 13px)`，等宽走 `--ops-mono`（编辑器字体），方向正确。
- 但小字号全部用 `calc(var(--ops-font-size) - 1px/-2px/-3px)` 就地派生（全库 40+ 处），实际形成 13/12/11/10 四级字阶却**没有命名 token**；10px（-3px，见 `HistoryOverlay.vue` L223、`EvidenceNote.vue` L217、`IncidentTimeline.vue` L132）在 1x 屏上已低于可读底线，Cline/Kilo 最小只到 11px。

### 1.4 色板与 VS Code CSS variables

- `ops-tokens.css` 的映射层是全库最好的部分：背景/前景/边框/输入/按钮/hover/链接全部映射 `--vscode-*`，语义三色（healthy/warn/crit）映射 `testing-icon*` 与 `editorWarning`，风险三色复用语义色，用户消息底色三级回退（`inactiveSelectionBackground → textBlockQuote → 灰`）。跟随主题的能力是真实的。
- 漏网之鱼（硬编码颜色，浅色主题下会露馅）：
  - `HistoryOverlay.vue` L96 背板 `rgba(0,0,0,0.3)`、L108 阴影 `rgba(0,0,0,0.35)`；
  - `PlaybookPicker.vue` L71 阴影 `rgba(0,0,0,0.35)`（应使用 `--vscode-widget-shadow`）；
  - `media/icons/ops-agent.svg` / `ops-board.svg` 硬编码 `#C5C5C5` 描边；
  - `LogViewer.vue` L103 兜底 `#1e1e1e`（有 `--vscode-editor-background` 前置，问题不大）。

### 1.5 图标体系（最大的「不专业感」来源之一）

全库**没有引入 codicon**（`rg codicon` 零命中），所有图标是 emoji / Unicode 字形拼贴：

- `ToolCallCard.vue` L50 `🔧`；`EvidenceNote.vue` L101 `📌`；`SubagentBoard.vue` L21-26 `🔍 🛠 ✍ ☑ 🤖`；`ApprovalBar.vue` L124 `⚠`；`PipelineStatus.vue` L41 `⛓`；`ModelSelector.vue` L58 `⬡`；`Composer.vue` L160 `⏹`；`PlaybookHeader.vue` L84/L93 `↺ ▤`；状态字形 `● ○ △ ✓ ✗ ⊘ ⏸ ⌁ ▸ ▾ ▍ ✕ ＋`。

emoji 是彩色位图、跨平台（Windows Segoe / macOS Apple Color Emoji / Linux Noto）形状差异巨大、和单色主题化的 VS Code UI 格格不入；`⛓ ⌁ ✍` 等字形在部分字体缺字。Cline/Kilo/OpenCode 系全部使用 `@vscode/codicons`。这是「看起来像原型不像产品」的第一原因。

### 1.6 组件完成度

功能完成度相当高：虚拟化 transcript（>80 条启用，`ChatTranscript.vue` L32-62）、流式光标、工具卡（风险左边条 + 状态 + 耗时 + 截断 + 错误码）、审批栏（九要素 + 双确认 + GuidedManual 三态）、子代理面板（配额/中止/详情展开）、证据便签（metric 火花图 / pipeline / log / host chip 四种 ref 分发）、日志查看器（行号 + ERROR/WARN 着色 + 64KB/500 行上限 + 编辑器打开）、历史侧滑、Playbook picker、设置五页签、看板时间线。无障碍纪律好（aria 全覆盖、状态「颜色+图标+文字」双通道、focus-visible 一致）。

**但有一个决定性缺口：Markdown 渲染不存在。** `ChatTranscript.vue` L154-156 用 `{{ item.text }}` + `white-space: pre-wrap` 渲染 assistant 文本；`markdown-it` 在 `package.json` L214 是已声明依赖、`docs/05-ui-system.md` §4 白纸黑字规定「markdown-it + 消毒；mermaid 动态 import」，实现里 `rg markdown-it` **零命中**。LLM 输出必然带标题/列表/代码围栏/表格，现在会以裸源码文本呈现——这是与 Cline/OpenCode 观感差距的最大单点。同理，代码高亮（shiki/hljs）完全没有。

### 1.7 国际化的一致性（观感即专业度）

`src/webview-chat/i18n.ts` 做了 zh/en 双语，但大量文案**绕过 i18n 硬编码中文**：

- `WelcomeState.vue` L9-13、`ToolCallCard.vue` L10-22（RISK_LABEL/STATUS_META「只读/写/执行/运行中/成功/失败…」）、`PlaybookPicker.vue` L10-14、`ApprovalBar.vue` L49-59（九要素标签）与 L109-118（riskLabel）、`SubagentBoard.vue` L28-41 与 L62-64（「子代理/排队/中止…」）、`PlaybookHeader.vue` L12-22（九阶段中文）与 L90「选择 Playbook」、`ChatTranscript.vue` L144/L175（aria「会话记录」「审批请求」）、`LogViewer.vue` L69「（无输出）」、`ChatApp.vue` L26/L33/L41（「能力插件状态/已连接/未连接/mock 提示」）、`webviewHtml.ts` L39/L57（`lang="zh-CN"` + 「AT Ops Agent 加载中…」对所有语言用户显示）。

英文环境下 UI 是中英混排的，这在 Marketplace 截图里非常掉价。

---

## 2. 与 Cline / Kilo / OpenCode 的 UI 差距

### 2.1 侧边栏信息架构

| 维度 | Cline | Kilo Code | OpenCode GUI 系 | at-opsAgent 现状 |
|---|---|---|---|---|
| 侧边栏 | 单 ChatView 常驻，Settings/History/MCP 为同 webview 内切换的全页视图 | 侧边栏 chat + Agent Manager 独立编辑器 tab | 侧边栏 chat，header 有会话切换 + 当前模型徽标 | 单 chat ✓；History 为覆盖层 ✓；Settings 独立编辑器页 ✓ |
| 任务头部 | TaskSection：当前任务 + token/context/cost 折叠头 | 状态条（会话/worktree 状态） | header 模型徽标 + context usage | `PlaybookHeader`：身份 chip + 两个文字按钮，**无 token/context/成本信息** |
| 顶部按钮 | view/title 原生按钮（＋、历史、设置） | 同 | 同 | **双重实现**：`package.json` menus 已有 5 个 view/title 按钮，`PlaybookHeader.vue` 又渲染「↺ 历史」「▤ Playbook」两个 webview 内按钮，功能重复、占据 300px 宽度里约 140px |

差距结论:骨架相同，但缺「运行状态可见性」层（token 用量、context window、API 耗时），且头部冗余。

### 2.2 Composer

- Cline `ChatTextArea`：@ 文件/图片附件走 IDE 原生选择器、slash 命令菜单、图标按钮、发送为 codicon 图标钮。OpenCode 系 composer 内含 TokenUsageBar、模型/Agent 双下拉。
- 本项目 `Composer.vue`：输入井 + 井内工具条布局是对的（注释也自述「Continue/Cline 布局」），但：
  - **@资产用 `window.prompt()` 弹系统对话框**（L67-75）——这是 demo 级交互，Cline 从未这样做；应走 host 侧 `vscode.window.showQuickPick`/文件选择器回填 chip。
  - 「@」「/playbook」是纯文字小按钮（L134-150），弱且不可发现；发送/停止是文字按钮，`⏹` emoji。
  - 无 context usage / token 计数（OpenCode 系标配 TokenUsageBar，Cline 在任务头显示）。
  - 附件 chip 用 accent 色边框（L196-201），比内容还抢眼。

### 2.3 消息气泡

- 方向正确：用户消息右对齐浅底「井」、Agent 全宽无气泡（Copilot/Cline 式），角色标签在上（`ChatTranscript.vue` L255-288）。
- 差距：每条消息都渲染「你/Agent」标签，Cline 对连续同角色消息不重复标注；Agent 文本无 markdown（见 1.6）；无消息级操作（复制/引用/重发——Cline 有 quote/copy，OpenCode 有编辑与 checkpoint 恢复）；无「滚到底部」悬浮按钮（Cline `useScrollBehavior` 标配，本项目虚拟化列表 + 用户上翻后没有回底捷径）。

### 2.4 工具调用卡片

- Cline：工具按类型分发到专用行（CodeAccordian/CommandOutputRow/McpResponseDisplay），**默认折叠**、点击展开，低风险工具聚合分组（`groupLowStakesTools`）降噪。
- 本项目 `ToolCallCard.vue`：单一通用卡，preview `<pre>` **始终展开**（最高 180px），连续多次工具调用时 transcript 会被 4KB 预览块刷屏；🔧 emoji 头；风险左边条 3px 是好的语义设计，保留。
- `SubagentBoard.vue` 是差异化亮点（Cline 无此概念，Kilo Agent Manager 是编辑器页级别的对应物），但卡片 meta 行直接暴露内部 `taskId`（L96），用户无法消费。

### 2.5 设置页

- Cline SettingsView：分区 tab + sticky 导航，控件用 vscode-webview-ui-toolkit 风格；Kilo 新版设置约 820 行、五个子 tab；OpenCode 系有 provider 卡片和 capability 徽标。
- 本项目 `SettingsApp.vue`：左侧 132px 竖排导航 + 内容区，<420px 折横排——结构可以。问题：
  - 在**编辑器区**渲染却整体使用 `--vscode-sideBar-background`（L179-192；`ops-tokens.css` 的 body 背景同样是 sideBar），和周围编辑器 tab 背景色不一致，一眼「贴出来的网页」。Kilo Agent Manager 用编辑器背景。
  - 全局样式块（L49-171）字号/圆角/间距全部硬编码 px（12px/11px/6px/3px…），未复用 token 体系。
  - `.set-title` 同时用于 h2 页标题和 h3 卡片标题（`ModelsTab.vue` L21/L29），层级无差别。
  - `ModelsTab.vue` 本质是**单 provider 表单**（baseUrl/modelId/apiKey），没有「模型列表」管理界面；对照 OpenCode 系「provider 下拉 + 模型能力徽标（Reasoning/Attachments/Context size）」差一代。分区标题「API Key / Compat / OAuth」是实现视角的行话。
  - `McpTab.vue` 用一个 14 行裸 JSON textarea 做主 UX；Cline 的 MCP 页是服务器卡片 + 状态灯 + marketplace。
  - `SessionsTab.vue` 与 chat 的 `HistoryOverlay.vue` 是两套重复的会话列表 UI。

### 2.6 空状态

- Cline WelcomeSection：品牌区 + 公告 + Quick Wins 建议卡 + 最近任务列表。
- 本项目 `WelcomeState.vue`：标题 + 副标题 + 最多 6 张 playbook 建议卡。结构对，但：无品牌/图标锚点；每张卡带风险徽标（「只读/写/执行」）——空态用户还没建立风险语义，徽标是噪声；无「最近会话」回流入口（Cline 空态最重要的复访路径）；`buildWelcomeSuggestions` 只取 6 条而无「查看全部」。
- Capabilities 空态（`CapabilitiesTab.vue` L22）只有一句话；`docs/05-ui-system.md` §5 曾要求的引导文案（「安装 AT Terminal / Grafana 后自动出现」）没有落实为带操作的空态。

---

## 3. 不美观 / 不专业的具体组件清单

| # | 文件 | 问题 |
|---|---|---|
| 1 | `src/webview-chat/components/Composer.vue` | `window.prompt` 添加附件（L68）；「@」「/playbook」文字微钮辨识度低；`⏹` emoji；无 token/context 指示 |
| 2 | `src/webview-chat/components/ModelSelector.vue` | 原生 `<select>` + `⬡` 字形，`max-width:160px` 截断模型名；option 内「label · provider」纯文本拼接；无能力信息、无搜索 |
| 3 | `src/webview-chat/components/ToolCallCard.vue` | 🔧 emoji；preview 永远展开刷屏；RISK_LABEL/STATUS_META 硬编码中文 |
| 4 | `src/webview-chat/components/PlaybookHeader.vue` | 与 view/title 原生按钮功能重复的「↺ 历史」「▤ Playbook」双按钮挤占宽度；九阶段 chips 展开后 300px 宽度下折 3 行；阶段名硬编码中文 |
| 5 | `src/webview-chat/components/ChatTranscript.vue` | assistant 文本无 markdown/高亮（L154）；tstrip 描边 chips 可无限 wrap 抢占首屏（L194-221）；「⚠ 审批请求…」行硬编码；无回底按钮 |
| 6 | `src/webview-chat/components/ApprovalBar.vue` | 头行 8+ 个元素单行 flex 不换行（L191-196），侧边栏 300-360px 宽下按钮溢出/挤压；GuidedManual 变体一行 4 个按钮；riskLabel「执行 exec」中英混写 |
| 7 | `src/webview-chat/components/HistoryOverlay.vue` | 背板/阴影硬编码 rgba；裸 `session.id.slice(0,12)` 展示内部 id |
| 8 | `src/webview-chat/components/SubagentBoard.vue` | 🔍🛠✍🤖 emoji 角色图标；meta 行暴露原始 taskId；「中止」danger 描边钮常显较重 |
| 9 | `src/webview-chat/components/EvidenceNote.vue` | 📌 emoji；底部 meta 暴露 taskId（L139）；未识别 ref 的 kind 徽标 + 灰色 mono 预览观感杂 |
| 10 | `src/webview-chat/components/ChatApp.vue` | composer 上方健康点簇用文本 `●/○`；「mock」徽标虚线框样式游离；title 提示硬编码中文 |
| 11 | `src/webview-chat/ops-tokens.css` | `ops-badge` 一律 `border:1px solid currentColor`——全 UI 描边徽标过多，形成「线框稿」观感；字阶用 calc 派生无 token |
| 12 | `src/webview-settings/components/SettingsApp.vue` | 编辑器页用 sideBar 背景；样式硬编码 px；h2/h3 同级化；132px 导航列在宽编辑器里空间利用差 |
| 13 | `src/webview-settings/components/ModelsTab.vue` | 单 provider 表单冒充「模型」页；「API Key / Compat / OAuth」实现视角命名；keyState 字符串拼接（L12-16） |
| 14 | `src/webview-settings/components/McpTab.vue` | 裸 JSON textarea 为主 UX，无服务器卡片/状态 |
| 15 | `src/webview-settings/components/SessionsTab.vue` | 与 HistoryOverlay 重复的第二套会话 UI |
| 16 | `src/webview-board/components/IncidentTimeline.vue` / `BoardApp.vue` | 纯列表无过滤/分组/搜索；`fmtTime` 全量 `YYYY-MM-DD HH:mm:ss` 吃宽度；severity 用 `○△✗` 字形；头部仅「N 条」 |
| 17 | `src/host/webviewHtml.ts` | `<html lang="zh-CN">` 硬编码；boot 文案只有中文；英文用户首帧闪中文 |
| 18 | `media/icons/ops-agent.svg`、`ops-board.svg` | 硬编码 `#C5C5C5`，未用 `currentColor`；线条造型泛用（列表+圆圈），品牌辨识度低 |
| 19 | `src/webview-chat/components/LogViewer.vue` | 行级 regex 着色简陋（整行染红/黄）；「已截断」徽标又是一层描边框 |
| 20 | `src/host/trees/*.ts` | 已被信息架构收敛淘汰的 5 个 TreeView 死代码，仍留在仓库 |

---

## 4. 整改建议（P0 / P1 / P2）

### P0（不做就始终是「原型观感」）

**P0-1 Markdown 渲染 + 代码高亮**
- 问题：assistant 文本裸渲染（`ChatTranscript.vue` L152-157），markdown-it 依赖闲置，违反自家 `docs/05-ui-system.md` §4。
- 视觉目标：标题/列表/表格/围栏代码正常排版；代码块等宽深底 + 复制按钮；链接走 `--vscode-textLink-foreground`。
- 改动：新建 `src/webview-chat/components/MarkdownBlock.vue`（markdown-it + 白名单消毒，禁 raw html）；`ChatTranscript.vue` assistant 分支替换；样式进 `ops-tokens.css`（`.ops-md` 命名空间）。高亮可先用 markdown-it 默认 + `--vscode-textCodeBlock-background`，二期接 shiki。
- 参考：Cline `MarkdownRow`；OpenCode-in-VSCode `MarkdownRenderer`（markdown + Shiki）。

**P0-2 图标系统切换 codicon**
- 问题：全库 emoji/字形图标（见 1.5 清单）。
- 视觉目标：单色、主题跟随、与 VS Code 原生 UI 同族。
- 改动：打包 `@vscode/codicons`（css+ttf 放 `media/`，`webviewHtml.ts` 注入 `<link>`，CSP `font-src` 已放行 `cspSource`）；替换 `ToolCallCard.vue`（`$(tools)`）、`EvidenceNote.vue`（`$(pin)`）、`SubagentBoard.vue`（`$(search)/$(tools)/$(edit)/$(check)`）、`ApprovalBar.vue`（`$(warning)`）、`PipelineStatus.vue`（`$(link)`）、`ModelSelector.vue`（`$(chip)` 或 `$(sparkle)`）、`Composer.vue`（`$(mention)/$(send)/$(debug-stop)`）、`PlaybookHeader.vue`（`$(history)/$(list-tree)/$(chevron-*)`）、状态字形（`$(check)/$(error)/$(circle-slash)/$(loading~spin)`）。
- 参考：Cline / Kilo / OpenCode 系全员 codicon。

**P0-3 消灭中英混排**
- 问题：见 1.7 文件清单；en 环境 UI 半中文。
- 视觉目标：语言纯净；aria 同步 i18n。
- 改动：`webview-chat/i18n.ts` 增补键（风险/状态/阶段/九要素标签），改 `WelcomeState.vue`、`ToolCallCard.vue`、`PlaybookPicker.vue`、`ApprovalBar.vue`、`SubagentBoard.vue`、`PlaybookHeader.vue`、`ChatTranscript.vue`、`LogViewer.vue`、`ChatApp.vue`；`webviewHtml.ts` 按 `vscode.env.language` 注入 lang 与 boot 文案。
- 参考：Cline 的 locale 包纪律。

**P0-4 Composer 附件交互去 `window.prompt`**
- 问题：`Composer.vue` L67-75 系统 prompt 对话框。
- 视觉目标：点「@」→ host QuickPick（主机/文件/最近资产分组）→ 回填 chip；chip 用中性边框（`--ops-border`）+ 小号 codicon 关闭钮。
- 改动：`Composer.vue`、`store.ts`（新增 `asset/pick` req）、`hostController.ts` 接 `showQuickPick`。
- 参考：Cline `ChatTextArea` @mention；OpenCode 系 file context attachment。

**P0-5 ApprovalBar 窄宽自适应**
- 问题：单行 8 元素 flex（L191-196）在侧边栏必然溢出；审批是本产品最高危路径，不能靠省略号。
- 视觉目标：两段式——第一行「⚠ 待审批 + 风险徽标 + 目标」，第二行右对齐动作按钮组（批准为 primary，拒绝为 danger 次级），GuidedManual 变体按钮同排折行；`max-height` 内滚动保留。
- 改动：`ApprovalBar.vue` 模板结构 + `flex-wrap`/grid。
- 参考：Cline `ActionButtons`（footer 独立整行按钮区）。

### P1（拉平与三家的体验差距）

**P1-1 ToolCallCard 默认折叠 + 连续调用聚合**
- 问题：preview 永远展开（`ToolCallCard.vue` L69-74），多工具刷屏。
- 视觉目标：单行摘要头（图标+名+风险+状态+耗时+chevron），点击展开 preview/错误；连续 ≥3 个只读工具折叠成「N 个只读调用」组头。
- 改动：`ToolCallCard.vue` 加 expanded 态；`store-helpers.ts` 加分组 getter。
- 参考：Cline `CodeAccordian` + `groupLowStakesTools`；OpenCode GUI「Tool call collapsible display」。

**P1-2 头部去重与瘦身**
- 问题：`PlaybookHeader.vue` 与 `package.json` view/title 菜单双份「历史/Playbook」。
- 视觉目标：webview 内头部只留 Playbook 身份 chip（无 playbook 时隐藏整行），历史/新会话/设置交给原生标题栏按钮；阶段 chips 改为「当前阶段 + 进度 n/9」单 chip，点开浮层看全部。
- 改动：`PlaybookHeader.vue` 删两按钮；阶段浮层复用 `PlaybookPicker.vue` 的浮层样式。
- 参考：Cline 顶栏全走 view/title；Kilo 状态条单行。

**P1-3 ModelSelector 升级**
- 问题：原生 select，无信息密度。
- 视觉目标：composer 内下拉徽标（模型名 + provider 小字），点开自绘浮层：按 provider 分组、可过滤、尾部「管理模型…」跳设置 models tab（`settings/tab` 通道已具备）。
- 改动：`ModelSelector.vue` 重写为浮层组件（复用 `PlaybookPicker` 的定位/外点关闭逻辑）。
- 参考：OpenCode 系 ModelSelector（capability badges）；Cline 模型下拉。

**P1-4 Context / token 状态条**
- 问题：运行成本与上下文完全不可见。
- 视觉目标：composer 井内工具条右侧一枚细progress（context 占用 %）+ hover 详情；运行中显示已用时。
- 改动：协议加 `usage` evt（`hostController` → `store.ts`），`Composer.vue` 渲染。
- 参考：OpenCode 系 `TokenUsageBar`；Cline TaskHeader tokens/cost。

**P1-5 设置页视觉体系**
- 问题：sideBar 背景 + 硬编码 px + 标题无层级（见 2.5）。
- 视觉目标：编辑器背景（`--vscode-editor-background`）；内容列 max-width 680px 居中；h2 页标题 15px/600、h3 分区 13px/600 上边距拉开；去卡片描边、改为分区 + `--vscode-widget-border` 细分隔线；控件对齐 VS Code 设置页（label 上、desc 下、宽度 320px 上限）。
- 改动：`SettingsApp.vue` 全局样式块、各 Tab 微调；`ops-tokens.css` 输出 spacing/type token 供其引用。
- 参考：Cline SettingsView、VS Code 原生设置编辑器。

**P1-6 tstrip 事件脉络收敛**
- 问题：描边 chips 多行 wrap 吃掉首屏（`ChatTranscript.vue` L194-221）。
- 视觉目标：单行横向滚动（`overflow-x:auto`）或只显示最近 3 条 + 「在看板查看」链接；chip 去边框改用色点 + 文字。
- 改动：`ChatTranscript.vue` tstrip 样式与模板。
- 参考：Kilo 状态条（单行、低噪）。

**P1-7 主题化补漏**
- 改动：`HistoryOverlay.vue`/`PlaybookPicker.vue` 阴影换 `--vscode-widget-shadow`，backdrop 用 `color-mix(in srgb, var(--vscode-widget-shadow) 30%, transparent)` 或半透明前景；`media/icons/*.svg` 改 `stroke="currentColor"`。

**P1-8 WelcomeState 精修**
- 改动：`WelcomeState.vue` 去每卡风险徽标（信息保留在 title tooltip）；顶部加产品 codicon 锚点；下方追加「最近会话」3 条（数据已有 `store.historySessions`）；副标题下加一行快捷键提示。
- 参考：Cline WelcomeSection（Quick Wins + 最近任务）。

### P2（差异化与打磨）

**P2-1 Board 升级为「Ops 版 Agent Manager」**
- 问题：`IncidentTimeline.vue` 是无过滤纯列表。
- 视觉目标：顶部工具条（severity 过滤 pills、incident 分组切换、搜索框）；时间列改相对时间 + hover 绝对时间；按日期 sticky 分组头；行 hover 显示「在会话中定位」。
- 改动：`BoardApp.vue`、`IncidentTimeline.vue`、`webview-board/store.ts` 加过滤态。
- 参考：Kilo Agent Manager（编辑器页 + sidebar 分区 + inspector 的信息组织）。

**P2-2 MCP 页卡片化**：`McpTab.vue` 解析后的 serverNames 渲染为卡片列表（名称/命令/状态/AT-hub 跳过标记），textarea 降级为「高级编辑」折叠区。参考 Cline McpConfigurationView。

**P2-3 会话 UI 合流**：`SessionsTab.vue` 与 `HistoryOverlay.vue` 抽公共 `SessionList` 组件，样式统一（标题 + 相对时间，id 移入 tooltip）。参考 OpenCode 系 session tree（Today/Yesterday 分组）。

**P2-4 徽标减负**：`ops-badge` 提供无边框「tint」变体（低饱和底色 + 语义前景，如 `color-mix` healthy 10%），描边只保留给风险/审批等强语义；改 `ops-tokens.css` 与各调用点。

**P2-5 LogViewer/Sparkline 打磨**：`LogViewer.vue` 只给关键词染色而非整行；`MetricSnippet.vue` 补 min/max 双值标签与 hover 十字线。

**P2-6 动效纪律**：补 `prefers-reduced-motion` 媒体查询（`HistoryOverlay` slide、caret blink）；工具卡 running 态用 codicon `loading~spin` 替代 `●`。

**P2-7 清理死代码**：删除 `src/host/trees/*`，`docs/05-ui-system.md` §1/§2/§5 更新为已收敛后的架构与 6px 基数，消除文档漂移。

---

## 5. 推荐信息架构

现状已非常接近理想形态，建议**确认并收紧**：

```text
Activity Bar
  └─ AT Ops Agent（仅一个图标）
       └─ Chat WebviewView（唯一常驻视图）
            ├─ 顶部：view/title 原生按钮（新会话 / 历史 / Playbook / 停止 / ⚙设置）→ 唯一入口，webview 内不再重复
            ├─ PlaybookHeader：仅在 playbook 激活时出现的一行身份 chip
            ├─ Transcript（markdown + 折叠工具卡 + 证据/子代理卡）
            └─ Composer（模型徽标 + @资产 + /playbook + context bar + 发送）

编辑器区（按需，均为单例 WebviewPanel）
  ├─ Settings（atOpsAgent.openSettings；⚙ 与 modelSelectorEmpty 引导都指向这里）
  │    页签：常规 / 模型 / 能力插件 / MCP / 会话（会话可并入历史，页签降为 4 个）
  └─ Ops 看板（atOpsAgent.openBoard）
       出现时机：
       ① 命令面板 / chat 内 tstrip「在看板查看」链接；
       ② pb.incident 进入 executing/verifying 阶段时 host 弹一次性提示（可关）；
       ③ 不自动抢占编辑器，永不作为常驻 Panel（boardView.ts 现注释的决策正确）
```

要点：Activity Bar 只保留 Chat（已达成，勿回退到 TreeView 群）；Settings 独立编辑器页（已达成，做 P1-5 视觉治理）；Board 是「事故升级时才出现」的工作台，参照 Kilo Agent Manager 的「侧边栏会话 → Continue in Worktree 升舱」心智：chat 是常态，board 是升舱。

---

## 6. 设计 token 建议

原则：**继续做 VS Code 主题的「转译层」，不做自定义皮肤**。`ops-tokens.css` 的映射基底保留，做三件事：

**① 补齐命名字阶与间距阶，禁止就地 calc：**

```css
:root {
  /* spacing：4 的倍数，替换所有 calc(var(--ops-density) * x) */
  --ops-space-1: 4px;
  --ops-space-2: 8px;
  --ops-space-3: 12px;
  --ops-space-4: 16px;

  /* type scale：替换所有 calc(var(--ops-font-size) - npx)，最小 11px */
  --ops-font-md: var(--vscode-font-size, 13px);
  --ops-font-sm: 12px;
  --ops-font-xs: 11px;

  /* radius：控件 2px（对齐 VS Code input/button），容器 4px，卡片 6px 封顶 */
  --ops-radius-ctl: 2px;
  --ops-radius: 4px;
  --ops-radius-lg: 6px;
}
```

**② 补充缺失的官方变量映射（替换硬编码）：**

- 阴影：`--ops-shadow: 0 2px 8px var(--vscode-widget-shadow)`（替 HistoryOverlay/PlaybookPicker 的 rgba）。
- 图标钮 hover：`--vscode-toolbar-hoverBackground`（Composer 工具条、关闭钮）。
- 计数徽标：`--vscode-badge-background/-foreground`（子代理数、看板事件数）。
- 图表色：sparkline 与 severity 可选 `--vscode-charts-blue/-red/-yellow/-green`，比复用 testing 色更正统。
- 编辑器页（settings/board）body 背景：`--vscode-editor-background`；侧边栏 chat 保持 `--vscode-sideBar-background`——一份 tokens 文件按容器加 `data-surface="sidebar|editor"` 切换，而不是三个入口共用 sideBar 背景（`webview-settings/main.ts` L50、`webview-board/main.ts` L3 现共用 chat 的 tokens）。

**③ 语义色纪律维持并写进 lint：**
风险三色（read/write/exec）与结论三态（confirmed/hypothesis/pending）是本产品相对 Cline/Kilo 的**领域差异化资产**，继续「只用于语义、不做装饰」（`ops-tokens.css` L102 注释的原则），新增任何颜色必须先有 `--vscode-*` 映射与暗/亮/高对比三主题验证；禁止新的 hex/rgba 字面量进组件（可加 stylelint declaration-property-value-disallowed-list）。

---

## 附：总体判断

这套 UI 的**工程底子和无障碍纪律好于多数同类**（token 映射、双通道状态、虚拟化、CSP、i18n 框架都在），信息架构决策（单视图 + 编辑器页设置/看板）已经是 Cline/Kilo 的终局形态。它「不美观」的根源不是布局，而是四件表层但致命的事：无 markdown、emoji 图标、中英混排、demo 级交互残留（window.prompt / 原生 select / 描边徽标泛滥）。P0 五项全部是低风险、组件内局部改造，完成后观感即可跨过「专业工具」门槛；P1 拉平与三家的功能可见性差距；P2 把 Board 打造成 Kilo Agent Manager 级的差异化卖点。
