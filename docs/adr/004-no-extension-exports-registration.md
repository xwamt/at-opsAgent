# ADR-004 · 能力插件不用 extension exports 注册

## 状态

Accepted

## 背景

调研 05 曾建议「exports 做同 host 快速路径 + registry 做通用路径」。这与 Hub ADR-001 / AGENTS.md「新插件按协议注册即可」冲突。

## 决策

**唯一注册协议 = Bridge v1 文件系统 registry + loopback HTTP。**

拒绝 `vscode.extensions.getExtension('…opsAgent').exports.registerTool`：

1. 已上线 6+ 插件全部要加第二条路径 → 双轨。
2. 插件必须依赖 Agent（激活顺序、未安装、API 版本）。
3. 绕开 token / 回环边界，任何拿到 exports 的扩展可调用。
4. 收益是省 <1ms 的 localhost HTTP，不值。
5. exports 不跨 extension host；registry 已经跨窗口、跨 IDE。

Agent 自己的 `activate()` **可以**返回只读诊断 API（列当前 providers、强制 refresh），供调试扩展使用，但能力插件不得依赖它。

「装上插件工具就出现」的实现是：插件 `publish` → Agent `watchBridgeRegistry` → `onDidChangeTools` → 下一轮 LLM / 能力树刷新。延迟预算约 200ms。
