/**
 * 子代理派发（ops_dispatch_subagent）：TaskSpec 校验、工具白名单过滤、
 * 并行调度（investigator ≤4、exec 并行度 =1）、Abort 级联与输出契约解析。
 *
 * 本文件不依赖 pi SDK（也不 import vscode）：真正跑 LLM 的 runner 由
 * src/runtime/session-factory.ts 注入，因此可以在 vitest 中用假 runner 单测调度语义。
 * 仅主会话注册 ops_dispatch_subagent / ops_check_subagent；子会话不注册
 * （禁止递归派发与收割，docs/03 §2）。
 */
import { randomUUID } from 'node:crypto';

import { mergeEvidence, type EvidenceNote, type RiskLevel, type SubagentRole, type TaskSpec } from '../orchestrator';
import type { AgentToolDescriptor } from '../protocol';
import { isBusinessToolName } from './discovery-tools';
import type { OpsCustomToolSpec } from './resource-loader';

// ── 常量 ─────────────────────────────────────────────────────────────────

export const DISPATCH_TOOL_NAME = 'ops_dispatch_subagent';

/** 只读收割子代理终态；仅主会话注册（与 dispatch 一样禁止递归）。 */
export const CHECK_SUBAGENT_TOOL_NAME = 'ops_check_subagent';

/** 子代理摘要截断上限（≈800 token，按字符近似；docs/04 §3.3）。 */
export const SUBAGENT_SUMMARY_CHAR_LIMIT = 3200;

/** 角色并行上限：investigator 硬顶 4；exec 并行度 1（docs/04 §3.3）。 */
export const ROLE_PARALLEL_LIMITS: Readonly<Record<SubagentRole, number>> = {
  investigator: 4,
  executor: 1,
  writer: 2,
  verifier: 2
};

export const DEFAULT_SUBAGENT_BUDGET: Readonly<TaskSpec['toolPolicy']['budget']> = {
  maxToolCalls: 15,
  maxWallMs: 180_000
};

const MAX_TOOL_CALLS = 40;
const MIN_WALL_MS = 1000;

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { read: 0, write: 1, exec: 2 };

const ROLES: readonly SubagentRole[] = ['investigator', 'executor', 'writer', 'verifier'];

const OUTPUT_CONTRACT_BY_ROLE: Readonly<Record<SubagentRole, TaskSpec['output']['contract']>> = {
  investigator: 'evidence-note@1',
  executor: 'exec-report@1',
  verifier: 'verify-report@1',
  writer: 'ops-doc'
};

/** 这些契约要求消息末尾出现 fenced JSON（ops-doc 是自由 markdown，不要求）。 */
const JSON_CONTRACTS: ReadonlySet<TaskSpec['output']['contract']> = new Set([
  'evidence-note@1',
  'exec-report@1',
  'verify-report@1'
]);

// ── 派发参数（TaskSpec 子集）与校验 ─────────────────────────────────────

export interface SubagentDispatchInput {
  role: SubagentRole;
  goal: string;
  riskCeiling: RiskLevel;
  allowTools?: string[];
  budget?: Partial<TaskSpec['toolPolicy']['budget']>;
  approvalToken?: TaskSpec['approvalToken'];
  plan?: TaskSpec['plan'];
  inputs?: TaskSpec['inputs'];
  taskId?: string;
  sessionId?: string;
  playbookId?: string;
  stage?: string;
  /**
   * 可选。最多等待该任务这么多毫秒；到期返回 `{status:'running', taskId}`，
   * runner 继续在 manager 内跑。缺省不传 = 阻塞到终态。
   * 不写入 TaskSpec（dispatch schema 有，buildTaskSpec 忽略）。
   */
  waitMs?: number;
}

