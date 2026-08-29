/**
 * Orchestrator：Playbook 状态机驱动 + 子代理 TaskSpec 下发。
 *
 * 只构造数据（TaskSpec / SubagentCard / 事件），不跑 LLM、不 invoke 工具——
 * 那是 runtime 层的职责。select 由 orchestrator 代发（desiredSelect），
 * 不让模型随意选面。
 */
import { randomUUID } from 'node:crypto';

import type { SubagentCard } from '../protocol';
import { hashCommandSet } from '../policy';
import {
  STAGE_TRANSITIONS,
  assertTransition,
  mergeEvidence as mergeEvidenceNotes,
  type ApprovalBrief,
  type EvidenceNote,
  type PlaybookRun
} from './engine';
import {
  findStage,
  type EscalateSelectDirective,
  type ParallelTaskDef,
  type Playbook,
  type PlaybookStage,
  type RiskLevel,
  type SelectDirective,
  type StageId,
  type SubagentRole
} from './playbooks';

export * from './engine';
export * from './playbooks';

// ────────────────────────────── TaskSpec ──────────────────────────────

/** docs/schemas/task-spec.schema.json */
export type TaskSpec = {
  specVersion: 1;
  taskId: string;
  sessionId: string;
  playbookId?: string;
  stage?: string;
  role: SubagentRole;
  goal: string;
  inputs?: {
    timeWindow?: { from: string; to: string };
    targets?: Array<{ kind: string; id: string }>;
    contextNotes?: string[];
  };
  toolPolicy: {
    select: { mode: 'inherit' };
    allowTools?: string[];
    riskCeiling: RiskLevel;
    budget: { maxToolCalls: number; maxWallMs: number };
    payloadCaps?: Record<string, unknown>;
  };
  /**
   * Executor 的令牌引用：briefId 指向已批 9 要素简报；commandSetSha256
   * 由 host 在批准时计算并绑定（模型/子代理不自行计算哈希，故可缺省）。
   */
  approvalToken?: { briefId: string; commandSetSha256?: string } | null;
  plan?: Array<{
    step: number;
    kind: 'backup' | 'verifyBackup' | 'change' | 'readback' | 'verify' | 'other';
    tool: string;
    command?: string;
    args?: Record<string, unknown>;
  }>;
  output: {
    contract: 'evidence-note@1' | 'exec-report@1' | 'verify-report@1' | 'ops-doc';
    maxSummaryTokens?: number;
  };
  parallelGroup?: string;
  escalation?: {
    retries?: number;
    onFail?: 'degrade' | 'abort-group' | 'escalate-lead';
  };
};

const OUTPUT_CONTRACT_BY_ROLE: Record<SubagentRole, TaskSpec['output']['contract']> = {
  investigator: 'evidence-note@1',
  executor: 'exec-report@1',
  verifier: 'verify-report@1',
  writer: 'ops-doc'
};

const DEFAULT_BUDGET = { maxToolCalls: 15, maxWallMs: 180_000 } as const;
const DEFAULT_MAX_PARALLEL = 3;
const HARD_MAX_PARALLEL = 4;
const DEFAULT_MAX_SUMMARY_TOKENS = 800;

/**
 * 把 playbook 的 payloadCaps 注入工具调用缺省参数（docs/04 §3.2）。
 * 目前只有一条规则：caps.lokiLimit 存在、工具名含 loki、调用方没给
 * args.limit 时补上 limit。不修改传入的 args，命中时返回新对象。
 */
export function injectPayloadCaps(
  toolName: string,
  args: Record<string, unknown>,
  caps: Record<string, unknown> | undefined
): Record<string, unknown> {
  const lokiLimit = caps?.lokiLimit;
  if (
    typeof lokiLimit === 'number' &&
    toolName.toLowerCase().includes('loki') &&
    args.limit === undefined
  ) {
    return { ...args, limit: lokiLimit };
  }
  return args;
}

// ────────────────────────────── 事件 ──────────────────────────────

