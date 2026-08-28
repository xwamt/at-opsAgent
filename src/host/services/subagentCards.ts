/**
 * 子代理卡片 / 证据便签的 store + 广播落点（ChatService 拆件）。
 * 写目标会话的 store 包；活动会话才实时广播（sessions.maxParallel=2）。
 */
import { randomUUID } from 'node:crypto';
import type { EvidenceNoteView, SubagentCard } from '../../protocol';
import type { HostContext } from './context';

/** 更新或创建子代理卡片并广播；返回卡片是否处于 live（queued/running）态。 */
export function patchSubagentCard(
  ctx: HostContext,
  sessionId: string,
  taskId: string | undefined,
  status?: string,
  latest?: string,
  role?: string
): boolean | undefined {
  if (!taskId) return undefined;
  const existing = ctx.store.getSubagent(taskId, sessionId);
  const nextRole = isSubagentRole(role) ? role : existing?.role ?? 'investigator';
  const next: SubagentCard = existing
    ? {
        ...existing,
        role: nextRole,
        status: isSubagentStatus(status) ? status : existing.status,
        ...(latest !== undefined ? { latest } : {})
      }
    : {
        taskId,
        role: nextRole,
        label: latest && latest.length > 0 ? latest : nextRole,
        status: isSubagentStatus(status) ? status : 'queued',
        riskCeiling: nextRole === 'executor' ? 'exec' : 'read',
        toolCalls: { used: 0, max: 15 },
        wallMs: { used: 0, max: 180_000 },
        ...(latest !== undefined ? { latest } : {})
      };
  ctx.store.upsertSubagent(next, sessionId);
  ctx.broadcastToSession(sessionId, 'subagent/upsert', next);
  return next.status === 'queued' || next.status === 'running';
}

/** 子代理产出的 evidence-note@1 → transcript 证据卡片 + 看板时间线。 */
export function appendEvidenceNote(
  ctx: HostContext,
  sessionId: string,
  note: {
    taskId: string;
    confidence: 'confirmed' | 'hypothesis' | 'pending';
    summary: string;
    refs?: Array<{ kind: string; preview: string; artifactUri?: string }>;
  }
): void {
  if (typeof note.taskId !== 'string' || typeof note.summary !== 'string') return;
  const view: EvidenceNoteView = {
    taskId: note.taskId,
    confidence: isEvidenceConfidence(note.confidence) ? note.confidence : 'pending',
    summary: note.summary,
    refs: Array.isArray(note.refs)
      ? note.refs.map((ref) => ({
          kind: String(ref.kind ?? 'note'),
          preview: String(ref.preview ?? ''),
          ...(typeof ref.artifactUri === 'string' ? { artifactUri: ref.artifactUri } : {})
        }))
      : []
  };
  const item = { kind: 'evidence' as const, id: randomUUID(), note: view };
  ctx.store.appendItem(item, sessionId);
  ctx.broadcastToSession(sessionId, 'transcript/append', { item });
  ctx.store.appendTimeline(
    { kind: 'evidence', taskId: view.taskId, confidence: view.confidence, summary: view.summary },
    sessionId
  );
}

const SUBAGENT_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'ok',
  'degraded',
  'failed',
  'aborted'
]);

function isSubagentStatus(value: string | undefined): value is SubagentCard['status'] {
  return value !== undefined && SUBAGENT_STATUSES.has(value);
}

const SUBAGENT_ROLES: ReadonlySet<string> = new Set([
  'investigator',
  'executor',
  'writer',
  'verifier'
]);

function isSubagentRole(value: string | undefined): value is SubagentCard['role'] {
  return value !== undefined && SUBAGENT_ROLES.has(value);
}

const EVIDENCE_CONFIDENCES: ReadonlySet<string> = new Set(['confirmed', 'hypothesis', 'pending']);

function isEvidenceConfidence(value: unknown): value is EvidenceNoteView['confidence'] {
  return typeof value === 'string' && EVIDENCE_CONFIDENCES.has(value);
}
