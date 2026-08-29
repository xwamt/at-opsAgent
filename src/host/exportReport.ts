/**
 * 值班报告一键导出（P1-10）：把当前会话的 transcript + 工具调用 +
 * 审批记录 + 证据便签 + 看板时间线渲染成 Markdown。
 *
 * 纯函数、不 import vscode，可直接单测；写盘与打开由 hostController 完成。
 * 红线：return 前过 redactSecrets，审批令牌 / API key / Bearer 不会出现在报告中。
 */
import type { ApprovalBriefView, TranscriptItem } from '../protocol';
import { redactSecrets } from '../runtime/sanitize';
import type { PlaybookState, TimelineEventView } from './sessionStore';

export interface ExportReportInput {
  sessionId: string;
  sessionTitle?: string;
  playbook?: PlaybookState;
  items: readonly TranscriptItem[];
  timeline: readonly TimelineEventView[];
  /** 仍待批的简报（导出时明示「未决」）。 */
  pendingBriefs?: readonly ApprovalBriefView[];
  /** 生成时间（测试可注入固定值）。 */
  now?: Date;
}

const PREVIEW_MAX = 400;

function truncate(text: string, limit = PREVIEW_MAX): string {
  const single = text.replace(/\r/g, '').trim();
  return single.length > limit ? `${single.slice(0, limit)}…（已截断）` : single;
}

