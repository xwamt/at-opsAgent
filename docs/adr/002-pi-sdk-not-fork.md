# ADR-002 · 基于官方 pi SDK，不 fork Studio

## 状态

Accepted

## 背景

需求写「基于 piagent 项目」：侧边栏、自定义 LLM、自定义 MCP、skills、subagent。最匹配的 VS Code 封装是 JohnnyZ93/pi-agent-studio。底层是 Mario Zechner 的 pi coding agent。

关键事实（npm + 仓库交叉验证）：

- `@mariozechner/pi-coding-agent` 已于 2026-05 deprecated，官方改名为 `@earendil-works/*`（不是分叉）。
- 当前版本 lockstep `0.84.3`，MIT。
- pi 核心 **故意不内置 MCP 与 sub-agent**，扩展点是 `registerTool` / `customTools` / `beforeToolCall`。这对嵌入 Hub 是机会。
- Studio 是 `pithings/pi-vscode` 的二级 fork，chat 走外部 `pi --mode rpc` CLI，Settings 走内嵌 SDK——双轨依赖。

## 选项

| 方案 | 结论 |
|------|------|
| A. Fork Studio，换 UI / 换 MCP | 拒绝：继承 CLI 探测、版本漂移、onboarding；最大资产 pi-chat 必须重写 |
| B. 只用 pi SDK 自建扩展 | 骨架正确，但 settings/OAuth 要重写 |
| C. 自研 agent loop | 拒绝：compat 矩阵与 loop 钩子是数年打磨 |
| D. B + 移植 Studio 解耦模块 | **采用** |

## 决策

路线 D：

```text
createAgentSession({
  customTools: HubHost.asPiTools(),
  resourceLoader: OpsResourceLoader,          // 运维 prompt / skills
  modelRuntime: ModelRuntime.create({ credentials: VscodeSecretCredentialStore }),
  sessionManager: SessionManager.create(agentDir)
})
```

- 用户 **不必** 安装 pi CLI。
- LLM 配置格式对齐 `models.json`（compat / thinkingFormat / `$ENV` / `!command`），但文件放在 `~/.at-series/agent/`，避免与用户 pi coding agent 抢目录。可选「导入 ~/.pi/agent/models.json」。
- 子代理用 SDK in-process 子会话；高危长任务可再 spawn。
- 默认 **不** 打开 pi 的 `bash` / `write` / `edit`。工作区仅只读工具（读 skill、对照源码），运维变更走 AT 插件。

## 后果

- 0.x minor 可能破坏 API：三包同号精确锁定，升级当事务。
- vsix 体积会被 pi-ai 的 provider SDK 拉大：tree-shake + Bedrock 分包。
- vendoring Studio 文件须保留 Johnny Zhao MIT 版权头。
