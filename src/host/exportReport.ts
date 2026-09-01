/**
 * 值班报告一键导出（P1-10 / OPT-10）：把当前会话的 transcript + 工具调用 +
 * 审批记录 + 证据便签 + 看板时间线渲染成 Markdown 或 JSON（DutyReportV1）。
 *
 * 纯函数、不 import vscode，可直接单测；写盘与打开由 hostController 完成。
 * 红线：sanitize 默认 true，过 redactSecrets；可显式关闭。
 */
import { z } from 'zod';
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

/** 导出选项：sanitize 默认 true（刮密 Authorization/Bearer/token 等）。 */
export interface ExportReportOptions {
  sanitize?: boolean;
}

export type ExportReportFormat = 'markdown' | 'json';

export interface DutyReportV1 {
  version: 1;
  meta: {
    sessionId: string;
    title: string;
    generatedAt: string;
    playbook?: { id: string; stage: string };
  };
  dialogue: Array<{ role: 'user' | 'assistant' | 'system' | 'notice'; text: string; error?: boolean }>;
  toolCalls: Array<{
    name: string;
    pluginId?: string;
    risk: string;
    status: string;
    preview?: string;
    error?: { code?: string; message: string };
  }>;
  evidence: Array<{
    taskId: string;
    confidence: string;
    summary: string;
    pinned?: boolean;
    refs: Array<{ kind: string; preview: string }>;
  }>;
  approvals: Array<{
    briefId: string;
    decision: string;
    risk?: string;
    targetLabel?: string;
    ts?: number;
  }>;
  stages: Array<{ ts: number; from?: string; stage: string }>;
  redaction: { applied: boolean; hits: number };
}

export const dutyReportV1Schema = z.object({
  version: z.literal(1),
  meta: z.object({
    sessionId: z.string(),
    title: z.string(),
    generatedAt: z.string(),
    playbook: z.object({ id: z.string(), stage: z.string() }).optional()
  }),
  dialogue: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system', 'notice']),
      text: z.string(),
      error: z.boolean().optional()
    })
  ),
  toolCalls: z.array(
    z.object({
      name: z.string(),
      pluginId: z.string().optional(),
      risk: z.string(),
      status: z.string(),
      preview: z.string().optional(),
      error: z.object({ code: z.string().optional(), message: z.string() }).optional()
    })
  ),
  evidence: z.array(
    z.object({
      taskId: z.string(),
      confidence: z.string(),
      summary: z.string(),
      refs: z.array(z.object({ kind: z.string(), preview: z.string() }))
    })
  ),
  approvals: z.array(
    z.object({
      briefId: z.string(),
      decision: z.string(),
      risk: z.string().optional(),
      targetLabel: z.string().optional(),
      ts: z.number().optional()
    })
  ),
  stages: z.array(
    z.object({
      ts: z.number(),
      from: z.string().optional(),
      stage: z.string()
    })
  ),
  redaction: z.object({
    applied: z.boolean(),
    hits: z.number()
  })
});

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

function sanitizeEnabled(input: ExportReportOptions): boolean {
  return input.sanitize !== false;
}

function applySanitize(text: string, sanitize: boolean): { text: string; hits: number } {
  if (!sanitize) return { text, hits: 0 };
  return redactSecrets(text);
}

function deepRedact(value: unknown, sanitize: boolean): { value: unknown; hits: number } {
  if (!sanitize) return { value, hits: 0 };
  if (typeof value === 'string') {
    const r = redactSecrets(value);
    return { value: r.text, hits: r.hits };
  }
  if (Array.isArray(value)) {
    let hits = 0;
    const next = value.map((entry) => {
      const r = deepRedact(entry, sanitize);
      hits += r.hits;
      return r.value;
    });
    return { value: next, hits };
  }
  if (value !== null && typeof value === 'object') {
    let hits = 0;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const r = deepRedact(entry, sanitize);
      hits += r.hits;
      next[key] = r.value;
    }
    return { value: next, hits };
  }
  return { value, hits: 0 };
}

type ApprovalRow = { briefId: string; decision: string; ts?: number; risk?: string; targetLabel?: string };

function collectApprovalRows(input: ExportReportInput): ApprovalRow[] {
  const approvalItems = input.items.filter(
    (i): i is Extract<TranscriptItem, { kind: 'approval' }> => i.kind === 'approval'
  );
  const approvalEvents = input.timeline.filter((e) => e.kind === 'approval');
  const pending = input.pendingBriefs ?? [];

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

  const rows: ApprovalRow[] = [...byBrief.values()];
  for (const brief of pending) {
    if (rows.some((row) => row.briefId === brief.id)) continue;
    rows.push({
      briefId: brief.id,
      decision: 'pending',
      risk: brief.risk,
      targetLabel: brief.targetLabel
    });
  }
  for (const row of [...byBrief.values()].filter((entry) => entry.decision === 'pending')) {
    if (pending.some((brief) => brief.id === row.briefId)) continue;
    if (rows.some((existing) => existing.briefId === row.briefId)) continue;
    rows.push(row);
  }
  return rows;
}