export type OrchestratorEvent =
  | { type: 'playbook/stage'; runId: string; playbookId: string; from?: StageId; stage: StageId }
  | { type: 'subagent/upsert'; runId: string; card: SubagentCard }
  | { type: 'approval/request'; runId: string; brief: ApprovalBrief }
  | {
      type: 'approval/resolved';
      runId: string;
      briefId: string;
      decision: 'approved' | 'rejected';
    };

export type CreateOrchestratorOptions = {
  playbooks: Playbook[];
  /** 同 parallelGroup 并行上限，默认 3、硬顶 4 */
  maxParallel?: number;
  onEvent?: (event: OrchestratorEvent) => void;
};

export type ApprovalDecisionInput = {
  brief: Pick<ApprovalBrief, 'briefId' | 'runId'>;
  decision: 'approved' | 'rejected';
};

export type Orchestrator = ReturnType<typeof createOrchestrator>;

// ────────────────────────────── 实现 ──────────────────────────────

export function createOrchestrator(options: CreateOrchestratorOptions) {
  const playbooksById = new Map(options.playbooks.map((pb) => [pb.id, pb]));
  const runs = new Map<string, PlaybookRun>();
  /** 已下发的 spec 登记，供重试阶梯 clone（docs/04 §3.3：失败 retry 1 → degrade） */
  const dispatched = new Map<string, { runId: string; spec: TaskSpec; retriesLeft: number }>();
  let runSeq = 0;
  let briefSeq = 0;

  function emit(event: OrchestratorEvent): void {
    options.onEvent?.(event);
  }

  function requirePlaybook(playbookId: string): Playbook {
    const pb = playbooksById.get(playbookId);
    if (pb === undefined) {
      throw new Error(`Unknown playbook ${playbookId}`);
    }
    return pb;
  }

  function resolveRun(runOrId: PlaybookRun | string): PlaybookRun {
    const run = typeof runOrId === 'string' ? runs.get(runOrId) : runs.get(runOrId.id);
    if (run === undefined) {
      throw new Error(`Unknown playbook run ${typeof runOrId === 'string' ? runOrId : runOrId.id}`);
    }
    return run;
  }

  function currentStageDef(run: PlaybookRun): PlaybookStage | undefined {
    return findStage(requirePlaybook(run.playbookId), run.stage);
  }

  /** 进入 triage；后续阶段由调用方 advanceTo 驱动 */
  function startPlaybook(playbookId: string, sessionId: string): PlaybookRun {
    const playbook = requirePlaybook(playbookId);
    const run: PlaybookRun = {
      id: `run-${++runSeq}-${randomUUID().slice(0, 8)}`,
      playbookId: playbook.id,
      sessionId,
      stage: 'triage',
      selectCount: 0,
      evidence: [],
      subagents: new Map()
    };
    runs.set(run.id, run);
    emit({ type: 'playbook/stage', runId: run.id, playbookId: playbook.id, stage: 'triage' });
    return run;
  }

  function getRun(runId: string): PlaybookRun | undefined {
    return runs.get(runId);
  }

  /**
   * 非法迁移直接 throw（IllegalStageTransitionError），不静默。
   * 除全局迁移表外，目标阶段必须在该 playbook yaml 声明的阶段集合里——
   * 所以 pb.security-triage（无 executing / awaitingApproval 阶段）
   * 永远进不了执行路径。
   */
  function advanceTo(runOrId: PlaybookRun | string, stage: StageId): PlaybookRun {
    const run = resolveRun(runOrId);
    const playbook = requirePlaybook(run.playbookId);
    const declaredStages = new Set<StageId>(playbook.stages.map((s) => s.id));
    assertTransition(run.stage, stage, declaredStages);
    const from = run.stage;
    run.stage = stage;
    emit({ type: 'playbook/stage', runId: run.id, playbookId: run.playbookId, from, stage });
    return run;
  }

  /** run 所属 playbook 声明的阶段集合（advance/close 的合法性约束）。 */
  function declaredStagesOf(run: PlaybookRun): Set<StageId> {
    return new Set<StageId>(requirePlaybook(run.playbookId).stages.map((s) => s.id));
  }

  /** 当前阶段在该 playbook 内合法的下一步（全局迁移表 ∩ yaml 声明阶段）。 */
  function legalNextStages(runOrId: PlaybookRun | string): StageId[] {
    const run = resolveRun(runOrId);
    const declared = declaredStagesOf(run);
    return STAGE_TRANSITIONS[run.stage].filter((stage) => declared.has(stage));
  }

  /**
   * 推进一步（P1-7 ops_advance_stage 的 host 接线点）：
   * - stage 给定 → 等价 advanceTo（非法迁移照常 throw）；
   * - stage 缺省 → 取合法下一步的第一项（迁移表顺序即主路径顺序，如
   *   synthesizing → reporting 优先于 awaitingApproval）；已是终态或
   *   无合法下一步时 throw IllegalStageTransitionError 语义的 Error。
   */
  function advanceStage(runOrId: PlaybookRun | string, stage?: StageId): PlaybookRun {
    const run = resolveRun(runOrId);
    if (stage !== undefined) return advanceTo(run, stage);
    const next = legalNextStages(run)[0];
    if (next === undefined) {
      throw new Error(
        `阶段 ${run.stage} 没有合法的下一步（已是终态或 playbook 未声明后续阶段），无法推进`
      );
    }
    return advanceTo(run, next);
  }

  /**
   * 收尾（P1-7 ops_close_playbook 的 host 接线点）：沿全局迁移表在该
   * playbook 声明的阶段集合内走 BFS 最短路推进到 closed，每一步都经
   * advanceTo（阶段事件逐步发出，状态机不被跳过）。已 closed 幂等返回；
   * 不可达 closed（yaml 缺 closed 或路径断裂）时 throw。
   */
  function closeRun(runOrId: PlaybookRun | string): PlaybookRun {
    const run = resolveRun(runOrId);
    if (run.stage === 'closed') return run;
    const declared = declaredStagesOf(run);
    // BFS：找 run.stage → closed 的最短合法路径。
    const cameFrom = new Map<StageId, StageId>();
    const queue: StageId[] = [run.stage];
    const seen = new Set<StageId>([run.stage]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === 'closed') break;
      for (const next of STAGE_TRANSITIONS[current]) {
        if (!declared.has(next) || seen.has(next)) continue;
        seen.add(next);
        cameFrom.set(next, current);
        queue.push(next);
      }
    }
    if (!seen.has('closed')) {
      throw new Error(
        `playbook ${run.playbookId} 从阶段 ${run.stage} 无法到达 closed（yaml 未声明必要阶段），无法收尾`
      );
    }
    const path: StageId[] = [];
    for (let stage: StageId | undefined = 'closed'; stage !== undefined && stage !== run.stage; stage = cameFrom.get(stage)) {
      path.unshift(stage);
    }
    for (const stage of path) {
      advanceTo(run, stage);
    }
    return run;
  }

  /** 当前 stage 的 yaml select 指令——由 orchestrator 代发，不让模型随便 select */
  function desiredSelect(runOrId: PlaybookRun | string): SelectDirective | undefined {
    const run = resolveRun(runOrId);
    const stageDef = currentStageDef(run);
    if (stageDef?.select === undefined) return undefined;
    return {
      mode: stageDef.select.mode,
      ...(stageDef.select.pluginIds !== undefined ? { pluginIds: [...stageDef.select.pluginIds] } : {}),
      ...(stageDef.select.names !== undefined ? { names: [...stageDef.select.names] } : {})
    };
  }

  /**
   * 当前 stage 的 yaml escalateSelect 指令（仅允许一次 add 扩面）。
   * host 决定何时升级；orchestrator 只暴露 yaml 里声明的扩面内容。
   */
  function desiredEscalateSelect(runOrId: PlaybookRun | string): EscalateSelectDirective | undefined {
    const run = resolveRun(runOrId);
    const stageDef = currentStageDef(run);
    if (stageDef?.escalateSelect === undefined) return undefined;
    return {
      mode: stageDef.escalateSelect.mode,
      ...(stageDef.escalateSelect.pluginIds !== undefined
        ? { pluginIds: [...stageDef.escalateSelect.pluginIds] }
        : {})
    };
  }

  /** runtime 实际执行了一轮 select 后登记，供 policy 的 selectCountThisTask */
  function recordSelect(runOrId: PlaybookRun | string): number {
    const run = resolveRun(runOrId);
    run.selectCount += 1;
    return run.selectCount;
  }

  /**
   * 把当前阶段的 parallelGroup 转成 TaskSpec[]（并登记 SubagentCard）。
   * 只构造卡片与 spec 数据；真正跑 LLM 在 runtime 层。
   *
   * reporting 阶段（或声明了 artifact 却没配 parallelGroup 的阶段）若缺
   * Writer，自动补一个：role writer、allowTools []（无业务工具）、
   * 产出 ops-doc，goal 指向 yaml 里点名的 artifact。
   */
  function spawnSubagentSpecs(runOrId: PlaybookRun | string): TaskSpec[] {
    const run = resolveRun(runOrId);
    const playbook = requirePlaybook(run.playbookId);
    const stageDef = currentStageDef(run);
    const group: ParallelTaskDef[] = [...(stageDef?.parallelGroup ?? [])];
    const artifact = stageDef?.artifact;
    const wantsWriter =
      run.stage === 'reporting' || (group.length === 0 && artifact !== undefined);
    if (wantsWriter && !group.some((task) => task.role === 'writer')) {
      group.push({
        id: 'writer',
        role: 'writer',
        allowTools: [],
        riskCeiling: 'read',
        goal: artifact !== undefined ? `产出 ${artifact} 工件` : '产出运维文档'
      });
    }
    const cap = Math.min(
      HARD_MAX_PARALLEL,
      options.maxParallel ?? playbook.defaults?.maxParallelInvestigators ?? DEFAULT_MAX_PARALLEL
    );

    return group.slice(0, cap).map((def) => {
      const riskCeiling: RiskLevel = def.riskCeiling ?? 'read';
      const spec: TaskSpec = {
        specVersion: 1,
        taskId: `${run.id}:${run.stage}:${def.id}`,
        sessionId: run.sessionId,
        playbookId: run.playbookId,
        stage: run.stage,
        role: def.role,
        goal: def.goal ?? def.id,
        toolPolicy: {
          select: { mode: 'inherit' },
          ...(def.allowTools !== undefined ? { allowTools: [...def.allowTools] } : {}),
          riskCeiling,
          budget: { ...DEFAULT_BUDGET },
          ...(playbook.defaults?.payloadCaps !== undefined
            ? { payloadCaps: { ...playbook.defaults.payloadCaps } }
            : {})
        },
        output: {
          contract: OUTPUT_CONTRACT_BY_ROLE[def.role],
          maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS
        },
        parallelGroup: `${run.id}:${run.stage}`,
        escalation: { retries: 1, onFail: 'degrade' }
      };

      const card: SubagentCard = {
        taskId: spec.taskId,
        role: def.role,
        label: def.goal ?? def.id,
        status: 'queued',
        riskCeiling,
        toolCalls: { used: 0, max: spec.toolPolicy.budget.maxToolCalls },
        wallMs: { used: 0, max: spec.toolPolicy.budget.maxWallMs }
      };
      run.subagents.set(spec.taskId, card);
      dispatched.set(spec.taskId, {
        runId: run.id,
        spec,
        retriesLeft: spec.escalation?.retries ?? 0
      });
      emit({ type: 'subagent/upsert', runId: run.id, card });

      return spec;
    });
  }

  /**
   * 重试阶梯（docs/04 §3.3：失败 retry 1 → degrade）。
   * 生产派发路径的 retries 由 runtime `createSubagentManager.settle` 消费；
   * 本函数保留给测试与 host 卡片登记（非 dispatch 热路径）。
   */
  function recordSubagentResult(
    taskId: string,
    status: SubagentCard['status']
  ): TaskSpec | undefined {
    const entry = dispatched.get(taskId);
    if (entry === undefined) {
      throw new Error(`Unknown subagent task ${taskId}`);
    }
    const run = resolveRun(entry.runId);
    const card = run.subagents.get(taskId);
    if (card !== undefined) {
      card.status = status;
      emit({ type: 'subagent/upsert', runId: run.id, card });
    }
    if (status !== 'failed' || entry.retriesLeft <= 0) {
      return undefined;
    }
    entry.retriesLeft -= 1;
    const retrySpec: TaskSpec = structuredClone(entry.spec);
    retrySpec.taskId = `${taskId}-retry`;
    retrySpec.escalation = { ...retrySpec.escalation, retries: entry.retriesLeft };

    const retryCard: SubagentCard = {
      taskId: retrySpec.taskId,
      role: retrySpec.role,
      label: retrySpec.goal,
      status: 'queued',
      riskCeiling: retrySpec.toolPolicy.riskCeiling,
      toolCalls: { used: 0, max: retrySpec.toolPolicy.budget.maxToolCalls },
      wallMs: { used: 0, max: retrySpec.toolPolicy.budget.maxWallMs }
    };
    run.subagents.set(retrySpec.taskId, retryCard);
    dispatched.set(retrySpec.taskId, {
      runId: run.id,
      spec: retrySpec,
      retriesLeft: entry.retriesLeft
    });
    emit({ type: 'subagent/upsert', runId: run.id, card: retryCard });

    return retrySpec;
  }

  /** 按 timeWindow 归并证据；同窗口冲突写进 note.conflicts，不静默取舍 */
  function mergeEvidence(notes: EvidenceNote[]): EvidenceNote[] {
    return mergeEvidenceNotes(notes);
  }

  /**
   * 产出 9 要素简报并进入 awaitingApproval（synthesizing 或 executing 的
   * 回滚简报路径）。commandSetSha256 由确切命令集计算，令牌与之绑定。
   */
  function requestApproval(
    runOrId: PlaybookRun | string,
    input: { risk: 'write' | 'exec'; commandSet: unknown; elements?: Record<string, string> }
  ): ApprovalBrief {
    const run = resolveRun(runOrId);
    const brief: ApprovalBrief = {
      briefId: `brief-${++briefSeq}-${randomUUID().slice(0, 8)}`,
      runId: run.id,
      risk: input.risk,
      commandSet: input.commandSet,
      commandSetSha256: hashCommandSet(input.commandSet),
      ...(input.elements !== undefined ? { elements: input.elements } : {})
    };
    if (run.stage !== 'awaitingApproval') {
      advanceTo(run, 'awaitingApproval');
    }
    run.pendingBrief = brief;
    emit({ type: 'approval/request', runId: run.id, brief });
    return brief;
  }

  /**
   * 会话审批结果落地：approved 且当前 awaitingApproval → executing；
   * rejected → reporting（拒绝或只要方案）。返回更新后的 run 与生效的简报。
   */
  function applyApproval(input: ApprovalDecisionInput): {
    run: PlaybookRun;
    brief: ApprovalBrief;
  } {
    const run = resolveRun(input.brief.runId);
    const pending = run.pendingBrief;
    if (pending === undefined || pending.briefId !== input.brief.briefId) {
      throw new Error(
        `Brief ${input.brief.briefId} 不是 run ${run.id} 的待审简报，令牌不可发放`
      );
    }
    if (input.decision === 'approved') {
      if (run.stage === 'awaitingApproval') {
        advanceTo(run, 'executing');
      }
    } else {
      run.pendingBrief = undefined;
      if (run.stage === 'awaitingApproval') {
        advanceTo(run, 'reporting');
      }
    }
    emit({
      type: 'approval/resolved',
      runId: run.id,
      briefId: pending.briefId,
      decision: input.decision
    });
    return { run, brief: pending };
  }

  return {
    startPlaybook,
    getRun,
    advanceTo,
    advanceStage,
    legalNextStages,
    closeRun,
    desiredSelect,
    desiredEscalateSelect,
    recordSelect,
    spawnSubagentSpecs,
    recordSubagentResult,
    mergeEvidence,
    requestApproval,
    applyApproval,
    get playbooks(): readonly Playbook[] {
      return options.playbooks;
    }
  };
}
