# 08 · 性能与可靠性

## 预算

| 项 | 目标 |
|----|------|
| `activate` 到 Hub watch 就绪 | < 200ms（不含探测） |
| 新插件 publish → Capabilities 可见 | p50 < 300ms，p99 < 3.2s（watch 兜底 3s） |
| 首屏 webview | 骨架 < 100ms；hydrate 历史分页 |
| 流式 token → 屏幕 | 合批 30–50ms |
| 单次 invoke 协议开销（不含插件执行） | loopback < 5ms |
| 暴露给模型的工具 schema | `auto` 下业务工具 ≤ threshold（20）或已选中集 |
| 并行 Investigator | 默认 3 / 硬顶 4 |
| 工具结果进 LLM | 预览 ≤ 4–8KB；全文落盘 |
| 会话 JSONL 写 | 异步 append，不阻塞 loop |

## 做法

1. **打包**：extension / chat webview / board webview 三份 esbuild；activate 入口不 import pi-ai 全量，会话工厂动态 `import()`。
2. **Hub**：复用 150ms debounce、2s list TTL、15s 健康重探、4s 失败退避。心跳引起的 watch 不得打满探测。
3. **setActiveTools**：只在暴露集 **名或 schema 哈希** 变化时调用，避免每 30s 心跳重建 system prompt。
4. **postMessage**：禁止逐 token；禁止传 2MiB 日志。
5. **虚拟列表**：按消息块。
6. **超时**：invoke 120s；子代理 `maxWallMs` 默认 180s；LLM 走 pi retry/timeout 设置。
7. **取消**：AbortSignal 从按钮 → session.abort → in-flight fetch。
8. **崩溃**：JSONL 恢复；webview hydrate；in-flight 标 interrupted。
9. **内存**：每窗口一个 HubRuntime + 一个主 session；子会话结束后释放。看板按事故懒加载。

## 反模式

- 为「实时」对每个 token `postMessage`
- `discoveryMode=off` 把 70+ 工具全塞进 system prompt
- activate 时 `createAgentSession` + 拉模型列表网络请求
- `retainContextWhenHidden` 当主状态方案
- 每个子代理 spawn 一个完整 pi CLI 进程（第一期 in-process；只有 Executor 长任务才考虑 child）