/** Markdown 表格单元格转义（管道与换行）。 */
function cell(text: string): string {
  return truncate(text, 160).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function riskLabel(risk: string): string {
  switch (risk) {
    case 'read':
      return '只读';
    case 'write':
      return '写';
    case 'exec':
      return '执行';
    default:
      return risk;
  }
}

export function buildOpsReportMarkdown(input: ExportReportInput): string {
  const now = input.now ?? new Date();
  const lines: string[] = [];
  lines.push(`# 值班报告 · ${input.sessionTitle ?? input.sessionId}`);
  lines.push('');
  lines.push(`- 生成时间：${fmtTs(now.getTime())}`);
  lines.push(`- 会话：\`${input.sessionId}\``);
  if (input.playbook) {
    lines.push(`- Playbook：\`${input.playbook.id}\`（阶段 ${input.playbook.stage}）`);
  }
  lines.push('');

  // ── 对话时间线 ─────────────────────────────────────────────────────────
  lines.push('## 对话时间线');
  lines.push('');
  let hasDialogue = false;
  for (const item of input.items) {
    switch (item.kind) {
      case 'user':
        lines.push(`### 🧑 操作者`);
        lines.push('');
        lines.push(truncate(item.text, 2000));
        lines.push('');
        hasDialogue = true;
        break;
      case 'assistant':
        lines.push(`### Agent${item.error ? '（失败）' : ''}`);
        lines.push('');
        lines.push(truncate(item.text, 4000));
        lines.push('');
        hasDialogue = true;
        break;
      case 'notice':
        lines.push(`> [${item.variant}] ${truncate(item.text)}`);
        lines.push('');
        hasDialogue = true;
        break;
      case 'system':
        lines.push(`> ${truncate(item.text)}`);
        lines.push('');
        hasDialogue = true;
        break;
      default:
        break;
    }
  }
  if (!hasDialogue) {
    lines.push('（本会话没有对话内容）');
    lines.push('');
  }

  // ── 工具调用 ──────────────────────────────────────────────────────────
  const tools = input.items.filter(
    (i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool'
  );
  lines.push('## 工具调用');
  lines.push('');
  if (tools.length === 0) {
    lines.push('（无工具调用）');
  } else {
    lines.push('| 工具 | 插件 | 风险 | 状态 | 结果预览 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const tool of tools) {
      const c = tool.call;
      lines.push(
        `| \`${c.name}\` | ${c.pluginId ?? '—'} | ${riskLabel(c.risk)} | ${c.status} | ${
          c.errorMessage !== undefined
            ? cell(`${c.errorCode ?? 'error'}: ${c.errorMessage}`)
            : c.preview !== undefined
              ? cell(c.preview)
              : '—'
        } |`
      );
    }
  }
  lines.push('');

  // ── 证据便签 ──────────────────────────────────────────────────────────
  const evidence = input.items.filter(
    (i): i is Extract<TranscriptItem, { kind: 'evidence' }> => i.kind === 'evidence'
  );
  if (evidence.length > 0) {
    lines.push('## 证据便签');
    lines.push('');
    for (const item of evidence) {
      lines.push(`- **[${item.note.confidence}]** ${truncate(item.note.summary)}（任务 ${item.note.taskId}）`);
      for (const ref of item.note.refs) {
        lines.push(`  - ${ref.kind}: ${truncate(ref.preview, 160)}`);
      }
    }
    lines.push('');
  }

  // ── 审批记录（transcript item.decision 优先于 timeline） ────────────
  lines.push('## 审批记录');
  lines.push('');
  const approvalItems = input.items.filter(
    (i): i is Extract<TranscriptItem, { kind: 'approval' }> => i.kind === 'approval'
  );
  const approvalEvents = input.timeline.filter((e) => e.kind === 'approval');
  const pending = input.pendingBriefs ?? [];

  function decisionLabel(decision: unknown): string {
    if (decision === 'approved') return '✅ 已批准';
    if (decision === 'timeout') return '⏱ 已超时';
    if (decision === 'pending') return '⏳ 未决';
    return '⛔ 已拒绝';
  }

  type ApprovalRow = { briefId: string; decision: string; ts?: number };
  const byBrief = new Map<string, ApprovalRow>();
  for (const event of approvalEvents) {
    const briefId = String(event.briefId ?? '');
    if (!briefId) continue;
    byBrief.set(briefId, {
      briefId,
      decision: String(event.decision ?? 'rejected'),
      ts: event.ts
    });
  }
  for (const item of approvalItems) {
    if (!item.decision) continue;
    const prev = byBrief.get(item.briefId);
    byBrief.set(item.briefId, {
      briefId: item.briefId,
      decision: item.decision,
      ts: typeof item.ts === 'number' ? item.ts : prev?.ts
    });
  }

  const resolved = [...byBrief.values()].filter((row) => row.decision !== 'pending');
  const pendingFromItems = [...byBrief.values()].filter((row) => row.decision === 'pending');
  if (resolved.length === 0 && pending.length === 0 && pendingFromItems.length === 0) {
    lines.push('（本会话没有审批事件）');
  } else {
    for (const row of resolved) {
      const stamp = typeof row.ts === 'number' ? `${fmtTs(row.ts)} · ` : '';
      lines.push(`- ${stamp}简报 \`${row.briefId}\` · ${decisionLabel(row.decision)}`);
    }
    for (const brief of pending) {
      lines.push(
        `- ⏳ 未决 · 简报 \`${brief.id}\` · ${riskLabel(brief.risk)} · ${truncate(brief.targetLabel, 120)}`
      );
    }
    for (const row of pendingFromItems) {
      if (pending.some((b) => b.id === row.briefId)) continue;
      lines.push(`- ⏳ 未决 · 简报 \`${row.briefId}\``);
    }
  }
  lines.push('');

  // ── 看板时间线（playbook 阶段 / guidedManual 等） ─────────────────────
  const stageEvents = input.timeline.filter((e) => e.kind === 'playbook_stage');
  if (stageEvents.length > 0) {
    lines.push('## Playbook 阶段轨迹');
    lines.push('');
    for (const event of stageEvents) {
      const from = typeof event.from === 'string' ? `${event.from} → ` : '';
      lines.push(`- ${fmtTs(event.ts)} · ${from}${String(event.stage ?? '')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('> 本报告由 AT Ops Agent 自动导出；审批令牌与凭证不会出现在报告中。');
  lines.push('');
  return redactSecrets(lines.join('\n')).text;
}

/** 导出文件名（时间戳到分钟，避免冒号等非法字符）。 */
export function exportReportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `at-ops-report-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
}
