# ADR-006 · 巡检由用户点 Playbook，不做 headless cron

## 状态

Accepted（Plan 12 T9 SKIP）

## 背景

docs/15 / Plan 12 T9 曾允许可选 `atOpsAgent.inspection.cron`：仅在窗口聚焦且 `window.state.active` 时 `setInterval`，后台无宿主则不跑。目标是「到点提醒」，不是无人值守执行。

一旦做成定时自动跑 Playbook（哪怕挂在扩展进程里），就会滑向 **headless 无人值守执行**：无值班人确认、无会话上下文、审批/凭据仍在本机但决策链被定时器代劳。这与「凭据与批准不出 IDE、不做人机不在场的执行」冲突。

## 选项

| 方案 | 做法 | 结论 |
|------|------|------|
| 1 | `setInterval` / cron 字符串，窗口聚焦才跑 `pb.inspection` | 拒绝：与 headless 只差一步，默认关也会被人打开后当值班替身 |
| 2 | 文件系统 watcher / `tasks.json` / 外部 alichs | 拒绝：Plan 12 已禁止 |
| 3 | 用户在聊天里点 Playbook（`atOpsAgent.pickPlaybook` / 巡检链路） | **采用** |
| 4 | 仅 InformationMessage 提醒、人点了才启动（已有 `inspection.intervalMinutes`） | 允许保留：不是执行，是可选提醒 |

## 决策

**巡检由用户点 Playbook。不做 headless 巡检 cron。**

- 不新增 `atOpsAgent.inspection.cron`，不把 `setInterval` 接到 `startPlaybook('pb.inspection')` 的自动路径。
- 已有 `inspection.intervalMinutes` 若大于 0，只弹「是否启动例行巡检」；用户点「启动巡检」才跑。默认 0 = 关。这不是 T9 的 cron，也不升级成自动执行。
- 气隙环境同样适用：无外网调度、无云后台 agent。清单见 [16-airgap.md](../16-airgap.md)。

## 后果

- 值班节奏靠人，不靠扩展当 cron 宿主。
- 若将来有「到点只提醒、永不自动跑工具」的更强产品需求，仍走 InformationMessage / 状态栏，禁止静默 `startPlaybook`。