function normalizeInputs(raw: unknown): TaskSpec['inputs'] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const out: NonNullable<TaskSpec['inputs']> = {};
  const tw = rec.timeWindow;
  if (tw !== null && typeof tw === 'object' && !Array.isArray(tw)) {
    const window = tw as Record<string, unknown>;
    if (typeof window.from === 'string' && typeof window.to === 'string') {
      out.timeWindow = { from: window.from, to: window.to };
    }
  }
  if (Array.isArray(rec.targets)) {
    const targets: Array<{ kind: string; id: string }> = [];
    for (const item of rec.targets) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const t = item as Record<string, unknown>;
      if (typeof t.kind === 'string' && typeof t.id === 'string') {
        targets.push({ kind: t.kind, id: t.id });
      }
    }
    if (targets.length > 0) out.targets = targets;
  }
  if (Array.isArray(rec.contextNotes)) {
    const notes = rec.contextNotes.filter((n): n is string => typeof n === 'string');
    if (notes.length > 0) out.contextNotes = notes;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeTaskInputs(
  inherited: TaskSpec['inputs'] | undefined,
  own: unknown
): TaskSpec['inputs'] | undefined {
  const a = inherited;
  const b = normalizeInputs(own);
  if (a === undefined && b === undefined) return undefined;
  return { ...a, ...b };
}

/** 兼容完整 TaskSpec（orchestrator spawnSubagentSpecs 产物）与工具参数子集。 */
export function normalizeDispatchInput(input: SubagentDispatchInput | TaskSpec): SubagentDispatchInput {
  if (!('toolPolicy' in input)) {
    const inputs = normalizeInputs(input.inputs);
    const next: SubagentDispatchInput = { ...input };
    if (inputs === undefined) {
      delete next.inputs;
    } else {
      next.inputs = inputs;
    }
    return next;
  }
  const spec = input;
  const inputs = normalizeInputs(spec.inputs);
  return {
    role: spec.role,
    goal: spec.goal,
    riskCeiling: spec.toolPolicy.riskCeiling,
    ...(spec.toolPolicy.allowTools !== undefined ? { allowTools: [...spec.toolPolicy.allowTools] } : {}),
    budget: { ...spec.toolPolicy.budget },
    ...(spec.approvalToken !== undefined && spec.approvalToken !== null
      ? { approvalToken: spec.approvalToken }
      : {}),
    ...(spec.plan !== undefined ? { plan: spec.plan } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    ...(spec.playbookId !== undefined ? { playbookId: spec.playbookId } : {}),
    ...(spec.stage !== undefined ? { stage: spec.stage } : {})
  };
}

export type BuildTaskSpecOutcome = { ok: true; spec: TaskSpec } | { ok: false; error: string };

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * 把派发参数补全成完整 TaskSpec 并校验角色规则（docs/04 §3.1）：
 * - Investigator 的 riskCeiling 必须是 read（硬顶，违规直接拒绝）；
 * - Executor 必须携带 approvalToken.briefId（引用已批 9 要素简报）。
 *   commandSetSha256 由 host 在批准时计算并绑定——模型不自行计算哈希，
 *   因此这里不强制要求（带了就透传，host/policy 侧照常校验一致性）；
 * - Writer 没有业务工具（allowTools 强制清空，riskCeiling 收紧为 read）；
 * - Verifier 只读（riskCeiling 静默收紧为 read）。
 */
export function buildTaskSpec(input: SubagentDispatchInput): BuildTaskSpecOutcome {
  if (!ROLES.includes(input.role)) {
    return {
      ok: false,
      error: `未知子代理角色 ${JSON.stringify(input.role)}；只支持 ${ROLES.join(' / ')}`
    };
  }
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (goal.length === 0) {
    return { ok: false, error: 'goal 不能为空：写清楚这次子任务要取证/执行/验证/撰写什么' };
  }
  if (!(input.riskCeiling in RISK_RANK)) {
    return { ok: false, error: `未知 riskCeiling ${JSON.stringify(input.riskCeiling)}；只支持 read / write / exec` };
  }
  if (input.role === 'investigator' && input.riskCeiling !== 'read') {
    return { ok: false, error: 'Investigator 的 riskCeiling 必须是 read（只读硬顶，不能派发 write/exec 调查）' };
  }
  let approvalToken = input.approvalToken ?? undefined;
  if (input.role === 'executor') {
    if (
      approvalToken === undefined ||
      approvalToken === null ||
      typeof approvalToken.briefId !== 'string' ||
      approvalToken.briefId.length === 0
    ) {
      return {
        ok: false,
        error:
          'Executor 必须携带 approvalToken.briefId（引用已批的 9 要素简报；' +
          'commandSetSha256 由 host 批准时计算绑定，不要自行计算哈希）'
      };
    }
  } else {
    approvalToken = undefined;
  }

  // Writer 无业务工具；Verifier 只读（静默收紧而非报错）。
  const riskCeiling: RiskLevel =
    input.role === 'writer' || input.role === 'verifier' ? 'read' : input.riskCeiling;
  const allowTools =
    input.role === 'writer'
      ? []
      : input.allowTools?.filter((name) => typeof name === 'string' && name.length > 0);

  const budget: TaskSpec['toolPolicy']['budget'] = {
    maxToolCalls: clampInt(input.budget?.maxToolCalls, 1, MAX_TOOL_CALLS, DEFAULT_SUBAGENT_BUDGET.maxToolCalls),
    maxWallMs: clampInt(
      input.budget?.maxWallMs,
      MIN_WALL_MS,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_SUBAGENT_BUDGET.maxWallMs
    )
  };

  const taskId =
    typeof input.taskId === 'string' && input.taskId.length > 0
      ? input.taskId
      : `sub-${input.role}-${randomUUID().slice(0, 8)}`;

  const spec: TaskSpec = {
    specVersion: 1,
    taskId,
    sessionId: typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : 'main',
    ...(input.playbookId !== undefined ? { playbookId: input.playbookId } : {}),
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    role: input.role,
    goal,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    toolPolicy: {
      select: { mode: 'inherit' },
      ...(allowTools !== undefined ? { allowTools } : {}),
      riskCeiling,
      budget
    },
    ...(approvalToken !== undefined ? { approvalToken } : {}),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    output: { contract: OUTPUT_CONTRACT_BY_ROLE[input.role], maxSummaryTokens: 800 },
    escalation: { retries: 1, onFail: 'degrade' }
  };
  return { ok: true, spec };
}

// ── 工具面过滤 ───────────────────────────────────────────────────────────

/**
 * 子代理可见工具（调用方传入 hub.listExposedTools() 暴露集）：
 * - Writer 恒为空（无业务工具面）；
 * - allowTools 为非空清单时：显式点名的业务工具必须注入，即使其声明
 *   risk 超过 riskCeiling——否则 run_remote_command（声明 risk=exec）
 *   永远进不了 investigator（ceiling=read）的工具面，只读巡检无从下手。
 *   越线调用仍由 policy 闸在每次 tools/call 时兜底（只读命令按推断
 *   risk=read 放行，见 src/policy inferEffectiveRisk）；
 * - allowTools 缺省（未点名）时：按 riskCeiling 过滤全部业务工具。
 * 即「点名 = allowlist ∩ hub exposed」「未点名 = hub exposed ∩ riskCeiling」。
 */
export function filterToolsForSubagent(
  tools: readonly AgentToolDescriptor[],
  spec: Pick<TaskSpec, 'role' | 'toolPolicy'>
): AgentToolDescriptor[] {
  if (spec.role === 'writer') return [];
  const allow = spec.toolPolicy.allowTools;
  if (allow !== undefined && allow.length > 0) {
    return tools.filter((tool) => isBusinessToolName(tool.name) && allow.includes(tool.name));
  }
  const ceiling = RISK_RANK[spec.toolPolicy.riskCeiling] ?? 0;
  return tools.filter(
    (tool) =>
      isBusinessToolName(tool.name) &&
      RISK_RANK[tool.risk] <= ceiling &&
      (allow === undefined || allow.includes(tool.name))
  );
}

// ── 输出契约解析 ─────────────────────────────────────────────────────────

const FENCED_BLOCK_RE = /```[a-zA-Z]*[ \t]*\n?([\s\S]*?)```/g;

export type ContractJson = Record<string, unknown> & { contract: string };

function tryParseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 非 JSON 内容，继续尝试其它候选块。
  }
  return undefined;
}

