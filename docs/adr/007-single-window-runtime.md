# ADR-007 · 单窗口运行时（不做多窗口选主）

## 状态

Accepted（Plan 12 T10 SKIP）

## 背景

同一工作区开多个 VS Code / Cursor 窗口时，每个扩展宿主一份 Hub 选择态、一份 runtime 池、一份 IM 定时器。Plan 12 T10 曾设想 `globalState` + `~/.at-series/agent/instance.lock`：非主窗口禁用 runtime pool，只读 hydrate。

复杂度高：锁过期、崩溃残留、Remote-SSH 与本地窗口抢锁、选主失败时审批 webhook 双发。当前产品是侧边栏单 Chat + 至多 2 个并行会话席，没有「多窗口同时值班」的真实宿主。

## 选项

| 方案 | 做法 | 结论 |
|------|------|------|
| 1 | `instance.lock` + 选主，非主窗口只读 | 拒绝：锁协议、过期与 Remote 场景都要产品化，收益只是防双发 |
| 2 | 单窗口约定：运行时以当前窗口为准，不选主 | **采用** |
| 3 | 跨窗口共享 runtime 进程 | 拒绝：等于提前做 T14 第二宿主 |

## 决策

**单窗口运行时。不写 `instance.lock`，不做多窗口选主。**

- 每个窗口是独立 extension host：Hub watch、runtime、审批令牌、IM 出站都在本窗口。
- 用户应在一个窗口值班。多开窗口可能重复 hydrate / 重复 webhook，这是可接受的操作约束，不是要用文件锁修补的缺陷。
- 会话席位上限仍是 `sessions.maxParallel` ≤ 2（同一窗口内），与跨窗口无关。

## 后果

- 无锁文件残留、无「为什么这个窗口不能跑 Agent」。
- 若将来真有多窗口同时跑巡检的需求，再单独立项选主；在那之前禁止预建 lock。
