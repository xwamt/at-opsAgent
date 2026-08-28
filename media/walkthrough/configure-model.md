# 配置模型（约 1 分钟）

AT Ops Agent 需要一个 LLM 才能开始排障问答。配置只需三步，全程约 1 分钟。

## 1. 打开模型设置

点击 [打开模型设置](command:atOpsAgent.openModels)，或在命令面板（`Ctrl+Shift+P`）里运行 **AT Ops Agent: Open Models**。

## 2. 选择 Provider 并粘贴 API Key

- 从预设里选择你的服务：**公司内部网关（OpenAI 兼容）**、OpenAI、Anthropic（支持浏览器登录，无需手输 key）、通义 / DeepSeek，或自定义。
- 选完预设后 Base URL 和接口类型会自动预填，通常只需要粘贴 **API Key** 并确认模型 ID（如 `qwen3-max`）。
- 不确定选哪个？问一下你的平台组，通常是「内部网关」。

> 🔒 Key 只保存在 VS Code 安全存储（SecretStorage）中；`models.json` 落盘的是 `${secret:…}` 占位符，不会出现明文，也不会进日志。

## 3. 验证并保存

点击 **验证并保存**。扩展会立即做一次连通性测试：

- ✓ 成功：显示「连接成功」和首 token 延迟，配置即刻生效。
- ✗ 失败：错误会内联显示成人话——`401` 表示 Key 无效或过期；网络错误请检查 Base URL 与代理设置。修好后重试即可，不用等到聊天时才发现问题。

## 完成标志

回到聊天视图，composer 的模型选择器已经出现你刚配置的模型。发一句「用一句话介绍你自己」，看到**流式逐字回复**即配置成功。