/** 从消息文本中解析契约 JSON：优先取最后一个 fenced 块，兜底整段裸 JSON。 */
export function parseContractJson(text: string): ContractJson | undefined {
  const blocks = [...text.matchAll(FENCED_BLOCK_RE)].map((m) => m[1]);
  blocks.unshift(text); // 整条消息就是裸 JSON 的情况（优先级最低，放队首）
  for (let i = blocks.length - 1; i >= 0; i--) {
    const value = tryParseObject(blocks[i]);
    if (value !== undefined && typeof value.contract === 'string') {
      return value as ContractJson;
    }
  }
  return undefined;
}

function isEvidenceConfidence(value: unknown): value is EvidenceNote['confidence'] {
  return value === 'confirmed' || value === 'hypothesis' || value === 'pending';
}

/**
 * 宽松兜底：contract 字段整个缺失、但 confidence+summary 形状完整的 JSON 块
 * 也接受（settle 仍按「缺契约块」标 degraded，但摘要/便签不丢）。
 * 写了 contract 却不是 evidence-note@1 的块不算（那是别的契约）。
 */
function parseLooseEvidenceJson(text: string): Record<string, unknown> | undefined {
  const blocks = [...text.matchAll(FENCED_BLOCK_RE)].map((m) => m[1]);
  blocks.unshift(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const value = tryParseObject(blocks[i]);
    if (
      value !== undefined &&
      value.contract === undefined &&
      isEvidenceConfidence(value.confidence) &&
      typeof value.summary === 'string' &&
      value.summary.length > 0
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * 解析 evidence-note@1；形状不完整（缺 confidence/summary）返回 undefined。
 * contract 字段缺失但 confidence+summary 完整时宽松接受（见 parseLooseEvidenceJson）。
 */
export function parseEvidenceNote(text: string, fallbackTaskId = ''): EvidenceNote | undefined {
  const strict = parseContractJson(text);
  const json =
    strict !== undefined
      ? strict.contract === 'evidence-note@1'
        ? strict
        : undefined
      : parseLooseEvidenceJson(text);
  if (json === undefined) return undefined;
  const confidence = json.confidence;
  if (!isEvidenceConfidence(confidence)) {
    return undefined;
  }
  if (typeof json.summary !== 'string' || json.summary.length === 0) return undefined;
  const taskId = typeof json.taskId === 'string' && json.taskId.length > 0 ? json.taskId : fallbackTaskId;
  const rawWindow = json.timeWindow;
  const timeWindow =
    rawWindow !== null &&
    typeof rawWindow === 'object' &&
    typeof (rawWindow as { from?: unknown }).from === 'string' &&
    typeof (rawWindow as { to?: unknown }).to === 'string'
      ? (rawWindow as { from: string; to: string })
      : undefined;
  return {
    id: typeof json.id === 'string' && json.id.length > 0 ? json.id : `note-${taskId}`,
    taskId,
    confidence,
    summary: json.summary,
    ...(timeWindow !== undefined ? { timeWindow } : {}),
    ...(typeof json.subject === 'string' ? { subject: json.subject } : {}),
    ...(Array.isArray(json.refs) ? { refs: json.refs as EvidenceNote['refs'] } : {}),
    conflicts: Array.isArray(json.conflicts)
      ? json.conflicts.filter((c): c is string => typeof c === 'string')
      : []
  };
}

export function truncateSummary(text: string, limit = SUBAGENT_SUMMARY_CHAR_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

// ── 调度器 ───────────────────────────────────────────────────────────────

export type SubagentRunStatus = 'queued' | 'running' | 'ok' | 'degraded' | 'failed' | 'aborted';

export interface SubagentStatusEvent {
  taskId: string;
  role: SubagentRole;
  status: SubagentRunStatus;
  /** 终态时的摘要（≤SUBAGENT_SUMMARY_CHAR_LIMIT 字符；原始大输出不进事件）。 */
  summary?: string;
  error?: string;
  /** output.contract=evidence-note@1 且解析成功时附上结构化便签。 */
  evidenceNote?: EvidenceNote;
  steps?: Array<{
    id: string;
    title: string;
    type: 'thinking' | 'tool' | 'output';
    status: 'running' | 'ok' | 'error';
    detail?: string;
    durationMs?: number;
  }>;
  logs?: string[];
  currentActivity?: string;
  toolCalls?: { used: number; max: number };
  wallMs?: { used: number; max: number };
}

export interface SubagentRunOutcome {
  /** 子代理最后一条 assistant 消息文本（契约 JSON 应在其中）。 */
  finalText: string;
  /** runner 主动降级的原因（如超出 maxToolCalls 预算被中止）。 */
  degradedReason?: string;
}

export type SubagentRunner = (spec: TaskSpec, signal: AbortSignal) => Promise<SubagentRunOutcome>;

/** 终态状态子集（waitFor / ops_dispatch_subagent 阻塞结果）。 */
export type SubagentTerminalStatus = Extract<
  SubagentRunStatus,
  'ok' | 'degraded' | 'failed' | 'aborted'
>;

/** 单个子代理任务的终态摘要（P1-6：ops_dispatch_subagent 的工具结果单元）。 */
export interface SubagentFinalResult {
  taskId: string;
  role: SubagentRole;
  status: SubagentTerminalStatus;
  /** ≤SUBAGENT_SUMMARY_CHAR_LIMIT 字符摘要；原始大输出不进结果。 */
  summary?: string;
  error?: string;
  /** evidence-note@1 解析成功时的结构化便签。 */
  evidenceNote?: EvidenceNote;
}

export interface CreateSubagentManagerOptions {
  runner: SubagentRunner;
  onStatus?: (event: SubagentStatusEvent) => void;
  /** 覆盖默认角色并行上限（测试用；investigator 仍不应超过硬顶 4）。 */
  limits?: Partial<Record<SubagentRole, number>>;
}

export interface SubagentManager {
  /** 立即返回（queued|running），LLM 在后台跑；重复 taskId 且未终态时幂等返回现状。 */
  dispatch(spec: TaskSpec): { taskId: string; status: SubagentRunStatus };
  /**
   * 阻塞到任务终态并返回终态摘要（P1-6：ops_dispatch_subagent 的 execute
   * 用它挂起）。已终态立即 resolve；未知 taskId reject。
   */
  waitFor(taskId: string): Promise<SubagentFinalResult>;
  /** 中止单个任务（AbortSignal 级联到子会话）；不存在或已终态返回 false。 */
  abort(taskId: string): boolean;
  abortAll(): void;
  inflight(role?: SubagentRole): number;
  statusOf(taskId: string): SubagentRunStatus | undefined;
}

interface TaskRecord {
  spec: TaskSpec;
  controller: AbortController;
  status: SubagentRunStatus;
  timer?: ReturnType<typeof setTimeout>;
  userAborted?: boolean;
  timedOut?: boolean;
  /** 本记录是 settle 自动重试出来的（taskId 含 -retry）。 */
  retried?: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<SubagentRunStatus> = new Set([
  'ok',
  'degraded',
  'failed',
  'aborted'
]);

export function createSubagentManager(options: CreateSubagentManagerOptions): SubagentManager {
  const records = new Map<string, TaskRecord>();
  /** 仅 queued 状态的等待队列（FIFO）。 */
  const queue: TaskRecord[] = [];
  /** 终态结果登记（waitFor 的真源；不清理——单会话任务量有限）。 */
  const finals = new Map<string, SubagentFinalResult>();
  const waiters = new Map<string, Array<(result: SubagentFinalResult) => void>>();
  /** 原 taskId → 重试 taskId；waitFor / abort / statusOf 跟随。 */
  const aliases = new Map<string, string>();

  function resolveTaskId(taskId: string): string {
    let id = taskId;
    const seen = new Set<string>();
    while (aliases.has(id) && !seen.has(id)) {
      seen.add(id);
      id = aliases.get(id)!;
    }
    return id;
  }

  const limitOf = (role: SubagentRole): number => options.limits?.[role] ?? ROLE_PARALLEL_LIMITS[role];

  function runningCount(role: SubagentRole): number {
    let n = 0;
    for (const record of records.values()) {
      if (record.status === 'running' && record.spec.role === role) n += 1;
    }
    return n;
  }

  function emit(
    record: TaskRecord,
    extra: Pick<SubagentStatusEvent, 'summary' | 'error' | 'evidenceNote'> = {}
  ): void {
    options.onStatus?.({
      taskId: record.spec.taskId,
      role: record.spec.role,
      status: record.status,
      ...extra
    });
  }

  function settle(record: TaskRecord, result: { outcome?: SubagentRunOutcome; failure?: unknown }): void {
    if (TERMINAL_STATUSES.has(record.status)) return;
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    const retriesLeft = record.spec.escalation?.retries ?? 0;
    const canRetry =
      !record.userAborted &&
      !record.timedOut &&
      result.failure !== undefined &&
      retriesLeft > 0;
    if (canRetry) {
      record.status = 'failed';
      const retrySpec: TaskSpec = {
        ...record.spec,
        taskId: `${record.spec.taskId}-retry`,
        escalation: {
          retries: retriesLeft - 1,
          onFail: record.spec.escalation?.onFail ?? 'degrade'
        }
      };
      aliases.set(record.spec.taskId, retrySpec.taskId);
      const pending = waiters.get(record.spec.taskId);
      if (pending !== undefined) {
        waiters.delete(record.spec.taskId);
        const existing = waiters.get(retrySpec.taskId);
        waiters.set(retrySpec.taskId, existing === undefined ? pending : [...existing, ...pending]);
      }
      emit(record, {
        error: result.failure instanceof Error ? result.failure.message : String(result.failure)
      });
      // 插到队首，立刻占用刚释放的角色并行位；超时不走这条路径。
      const retryRecord: TaskRecord = {
        spec: retrySpec,
        controller: new AbortController(),
        status: 'queued',
        retried: true
      };
      records.set(retrySpec.taskId, retryRecord);
      queue.unshift(retryRecord);
      emit(retryRecord);
      pump();
      return;
    }
    let extra: Pick<SubagentStatusEvent, 'summary' | 'error' | 'evidenceNote'> = {};
    if (record.userAborted) {
      record.status = 'aborted';
    } else if (record.timedOut) {
      record.status = 'failed';
      extra = { error: `超出 maxWallMs=${record.spec.toolPolicy.budget.maxWallMs} 预算（超时中止）` };
    } else if (result.failure !== undefined) {
      record.status = 'failed';
      extra = { error: result.failure instanceof Error ? result.failure.message : String(result.failure) };
    } else {
      const outcome = result.outcome ?? { finalText: '' };
      const contract = record.spec.output.contract;
      const note =
        contract === 'evidence-note@1'
          ? parseEvidenceNote(outcome.finalText, record.spec.taskId)
          : undefined;
      const contractJson = parseContractJson(outcome.finalText);
      const summary = truncateSummary(note?.summary ?? outcome.finalText);
      if (outcome.degradedReason !== undefined) {
        record.status = 'degraded';
        extra = { summary, error: outcome.degradedReason, ...(note !== undefined ? { evidenceNote: note } : {}) };
      } else if (JSON_CONTRACTS.has(contract) && contractJson?.contract !== contract) {
        // 契约 JSON 缺失：结果仍可用但标 degraded（该面按未完整取证处理）。
        // 宽松解析出的便签（contract 字段缺失但 confidence+summary 完整）
        // 照常附上——摘要与结构化证据不因缺契约头而丢失。
        record.status = 'degraded';
        extra = {
          summary,
          error: `输出缺少 ${contract} JSON 契约块`,
          ...(note !== undefined ? { evidenceNote: note } : {})
        };
      } else {
        record.status = 'ok';
        extra = { summary, ...(note !== undefined ? { evidenceNote: note } : {}) };
      }
    }
    if (record.retried === true && record.status === 'failed' && extra.error !== undefined) {
      extra = { ...extra, error: `${extra.error}（已重试 1 次）` };
    }
    const final: SubagentFinalResult = {
      taskId: record.spec.taskId,
      role: record.spec.role,
      status: record.status as SubagentTerminalStatus,
      ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.evidenceNote !== undefined ? { evidenceNote: extra.evidenceNote } : {})
    };
    finals.set(final.taskId, final);
    const pending = waiters.get(final.taskId);
    if (pending !== undefined) {
      waiters.delete(final.taskId);
      for (const resolve of pending) resolve(final);
    }
    emit(record, extra);
    pump();
  }

  function start(record: TaskRecord): void {
    record.status = 'running';
    emit(record);
    record.timer = setTimeout(() => {
      record.timedOut = true;
      record.controller.abort();
      settle(record, {});
    }, record.spec.toolPolicy.budget.maxWallMs);
    let runPromise: Promise<SubagentRunOutcome>;
    try {
      runPromise = options.runner(record.spec, record.controller.signal);
    } catch (failure) {
      settle(record, { failure });
      return;
    }
    runPromise.then(
      (outcome) => settle(record, { outcome }),
      (failure: unknown) => settle(record, { failure })
    );
  }

  function pump(): void {
    for (let i = 0; i < queue.length; ) {
      const record = queue[i];
      if (record.status !== 'queued') {
        queue.splice(i, 1);
        continue;
      }
      if (runningCount(record.spec.role) >= limitOf(record.spec.role)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      start(record);
    }
  }

  function abort(taskId: string): boolean {
    const record = records.get(resolveTaskId(taskId));
    if (record === undefined || TERMINAL_STATUSES.has(record.status)) return false;
    record.userAborted = true;
    record.controller.abort();
    // 立即终态并释放并行位；runner 稍后落定时被 settle 的终态守卫忽略。
    settle(record, {});
    return true;
  }

  return {
    dispatch(spec: TaskSpec) {
      const existing = records.get(spec.taskId);
      if (existing !== undefined && !TERMINAL_STATUSES.has(existing.status)) {
        return { taskId: spec.taskId, status: existing.status };
      }
      const record: TaskRecord = { spec, controller: new AbortController(), status: 'queued' };
      records.set(spec.taskId, record);
      queue.push(record);
      emit(record);
      pump();
      return { taskId: spec.taskId, status: record.status };
    },
    waitFor(taskId: string): Promise<SubagentFinalResult> {
      const resolved = resolveTaskId(taskId);
      const record = records.get(resolved) ?? records.get(taskId);
      if (record === undefined) {
        return Promise.reject(new Error(`未知子代理任务 ${taskId}`));
      }
      const waitId = record.spec.taskId;
      if (TERMINAL_STATUSES.has(record.status)) {
        const final = finals.get(waitId);
        if (final !== undefined) return Promise.resolve(final);
      }
      return new Promise((resolve) => {
        const list = waiters.get(waitId);
        if (list === undefined) {
          waiters.set(waitId, [resolve]);
        } else {
          list.push(resolve);
        }
      });
    },
    abort,
    abortAll(): void {
      for (const taskId of [...records.keys()]) {
        abort(taskId);
      }
    },
    inflight(role?: SubagentRole): number {
      if (role !== undefined) return runningCount(role);
      let n = 0;
      for (const record of records.values()) {
        if (record.status === 'running') n += 1;
      }
      return n;
    },
    statusOf(taskId: string): SubagentRunStatus | undefined {
      return records.get(resolveTaskId(taskId))?.status;
    }
  };
}

// ── ops_dispatch_subagent：阻塞式工具调用（P1-6）──────────────────────────

/** 单个 tasks[] 元素 / 单任务调用的结果（工具结果 JSON 的单元）。 */
export interface DispatchToolTaskResult {
  taskId: string;
  role?: SubagentRole;
  /** rejected = spec 校验失败；running = waitMs 到期且任务仍在 manager 内跑。 */
  status: SubagentTerminalStatus | 'rejected' | 'running';
  summary?: string;
  error?: string;
  evidenceNote?: EvidenceNote;
}

/** 一次 ops_dispatch_subagent 最多并行派发的任务数（与 investigator 硬顶一致）。 */
export const MAX_DISPATCH_TASKS = 4;

function finalToTaskResult(final: SubagentFinalResult): DispatchToolTaskResult {
  return {
    taskId: final.taskId,
    role: final.role,
    status: final.status,
    ...(final.summary !== undefined ? { summary: final.summary } : {}),
    ...(final.error !== undefined ? { error: final.error } : {}),
    ...(final.evidenceNote !== undefined ? { evidenceNote: final.evidenceNote } : {})
  };
}

/** waitMs ≥ 0 才生效；负数 / NaN / 非数字 = 缺省阻塞。 */
function parseWaitMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.floor(raw);
}

/**
 * waitMs 到期返回 `'running'`（runner 继续）；否则返回 waitFor 终态。
 * 已终态的微任务优先于 setTimeout，不会把刚完成的任务误报 running。
 */
async function waitForOrRunning(
  manager: Pick<SubagentManager, 'waitFor'>,
  taskId: string,
  waitMs: number
): Promise<SubagentFinalResult | { status: 'running' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs);
  });
  try {
    const winner = await Promise.race([manager.waitFor(taskId), timeout]);
    if (winner === 'timeout') return { status: 'running' };
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runOneDispatchTask(
  raw: unknown,
  manager: Pick<SubagentManager, 'dispatch' | 'waitFor'>,
  inheritedInputs?: TaskSpec['inputs'],
  inheritedWaitMs?: number
): Promise<DispatchToolTaskResult> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      taskId: '',
      status: 'rejected',
      error: '任务必须是对象（至少包含 role / goal / riskCeiling）'
    };
  }
  const input = raw as SubagentDispatchInput;
  const mergedInputs = mergeTaskInputs(inheritedInputs, input.inputs);
  const normalized = normalizeDispatchInput(
    mergedInputs === undefined ? input : { ...input, inputs: mergedInputs }
  );
  const built = buildTaskSpec(normalized);
  if (!built.ok) {
    return {
      taskId: typeof input.taskId === 'string' ? input.taskId : '',
      ...(typeof input.role === 'string' ? { role: input.role } : {}),
      status: 'rejected',
      error: built.error
    };
  }
  manager.dispatch(built.spec);
  const waitMs = parseWaitMs(normalized.waitMs) ?? inheritedWaitMs;
  try {
    if (waitMs === undefined) {
      return finalToTaskResult(await manager.waitFor(built.spec.taskId));
    }
    const raced = await waitForOrRunning(manager, built.spec.taskId, waitMs);
    if (raced.status === 'running') {
      return { taskId: built.spec.taskId, role: built.spec.role, status: 'running' };
    }
    return finalToTaskResult(raced);
  } catch (error) {
    return {
      taskId: built.spec.taskId,
      role: built.spec.role,
      status: 'rejected',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function applyMergedEvidence(tasks: DispatchToolTaskResult[]): DispatchToolTaskResult[] {
  const notes = tasks
    .map((task) => task.evidenceNote)
    .filter((note): note is EvidenceNote => note !== undefined);
  if (notes.length === 0) return tasks;
  const merged = mergeEvidence(notes);
  const byId = new Map(merged.map((note) => [note.id, note]));
  return tasks.map((task) => {
    if (task.evidenceNote === undefined) return task;
    const next = byId.get(task.evidenceNote.id);
    return next === undefined ? task : { ...task, evidenceNote: next };
  });
}

/**
 * ops_dispatch_subagent 的 execute 主体（P1-6 缺省阻塞式）：
 * - 单任务（顶层 role/goal/riskCeiling）→ 阻塞到终态，返回单个结果 JSON；
 * - tasks[]（并行数组）→ 全部派发后等全部返回，返回 { tasks: [...] } JSON；
 * - 可选 waitMs：到期该任务返回 `{status:'running', taskId}`，runner 继续；
 *   缺省不传 = 今日 Promise.all 阻塞语义。收割用 ops_check_subagent。
 * - spec 校验失败的任务标 status='rejected'，不影响其余任务；
 * - 结果绝不 throw：拒绝/失败都是结构化 JSON（模型自行处理）。
 * - Promise.all 之后 mergeEvidence：同窗冲突写回各任务 evidenceNote.conflicts。
 * 摘要 ≤SUBAGENT_SUMMARY_CHAR_LIMIT 字符；原始大输出不回主会话（无 prompt 回灌）。
 */
export async function runDispatchToolCall(
  args: Record<string, unknown>,
  manager: Pick<SubagentManager, 'dispatch' | 'waitFor'>
): Promise<string> {
  const inheritedInputs = normalizeInputs(args.inputs);
  const inheritedWaitMs = parseWaitMs(args.waitMs);
  const rawTasks = args.tasks;
  if (rawTasks !== undefined) {
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return JSON.stringify({
        ok: false,
        error: 'tasks 必须是非空数组；单任务请直接给顶层 role / goal / riskCeiling'
      });
    }
    if (rawTasks.length > MAX_DISPATCH_TASKS) {
      return JSON.stringify({
        ok: false,
        error: `tasks 一次最多 ${MAX_DISPATCH_TASKS} 个（收到 ${rawTasks.length}）；请分批派发`
      });
    }
    const tasks = await Promise.all(
      rawTasks.map((raw) => runOneDispatchTask(raw, manager, inheritedInputs, inheritedWaitMs))
    );
    return JSON.stringify({ tasks: applyMergedEvidence(tasks) });
  }
  const [one] = applyMergedEvidence([await runOneDispatchTask(args, manager)]);
  return JSON.stringify(one);
}

/**
 * ops_check_subagent 的 execute 主体：只读收割终态。
 * 未知 taskId 用 statusOf 判空后返回结构化 JSON（不 throw）；
 * 已知任务走 waitFor，阻塞到终态，返回与 dispatch 同款摘要。
 */
export async function runCheckSubagentToolCall(
  args: Record<string, unknown>,
  manager: Pick<SubagentManager, 'waitFor' | 'statusOf'>
): Promise<string> {
  const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (taskId.length === 0) {
    return JSON.stringify({ ok: false, error: 'taskId 不能为空' });
  }
  if (manager.statusOf(taskId) === undefined) {
    return JSON.stringify({ ok: false, taskId, error: `未知子代理任务 ${taskId}` });
  }
  try {
    return JSON.stringify(finalToTaskResult(await manager.waitFor(taskId)));
  } catch (error) {
    return JSON.stringify({
      ok: false,
      taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** 仅主会话注册的只读收割工具（子会话不注册，禁止递归）。 */
export function createCheckSubagentTool(
  manager: Pick<SubagentManager, 'waitFor' | 'statusOf'>
): OpsCustomToolSpec {
  return {
    name: CHECK_SUBAGENT_TOOL_NAME,
    label: 'Ops：收割子代理',
    description:
      '查询并收割 ops_dispatch_subagent 派发的子代理终态（只读）。' +
      '参数 {taskId}：dispatch 返回的任务 id（含 waitMs 早返的 running 任务）。' +
      '工具结果与 dispatch 同款摘要 JSON（status: ok|degraded|failed|aborted + summary）。' +
      '未知 taskId 返回结构化错误，不抛错。仅主会话可用，子代理禁止调用。',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'ops_dispatch_subagent 返回的 taskId'
        }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    risk: 'read',
    execute: (args) => runCheckSubagentToolCall(args, manager)
  };
}

// ── ops_dispatch_subagent 工具 spec（execute 由 runtime 注入 manager 后包装） ──

const DISPATCH_TASK_PROPERTIES: Record<string, unknown> = {
  role: {
    type: 'string',
    enum: ['investigator', 'executor', 'writer', 'verifier'],
    description: '子代理角色'
  },
  goal: { type: 'string', description: '本次子任务目标（一句话，含对象与时间窗）' },
  riskCeiling: {
    type: 'string',
    enum: ['read', 'write', 'exec'],
    description: 'investigator/verifier/writer 必须 read；executor 按已批简报'
  },
  allowTools: {
    type: 'array',
    items: { type: 'string' },
    description:
      '工具白名单（与 Hub 暴露集取交集）。点名的工具会被实际注入子会话，' +
      '不会被 riskCeiling 滤掉（越线调用仍由 policy 按命令内容裁决）；' +
      '未点名时按 riskCeiling 过滤全部业务工具'
  },
  budget: {
    type: 'object',
    properties: {
      maxToolCalls: {
        type: 'integer',
        description: `默认 ${DEFAULT_SUBAGENT_BUDGET.maxToolCalls}，最大 ${MAX_TOOL_CALLS}`
      },
      maxWallMs: { type: 'integer', description: `默认 ${DEFAULT_SUBAGENT_BUDGET.maxWallMs}` }
    },
    additionalProperties: false
  },
  approvalToken: {
    type: 'object',
    properties: {
      briefId: { type: 'string', description: '已批 9 要素简报 id' },
      commandSetSha256: {
        type: 'string',
        description: '可选；host 批准时计算绑定，不要自行计算哈希'
      }
    },
    required: ['briefId'],
    additionalProperties: false,
    description: 'executor 必填：引用已批 9 要素简报（briefId）；哈希由 host 绑定'
  },
  plan: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        step: { type: 'integer' },
        kind: {
          type: 'string',
          enum: ['backup', 'verifyBackup', 'change', 'readback', 'verify', 'other']
        },
        tool: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'object' }
      },
      required: ['step', 'kind', 'tool'],
      additionalProperties: false
    },
    description: 'executor 的确切执行步骤（与已批命令集一致）'
  },
  inputs: {
    type: 'object',
    additionalProperties: false,
    description: '取证窗口与目标（并行 tasks[] 必须给同一 timeWindow）',
    properties: {
      timeWindow: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' }
        }
      },
      targets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            id: { type: 'string' }
          },
          required: ['kind', 'id']
        }
      },
      contextNotes: { type: 'array', items: { type: 'string' } }
    }
  },
  waitMs: {
    type: 'number',
    description:
      '可选。最多等待该任务这么多毫秒；到期返回 {status:running, taskId}，' +
      '子代理继续在调度器内跑。缺省不传 = 阻塞到终态。' +
      '收割终态用 ops_check_subagent {taskId}。不要把 payloadCaps 放进参数。'
  }
};

