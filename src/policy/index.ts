/**
 * 会话策略闸（三道闸中的第 ① 道，见 docs/07-security.md）。
 *
 * 纯函数、无 IO、不依赖 vscode。由 Agent runtime 在每次 tools/call 前调用；
 * Hub 选路（②）与插件确认弹窗（③）不被本闸替代。
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

import { OPS_ERROR } from '../protocol';

export type RiskLevel = 'read' | 'write' | 'exec';

export type SubagentRole = 'lead' | 'investigator' | 'executor' | 'writer' | 'verifier';

export type ApprovalRef = {
  briefId: string;
  commandSetSha256: string;
  token: string;
};

export type PolicyContext = {
  toolName: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  pluginId?: string;
  /** playbook stage id（无 playbook 运行时可缺省） */
  stage?: string;
  role?: SubagentRole;
  riskCeiling?: RiskLevel;
  approval?: ApprovalRef | null;
  sessionRequiredFor: 'write-exec' | 'exec-only' | 'never';
  /** 本任务内 at_select / ops_select 已发生的次数 */
  selectCountThisTask: number;
};

export type PolicyDecision =
  | { block: false; needSessionApproval: false }
  | { block: false; needSessionApproval: true; reason: string }
  | { block: true; code: string; reason: string };

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

const RISK_ORDER: Record<RiskLevel, number> = { read: 0, write: 1, exec: 2 };

const CLEAR_TOOLS = new Set(['ops_clear_tool_selection', 'at_clear_tool_selection']);
const SELECT_TOOLS = new Set(['ops_select_tools', 'at_select_tools']);

/** clear 在这些阶段等于丢弃调查现场，一律拒绝（docs/07 L1 第 7 条） */
const CLEAR_FORBIDDEN_STAGES = new Set(['selecting', 'investigating', 'synthesizing']);

/** 到达任务边界后允许重新 replace（closed / triage；selecting 首次由 selectCount==0 覆盖） */
const TASK_BOUNDARY_STAGES = new Set(['closed', 'triage']);

/** riskCeiling 缺省即 read 硬顶的角色 */
const READ_CEILING_ROLES = new Set<SubagentRole>(['investigator', 'writer', 'verifier']);

const SQL_TOOL_RE = /execute_(sql|query)/i;
const SQL_LIMIT_RE = /\blimit\s+\d+/i;

function allow(): PolicyDecision {
  return { block: false, needSessionApproval: false };
}

function needApproval(reason: string): PolicyDecision {
  return { block: false, needSessionApproval: true, reason };
}

