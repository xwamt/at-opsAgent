---
name: ops-documents
description: >
  运维文档模板索引。巡检、排障、交接、操作、发布、应急预案落盘时使用。
  用 ops_write_ops_doc 写入 ops-docs/，不要 bash，不要通用写文件。
---

# 运维文档模板

把会话结论写成 Markdown 存档时：**先 `ops_read_skill` 读对应模板，再 `ops_write_ops_doc` 落盘。用 ops_write_ops_doc，不要 bash。**

路径只允许工作区 `ops-docs/YYYY/MM/`（无工作区则 `~/.at-series/agent/ops-docs/`）。write 走会话审批。

## 何时用哪一类（docType 英文 key）

| 场景 | docType | 模板 |
|------|---------|------|
| 例行/专项巡检结论 | `inspection-report` | `ops-documents/inspection-report.md` |
| 故障排查 RCA / 过程 | `troubleshooting-report` | `ops-documents/troubleshooting-report.md` |
| 班次交接、未闭环项 | `handoff` | `ops-documents/handoff.md` |
| 一次变更/操作记录 | `operation-record` | `ops-documents/operation-record.md` |
| 发布 / 回滚记录 | `deployment` | `ops-documents/deployment.md` |
| 应急预案（事前） | `emergency-plan` | `ops-documents/emergency-plan.md` |

不确定时问一句，不要默默写成 inspection-report。

## 必填段

模板含固定 `##` 标题：文档信息、背景目标、现状证据、步骤、验证、回滚、交接。
未核对的段写「未检查」——工具会自动补缺段，禁止把未检查标成「正常」。

## 纪律

- 刮密：密钥、Bearer、连接串不要写入正文。
- 证据优先：没有应用侧日志不得宣称根因。
- 不要发明 Jenkins/Nacos 写工具；发布与触发构建走 GuidedManual。
