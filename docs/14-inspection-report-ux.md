# 14 · 巡检必须可见：过程旁白 + 结论上屏

对照用户截图：工具全跑完、`ops_close_playbook` 了，界面上却几乎没有自然语言。用户怀疑「没出结果」或「出了但看不见」。

## 根因

1. **思考与正文抢同一个 id（确定）**  
   `src/runtime/index.ts` 一个 assistant 消息共用 `currentMessageId`。`thinking_delta` 先到 → store 建成 `kind:thinking`（ChatTranscript **永不渲染**）。随后 `text_delta` 发现 id 已存在，不建 assistant；`appendAssistantText` 只认 `kind==='assistant'` → **正文被丢弃**。带 reasoning 的模型会把整份巡检写进 thinking 或先思考再写正文，用户两边都看不到。

2. **模型只调工具、不说话**  
   L3 没强制「对用户说中文」。Cline/Claude Code 每一步有旁白。我们只有工具卡。

3. **只读巡检仍可能走审批**  
   `hostname && uptime && w` 里的 `w` 不在只读白名单 → 整段仍是 exec → `sessionRequiredFor=write-exec` 弹审批；命令稍变就 `OPS_APPROVAL_STALE`（截图红框）。

4. **close 不检查是否已有可见结论**  
   reporting.md 把报告推给 Writer 子代理；单机巡检主会话直接 close，没有强制 markdown 结论。

## 落地

| ID | 改动 |
|----|------|
| P0-id | thinking / assistant 分 id（`:thinking` / `:assistant`）；text 永不写入 thinking 项 |
| P0-report | idle 与 `ops_close_playbook`：若本轮无可见 assistant 正文（≥40 字），host 根据工具 preview **合成一份中文巡检结论**上屏，再允许 close |
| P0-prompt | L3：工具批次之间必须有一句中文旁白；close 前必须先输出巡检 markdown（主机/负载/磁盘/内存/服务/未检查项） |
| P0-read | 扩大只读推断：`w`/`who`/`ss`/`ip addr`/`docker ps|stats|inspect|logs`/`journalctl` 已有、管道滤镜 `head|awk|grep` 等 |
| P1-ui | 空 assistant 不占位；工具卡标题显示命令意图（磁盘/内存…）；过程中若尚无正文显示「正在巡检…」 |

不改 pi loop；不显示 CoT（thinking 仍隐藏）。可见的只有 assistant 正文与 host 合成报告。
