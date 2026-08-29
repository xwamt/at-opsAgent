/**
 * 值班工作记忆 digest（Plan 08）：从 sessionStore 的 evidence 便签与
 * 审批时间线合成 ≤20 行 L-mem，compaction 后回灌系统提示词。
 *
 * 纯函数，禁止 import vscode。不要把 tool.preview 原文塞进 digest。
 */
import { redactSecrets } from '../../runtime/sanitize';

export const MEM_LAYER_MAX_LINES = 20;
const MAX_EVIDENCE = 8;
const MAX_APPROVALS = 4;
const SUMMARY_MAX_CHARS = 80;

export interface DutyDigestPlaybook {
  id: string;
  stage: string;
}

export interface DutyDigestEvidence {
  confidence: string;
  summary: string;
}

export interface DutyDigestApproval {
  briefId: string;
  decision?: string;
}

export function buildDutyDigest(input: {
  playbook?: DutyDigestPlaybook;
  evidence: DutyDigestEvidence[];
  approvals: DutyDigestApproval[];
  exposed?: string[];
}): string {
  const dropped =
    Math.max(0, input.evidence.length - MAX_EVIDENCE) +
    Math.max(0, input.approvals.length - MAX_APPROVALS);

  const lines: string[] = [
    '# L-mem 交接（compaction 后回灌，勿丢）',
    input.playbook
      ? `playbook: ${input.playbook.id} @ ${input.playbook.stage}`
      : 'playbook: (no playbook)'
  ];

  const evidence = input.evidence.slice(0, MAX_EVIDENCE);
  if (evidence.length > 0) {
    lines.push('evidence:');
    for (const note of evidence) {
      const summary = clipSummary(note.summary);
      lines.push(`- [${note.confidence}] ${summary}`);
    }
  }

  const approvals = input.approvals.slice(0, MAX_APPROVALS);
  if (approvals.length > 0) {
    lines.push('approvals:');
    for (const a of approvals) {
      const decision = typeof a.decision === 'string' && a.decision.length > 0 ? ` ${a.decision}` : '';
      lines.push(`- brief ${a.briefId}${decision}`);
    }
  }

  if (input.exposed && input.exposed.length > 0) {
    lines.push(`exposed: ${input.exposed.join(', ')}`);
  }

  const fitted = fitLineBudget(lines, dropped);
  return redactSecrets(fitted.join('\n')).text;
}

/** 从 transcript / 时间线收集 digest 输入（只取 note.summary 与 briefId/decision）。 */
export function collectDutyDigestInput(input: {
  playbook?: DutyDigestPlaybook;
  items: readonly { kind: string; note?: { confidence?: unknown; summary?: unknown } }[];
  timeline: readonly unknown[];
  pendingBriefs?: readonly { id: string }[];
  exposed?: string[];
}): Parameters<typeof buildDutyDigest>[0] {
  const evidence: DutyDigestEvidence[] = [];
  for (const item of input.items) {
    if (item.kind !== 'evidence' || item.note === undefined) continue;
    const summary = typeof item.note.summary === 'string' ? item.note.summary : '';
    const confidence = typeof item.note.confidence === 'string' ? item.note.confidence : 'pending';
    evidence.push({ confidence, summary });
  }

  const seen = new Set<string>();
  const approvals: DutyDigestApproval[] = [];
  for (const raw of input.timeline) {
    if (raw === null || typeof raw !== 'object') continue;
    const event = raw as { kind?: unknown; briefId?: unknown; decision?: unknown };
    if (event.kind !== 'approval') continue;
    const briefId = typeof event.briefId === 'string' ? event.briefId : '';
    if (briefId.length === 0 || seen.has(briefId)) continue;
    seen.add(briefId);
    approvals.push({
      briefId,
      ...(typeof event.decision === 'string' ? { decision: event.decision } : {})
    });
  }
  for (const brief of input.pendingBriefs ?? []) {
    if (seen.has(brief.id)) continue;
    seen.add(brief.id);
    approvals.push({ briefId: brief.id, decision: 'pending' });
  }

  return {
    ...(input.playbook !== undefined ? { playbook: input.playbook } : {}),
    evidence,
    approvals,
    ...(input.exposed !== undefined ? { exposed: input.exposed } : {})
  };
}

function clipSummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > SUMMARY_MAX_CHARS ? compact.slice(0, SUMMARY_MAX_CHARS) : compact;
}

function fitLineBudget(lines: string[], alreadyDropped: number): string[] {
  let truncated = alreadyDropped;
  if (lines.length <= MEM_LAYER_MAX_LINES && truncated === 0) return lines;
  const budget = MEM_LAYER_MAX_LINES - 1;
  let kept = lines;
  if (kept.length > budget) {
    truncated += kept.length - budget;
    kept = kept.slice(0, budget);
  }
  if (truncated > 0) kept.push(`… truncated ${truncated}`);
  return kept;
}