function block(code: string, reason: string): PolicyDecision {
  return { block: true, code, reason };
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * 从工具入参尽力推导命令集哈希（无法推导时返回 undefined，
 * 完整校验由 orchestrator 的 assertApproval 负责）。
 */
function deriveCommandSetHash(args: Record<string, unknown>): string | undefined {
  const declared = args.commandSetSha256;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  if (Array.isArray(args.commands)) return hashCommandSet(args.commands);
  const single = firstString(args.command, args.sql, args.query);
  if (single !== undefined) return hashCommandSet([single]);
  return undefined;
}

export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  // ── 规则 1：调查/选择/综合阶段禁止清除工具选择 ────────────────────────
  if (CLEAR_TOOLS.has(ctx.toolName)) {
    if (ctx.stage !== undefined && CLEAR_FORBIDDEN_STAGES.has(ctx.stage)) {
      return block(
        OPS_ERROR.SELECTION_FORBIDDEN,
        `阶段 ${ctx.stage} 进行中禁止清除工具选择；请等待任务边界（reporting/closed）`
      );
    }
    return allow();
  }

  // ── 规则 2：每任务一轮 replace select ────────────────────────────────
  if (SELECT_TOOLS.has(ctx.toolName)) {
    const mode = ctx.args.mode ?? 'replace';
    const atBoundary =
      ctx.stage === undefined || TASK_BOUNDARY_STAGES.has(ctx.stage);
    if (mode === 'replace' && ctx.selectCountThisTask >= 1 && !atBoundary) {
      return block(
        OPS_ERROR.SELECTION_FORBIDDEN,
        '本任务已完成一轮工具选择；调查中不允许再次 replace，扩面请用 mode=add 或等任务边界'
      );
    }
    return allow();
  }

  // ── 规则 4：Writer 不允许调用任何业务工具（非 ops_*） ────────────────
  if (ctx.role === 'writer' && !ctx.toolName.startsWith('ops_')) {
    return block(
      OPS_ERROR.RISK_CEILING,
      `Writer 无业务工具面，不允许调用 ${ctx.toolName}`
    );
  }

  // ── 规则 3：Investigator / Writer / Verifier 默认 read 硬顶 ─────────
  if (ctx.role !== undefined && READ_CEILING_ROLES.has(ctx.role)) {
    const ceiling = ctx.riskCeiling ?? 'read';
    if (RISK_ORDER[ctx.risk] > RISK_ORDER[ceiling]) {
      return block(
        OPS_ERROR.RISK_CEILING,
        `${ctx.role} 的 riskCeiling=${ceiling}，拒绝 ${ctx.risk} 级工具 ${ctx.toolName}`
      );
    }
  } else if (ctx.riskCeiling !== undefined && RISK_ORDER[ctx.risk] > RISK_ORDER[ctx.riskCeiling]) {
    // lead / executor 只在显式给出 riskCeiling 时受顶
    return block(
      OPS_ERROR.RISK_CEILING,
      `riskCeiling=${ctx.riskCeiling}，拒绝 ${ctx.risk} 级工具 ${ctx.toolName}`
    );
  }

  // ── 规则 9：payload 上限 ─────────────────────────────────────────────
  if (ctx.toolName.toLowerCase().includes('loki')) {
    const limit = ctx.args.limit;
    if (typeof limit === 'number' && limit > 100) {
      return block(OPS_ERROR.PAYLOAD_CAP, `Loki limit 必须 ≤100（收到 ${limit}）`);
    }
  }
  if (SQL_TOOL_RE.test(ctx.toolName)) {
    const sqlText = firstString(ctx.args.sql, ctx.args.query, ctx.args.statement, ctx.args.command);
    const hasLimitArg = typeof ctx.args.limit === 'number';
    const hasLimitClause = sqlText !== undefined && SQL_LIMIT_RE.test(sqlText);
    if (!hasLimitArg && !hasLimitClause) {
      return block(OPS_ERROR.PAYLOAD_CAP, 'SQL 必须带 LIMIT 子句或 limit 参数');
    }
  }

  // ── read 直接放行 ────────────────────────────────────────────────────
  if (ctx.risk === 'read') {
    return allow();
  }

  // ── write / exec：审批链 ─────────────────────────────────────────────
  const approval = ctx.approval ?? null;

  if (approval !== null) {
    // 规则 6/8：token 必须非空；能推导命令哈希时必须与简报一致
    if (approval.token.length === 0) {
      return block(OPS_ERROR.APPROVAL_REQUIRED, 'approvalToken 为空，需重新走审批简报');
    }
    const derived = deriveCommandSetHash(ctx.args);
    if (derived !== undefined && derived !== approval.commandSetSha256) {
      return block(
        OPS_ERROR.APPROVAL_STALE,
        `命令集哈希与已批简报 ${approval.briefId} 不一致，令牌作废，需重新审批`
      );
    }
    // 已获会话批准，放行（③ 插件弹窗仍会独立生效）
    return allow();
  }

  // 规则 7：Executor 无 approval 一律拒绝 write/exec
  if (ctx.role === 'executor') {
    return block(
      OPS_ERROR.APPROVAL_REQUIRED,
      `Executor 调用 ${ctx.risk} 级工具必须携带有效 approvalToken`
    );
  }

  // 规则 5：at.database 的 write 强制会话审批（插件无确认弹窗缺口），
  // 即使 sessionRequiredFor 被调成 exec-only / never。
  if (ctx.pluginId === 'at.database' && ctx.risk === 'write') {
    return needApproval('at.database 写操作无插件弹窗，强制 9 要素审批简报');
  }

  // 规则 6：按全局策略决定是否需要会话审批
  switch (ctx.sessionRequiredFor) {
    case 'write-exec':
      return needApproval(`${ctx.risk} 级操作需要 9 要素审批简报（sessionRequiredFor=write-exec）`);
    case 'exec-only':
      return ctx.risk === 'exec'
        ? needApproval('exec 级操作需要 9 要素审批简报（sessionRequiredFor=exec-only）')
        : allow();
    case 'never':
      return allow();
  }
}

/** 别名：runtime 侧习惯用 evaluate(ctx) */
export const evaluate = evaluatePolicy;

// ────────────────────────────── 哈希与令牌 ──────────────────────────────

/** 递归按 key 排序的 canonical JSON（数组保序），保证跨进程哈希稳定 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** 命令集哈希：canonical JSON + sha256 hex，用于把审批简报与确切命令绑定 */
export function hashCommandSet(commands: unknown): string {
  return createHash('sha256').update(canonicalJson(commands), 'utf8').digest('hex');
}

function tokenPayload(briefId: string, commandSetSha256: string, sessionId: string): string {
  return `${briefId}\n${commandSetSha256}\n${sessionId}`;
}

/** HMAC-SHA256 审批令牌；secret 只存在于 host 内存，不进 LLM */
export function issueApprovalToken(
  briefId: string,
  commandSetSha256: string,
  sessionId: string,
  secret: string
): string {
  return createHmac('sha256', secret)
    .update(tokenPayload(briefId, commandSetSha256, sessionId), 'utf8')
    .digest('hex');
}

export function verifyApprovalToken(
  token: string,
  briefId: string,
  commandSetSha256: string,
  sessionId: string,
  secret: string
): boolean {
  const expected = issueApprovalToken(briefId, commandSetSha256, sessionId, secret);
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 供 orchestrator 在下发 Executor 前校验：
 * plan 中的命令集必须与已批简报的 commandSetSha256 一致，否则简报失效。
 * 不一致 / 无审批时 throw PolicyError（OPS_APPROVAL_STALE / OPS_APPROVAL_REQUIRED）。
 */
export function assertApproval(
  planCommands: unknown,
  approval: ApprovalRef | null | undefined
): void {
  if (!approval || approval.token.length === 0) {
    throw new PolicyError(OPS_ERROR.APPROVAL_REQUIRED, '缺少有效的审批令牌，write/exec 计划不可下发');
  }
  const actual = hashCommandSet(planCommands);
  if (actual !== approval.commandSetSha256) {
    throw new PolicyError(
      OPS_ERROR.APPROVAL_STALE,
      `计划命令集哈希 ${actual.slice(0, 12)}… 与简报 ${approval.briefId} 绑定的 ` +
        `${approval.commandSetSha256.slice(0, 12)}… 不一致，需重新审批`
    );
  }
}