export const dispatchToolSpec = {
  name: DISPATCH_TOOL_NAME,
  label: 'Ops：派发子代理',
  description:
    '派发子代理（investigator/executor/writer/verifier）并默认阻塞到终态：' +
    '工具结果即终态摘要 JSON（status: ok|degraded|failed|aborted|rejected + summary）。' +
    '可选 waitMs（毫秒）：到期该任务先返回 {status:running, taskId}，runner 继续；' +
    '随后用 ops_check_subagent {taskId} 收割终态。缺省不传 waitMs = 阻塞到底。' +
    '单任务给顶层 role/goal/riskCeiling；并行取证给 tasks[]（一次最多 ' +
    `${MAX_DISPATCH_TASKS} 个，全部结束后一并返回）。` +
    '仅多主机/多插件并行取证才用 tasks[]；单台已连接主机的巡检不要用 tasks[]' +
    '（单目标由主会话直接调工具，或至多派一个子任务）。' +
    'allowTools 点名的工具会被实际注入子会话（不被 riskCeiling 滤掉）：' +
    'investigator 做只读巡检可点名 run_remote_command——只读命令' +
    '（hostname/uptime/df/free/ps/systemctl status 等）按 read 推断放行。' +
    'Investigator 只读（riskCeiling 必须 read）；Executor 必须携带 approvalToken.briefId' +
    '（commandSetSha256 由 host 绑定，不要自行计算）；Writer 无业务工具。' +
    '仅主会话可用，子代理禁止递归派发。payloadCaps 不在本工具参数里（由 playbook yaml defaults 注入）。',
  parameters: {
    type: 'object',
    properties: {
      ...DISPATCH_TASK_PROPERTIES,
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: DISPATCH_TASK_PROPERTIES,
          required: ['role', 'goal', 'riskCeiling'],
          additionalProperties: false
        },
        description:
          `并行任务数组（可选；与顶层单任务字段二选一，最多 ${MAX_DISPATCH_TASKS} 个）。` +
          '仅多主机/多插件才用；单台已连接主机不要用 tasks[]'
      }
    },
    additionalProperties: false
  } as Record<string, unknown>
} as const;
