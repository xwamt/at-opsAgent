# 16 · 气隙 / 离线部署

一页清单：无公网时如何把 AT Ops Agent 跑起来。不依赖外链图、不访问模型市场、不打开默认遥测。

## 1. 离线填写 `models.json`

配置落在 `~/.at-series/agent/models.json`（权限 0600）。**API key 只进 VS Code SecretStorage**，文件里永远是 `${secret:atOpsAgent.apiKey.<providerId>}` 占位符。

气隙步骤：

1. 在内网网关（OpenAI 兼容）上准备好模型 id 与 base URL，例如 `https://llm.corp.internal/v1`。
2. 命令面板运行 **AT Ops Agent: Open Models**，选「公司内部网关」，填 base URL / 模型 id，把 key 贴进表单（写入 SecretStorage，不落盘）。
3. 或手写 `models.json`（可从本仓库示例拷贝后改 baseUrl）。**不要**把真实 key 写进 JSON。

国产云示例（无真实密钥，**不要合并进默认 models.json**，以免覆盖用户文件）：

- [media/presets/glm.json](../media/presets/glm.json) — 智谱 GLM（`thinkingFormat: zai`）
- [media/presets/kimi.json](../media/presets/kimi.json) — Kimi / Moonshot

气隙下把示例里的 `baseUrl` 改成你的内网网关即可；公网 `open.bigmodel.cn` / `api.moonshot.cn` 只是字段形状参考。保存后用设置页「验证并保存」走内网探测，不要依赖 models.dev 之类公网目录。

## 2. Hub 不访问公网

嵌入 Hub（ADR-001）只做两件事：

- `fs.watch` 本地 `~/.at-series/bridges/<hostApp>/*.json`
- 对 Bridge 发 **loopback** HTTP（`127.0.0.1`）

没有插件市场、没有 `syncHubBundle`、没有把 AT 系列再配成公网 MCP。能力插件与 Agent 装在同一台离线机即可。第三方 `mcp.json` 若指向公网 server，气隙下不要填。

## 3. OTLP 默认关

可观测导出（Plan 12 T6）的开关是空 endpoint = 关。未配置 `atOpsAgent.otel.endpoint` 时 **零出站**。若将来打开，只允许内网 / localhost collector，拒绝公网 SaaS。气隙保持默认即可。

IM webhook（`atOpsAgent.im.webhookUrl`）同样默认空。若内网 IM 要收审批摘要：只出站 POST JSON + 可选 HMAC（密钥在 SecretStorage，命令 **设置 IM Webhook 加签密钥**）。消息带 `vscode://at-series.at-ops-agent/chat?sessionId=` 深链，**回 IDE 批准**。没有 inbound 批准回调，手机上不能点批准。

## 4. Walkthrough 不依赖外链图

入门三步（配置模型 / 检查能力插件 / 跑第一条 Playbook）全文在扩展包内 `media/walkthrough/`，没有 `https://` 图片、没有 CDN。离线 vsix 安装后命令面板走 **Get Started with AT Ops Agent** 即可。

## 5. 巡检不是 headless cron（T9 SKIP）

**巡检由用户点 Playbook**（`AT Ops Agent: Start Playbook` → `pb.inspection`）。不做无人值守 `setInterval` 自动跑工具。理由见 [ADR-006](adr/006-no-headless-inspection-cron.md)。可选的 `inspection.intervalMinutes` 只弹提醒，人点了才启动。

多窗口不选主、不写 `instance.lock`，见 [ADR-007](adr/007-single-window-runtime.md)。
