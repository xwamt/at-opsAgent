/**
 * Playbook 状态机与证据板合并。
 *
 * Orchestrator 持有状态；模型不能直接把状态写成 closed。
 * 迁移表来自 docs/04-ops-orchestration.md 的 mermaid 状态图，非法迁移 throw。
 */
import type { SubagentCard } from '../protocol';
import type { StageId } from './playbooks';

export const STAGE_TRANSITIONS: Readonly<Record<StageId, readonly StageId[]>> = {
  triage: ['selecting'],
  selecting: ['investigating'],
  investigating: ['synthesizing', 'escalated'],
  synthesizing: ['reporting', 'awaitingApproval', 'guidedManual'],
  awaitingApproval: ['executing', 'reporting'],
  executing: ['verifying', 'awaitingApproval'],
  verifying: ['reporting'],
  // mermaid 只画了 GuidedManual → Reporting；docs/04 §2.2 要求「用户完成后
  // → Verifying（只读确认）」。两条都合法，pb.release 的 verifying 才可达。
  guidedManual: ['reporting', 'verifying'],
  reporting: ['closed'],
  escalated: ['closed'],
  closed: []
};

export class IllegalStageTransitionError extends Error {
  readonly code = 'OPS_ILLEGAL_TRANSITION';

  constructor(
    readonly from: StageId,
    readonly to: StageId,
    allowedNext?: readonly StageId[]
  ) {
    const next = allowedNext ?? STAGE_TRANSITIONS[from];
    super(
      `非法阶段迁移 ${from} → ${to}；允许的下一步：${
        next.length > 0 ? next.join(', ') : '（终态）'
      }`
    );
    this.name = 'IllegalStageTransitionError';
  }
}

export function canTransition(from: StageId, to: StageId): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

/**
 * 校验迁移合法性。传 allowedStages（某条 playbook yaml 声明的阶段集合）时，
 * 目标阶段还必须在该集合内——pb.security-triage 没有 executing /
 * awaitingApproval 阶段，因此永远进不了执行路径。
 */
export function assertTransition(
  from: StageId,
  to: StageId,
  allowedStages?: ReadonlySet<StageId>
): void {
  const next =
    allowedStages === undefined
      ? STAGE_TRANSITIONS[from]
      : STAGE_TRANSITIONS[from].filter((stage) => allowedStages.has(stage));
  if (!next.includes(to)) {
    throw new IllegalStageTransitionError(from, to, next);
  }
}

// ────────────────────────────── 证据板 ──────────────────────────────

export type TimeWindow = { from: string; to: string };

export type EvidenceRef = {
  kind: string;
  preview: string;
  toolName?: string;
  pluginId?: string;
  artifactUri?: string;
};

/** evidence-note@1（skills/ops-agent-core/references/evidence-note.md） */
export type EvidenceNote = {
  id: string;
  taskId: string;
  confidence: 'confirmed' | 'hypothesis' | 'pending';
  summary: string;
  timeWindow?: TimeWindow;
  /** 同一命题的标识（如 "root-cause"）；两条便签命题相同而结论不同即冲突 */
  subject?: string;
  refs?: EvidenceRef[];
  conflicts?: string[];
};

function windowKey(win: TimeWindow | undefined): string | undefined {
  return win === undefined ? undefined : `${win.from}→${win.to}`;
}

function inConflict(a: EvidenceNote, b: EvidenceNote): boolean {
  if (a.taskId === b.taskId || a.summary === b.summary) return false;
  if (a.subject !== undefined && b.subject !== undefined) return a.subject === b.subject;
  return a.confidence === 'confirmed' && b.confidence === 'confirmed';
}

/**
 * 按 timeWindow 归并证据便签：同窗口内互相矛盾的便签不静默取舍，
 * 而是在双方 note.conflicts 里互相登记对方 id，交 Synthesizing 阶段明示。
 */
export function mergeEvidence(notes: EvidenceNote[]): EvidenceNote[] {
  const merged = notes.map((note) => ({
    ...note,
    conflicts: [...(note.conflicts ?? [])]
  }));

  const byWindow = new Map<string, EvidenceNote[]>();
  for (const note of merged) {
    const key = windowKey(note.timeWindow);
    if (key === undefined) continue;
    const group = byWindow.get(key);
    if (group === undefined) {
      byWindow.set(key, [note]);
    } else {
      group.push(note);
    }
  }

  for (const group of byWindow.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (inConflict(a, b)) {
          if (!a.conflicts!.includes(b.id)) a.conflicts!.push(b.id);
          if (!b.conflicts!.includes(a.id)) b.conflicts!.push(a.id);
        }
      }
    }
  }

  return merged;
}

// ────────────────────────────── 运行实例 ──────────────────────────────

/** 9 要素审批简报（skills/ops-agent-core/references/approval-brief.md） */
export type ApprovalBrief = {
  briefId: string;
  runId: string;
  risk: 'write' | 'exec';
  /** 确切命令 / 文件操作（要素 6），commandSetSha256 由它计算 */
  commandSet: unknown;
  commandSetSha256: string;
  /** 其余要素（目标/证据/影响/前置检查/备份/成功判据/回滚/不确定性） */
  elements?: Record<string, string>;
};

export type PlaybookRun = {
  id: string;
  playbookId: string;
  sessionId: string;
  stage: StageId;
  /** 本任务内已执行的 select 轮数（供 policy 的 selectCountThisTask） */
  selectCount: number;
  evidence: EvidenceNote[];
  pendingBrief?: ApprovalBrief;
  subagents: Map<string, SubagentCard>;
};