/** 结构化 DutyReportV1（MD/JSON 同源）。 */
export function buildDutyReportV1(input: ExportReportInput & ExportReportOptions): DutyReportV1 {
  const now = input.now ?? new Date();
  const sanitize = sanitizeEnabled(input);

  const dialogue: DutyReportV1['dialogue'] = [];
  for (const item of input.items) {
    switch (item.kind) {
      case 'user':
        dialogue.push({ role: 'user', text: truncate(item.text, 2000) });
        break;
      case 'assistant':
        dialogue.push({
          role: 'assistant',
          text: truncate(item.text, 4000),
          ...(item.error ? { error: true } : {})
        });
        break;
      case 'notice':
        dialogue.push({ role: 'notice', text: truncate(item.text) });
        break;
      case 'system':
        dialogue.push({ role: 'system', text: truncate(item.text) });
        break;
      default:
        break;
    }
  }

  const toolCalls: DutyReportV1['toolCalls'] = input.items
    .filter((i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool')
    .map((item) => {
      const c = item.call;
      return {
        name: c.name,
        ...(c.pluginId !== undefined ? { pluginId: c.pluginId } : {}),
        risk: c.risk,
        status: c.status,
        ...(c.preview !== undefined ? { preview: truncate(c.preview) } : {}),
        ...(c.errorMessage !== undefined
          ? { error: { ...(c.errorCode !== undefined ? { code: c.errorCode } : {}), message: c.errorMessage } }
          : {})
      };
    });

  const evidence: DutyReportV1['evidence'] = input.items
    .filter((i): i is Extract<TranscriptItem, { kind: 'evidence' }> => i.kind === 'evidence')
    .map((item) => ({
      taskId: item.note.taskId,
      confidence: item.note.confidence,
      summary: truncate(item.note.summary),
      ...(item.note.pinned ? { pinned: true } : {}),
      refs: item.note.refs.map((ref) => ({ kind: ref.kind, preview: truncate(ref.preview, 160) }))
    }));

  const approvals: DutyReportV1['approvals'] = collectApprovalRows(input).map((row) => ({
    briefId: row.briefId,
    decision: row.decision,
    ...(row.risk !== undefined ? { risk: row.risk } : {}),
    ...(row.targetLabel !== undefined ? { targetLabel: truncate(row.targetLabel, 120) } : {}),
    ...(typeof row.ts === 'number' ? { ts: row.ts } : {})
  }));

  const stages: DutyReportV1['stages'] = input.timeline
    .filter((e) => e.kind === 'playbook_stage')
    .map((event) => ({
      ts: event.ts,
      ...(typeof event.from === 'string' ? { from: event.from } : {}),
      stage: String(event.stage ?? '')
    }));

  const raw: DutyReportV1 = {
    version: 1,
    meta: {
      sessionId: input.sessionId,
      title: input.sessionTitle ?? input.sessionId,
      generatedAt: fmtTs(now.getTime()),
      ...(input.playbook !== undefined
        ? { playbook: { id: input.playbook.id, stage: input.playbook.stage } }
        : {})
    },
    dialogue,
    toolCalls,
    evidence,
    approvals,
    stages,
    redaction: { applied: sanitize, hits: 0 }
  };

  const redacted = deepRedact(raw, sanitize);
  const report = redacted.value as DutyReportV1;
  report.redaction = { applied: sanitize, hits: redacted.hits };
  return report;
}

export function buildOpsReportJson(input: ExportReportInput & ExportReportOptions): string {
  return `${JSON.stringify(buildDutyReportV1(input), null, 2)}\n`;
}

export function buildOpsReportMarkdown(input: ExportReportInput & ExportReportOptions): string {
  const now = input.now ?? new Date();
  const sanitize = sanitizeEnabled(input);
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
  const pinnedEvidence = evidence.filter((item) => item.note.pinned);
  const otherEvidence = evidence.filter((item) => !item.note.pinned);
  if (pinnedEvidence.length > 0) {
    lines.push('## 置顶证据');
    lines.push('');
    for (const item of pinnedEvidence) {
      lines.push(`- **[${item.note.confidence}]** ${truncate(item.note.summary)}（任务 ${item.note.taskId}）`);
      for (const ref of item.note.refs) {
        lines.push(`  - ${ref.kind}: ${truncate(ref.preview, 160)}`);
      }
    }
    lines.push('');
  }
  if (otherEvidence.length > 0) {
    lines.push('## 证据便签');
    lines.push('');
    for (const item of otherEvidence) {
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
  const approvalRows = collectApprovalRows(input);

  function decisionLabel(decision: unknown): string {
    if (decision === 'approved') return '✅ 已批准';
    if (decision === 'timeout') return '⏱ 已超时';
    if (decision === 'pending') return '⏳ 未决';
    return '⛔ 已拒绝';
  }

  const resolved = approvalRows.filter((row) => row.decision !== 'pending');
  const pendingRows = approvalRows.filter((row) => row.decision === 'pending');
  if (resolved.length === 0 && pendingRows.length === 0) {
    lines.push('（本会话没有审批事件）');
  } else {
    for (const row of resolved) {
      const stamp = typeof row.ts === 'number' ? `${fmtTs(row.ts)} · ` : '';
      lines.push(`- ${stamp}简报 \`${row.briefId}\` · ${decisionLabel(row.decision)}`);
    }
    for (const row of pendingRows) {
      const detail =
        row.risk !== undefined && row.targetLabel !== undefined
          ? ` · ${riskLabel(row.risk)} · ${truncate(row.targetLabel, 120)}`
          : '';
      lines.push(`- ⏳ 未决 · 简报 \`${row.briefId}\`${detail}`);
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
  if (sanitize) {
    lines.push('> 本报告由 AT Ops Agent 自动导出；审批令牌与凭证不会出现在报告中。');
  } else {
    lines.push('> 本报告由 AT Ops Agent 自动导出（未脱敏，分享前请自行审查敏感内容）。');
  }
  lines.push('');
  return applySanitize(lines.join('\n'), sanitize).text;
}

/** 导出文件名（时间戳到分钟，避免冒号等非法字符）。 */
export function exportReportFileName(now = new Date(), format: ExportReportFormat = 'markdown'): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ext = format === 'json' ? 'json' : 'md';
  return `at-ops-report-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${ext}`;
}
