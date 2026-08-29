/**
 * 会话策略闸（三道闸中的第 ① 道，见 docs/07-security.md）。
 *
 * 纯函数、无 IO、不依赖 vscode。由 Agent runtime 在每次 tools/call 前调用；
 * Hub 选路（②）与插件确认弹窗（③）不被本闸替代。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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
  /**
   * 本会话已免审的 read 工具名（P1-9「本会话不再问」记忆，host 维护）。
   * 只对 risk=read 生效：命中即 needSessionApproval=false 直接放行；
   * write/exec 双闸完全不受该名单影响。
   */
  sessionReadAllowlist?: string[];
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

// ── 远程命令的只读风险推断 ───────────────────────────────────────────────

/**
 * 远程终端类工具：run_remote_command / jumpserver_run_terminal_command
 * （允许 at.terminal/run_remote_command 这类带命名空间前缀的变体）。
 */
const REMOTE_COMMAND_TOOL_RE = /(?:^|[._/])run_(?:remote|terminal)_command$/i;

/** 出现重定向 / 反引号 / $() 命令替换的命令一律不做只读推断。 */
const SHELL_DANGER_RE = /[<>`]|\$\(/;

const COMMAND_POLICY_REASON_MAX = 200;

type CommandPolicyAction = 'allow' | 'review' | 'deny';

export type CommandPolicyPreview = {
  action: CommandPolicyAction;
  reason: string;
  source: 'command-policy' | 'handwritten';
};

type ShellPolicyEvaluatorLike = {
  evaluate(input: { sourceText: string; cwd?: string }): Promise<{
    action?: unknown;
    reasonCode?: unknown;
    evidence?: ReadonlyArray<{ summary?: string }>;
  }>;
};

let commandPolicyUnavailableLogged = false;
let shellEvaluator: ShellPolicyEvaluatorLike | null | undefined;

function logCommandPolicyUnavailableOnce(detail: unknown): void {
  if (commandPolicyUnavailableLogged) return;
  commandPolicyUnavailableLogged = true;
  const msg = detail instanceof Error ? detail.message : String(detail);
  console.warn(`[policy] @at-series/command-policy unavailable, using handwritten table: ${msg}`);
}

function loadShellEvaluator(): ShellPolicyEvaluatorLike | null {
  if (shellEvaluator !== undefined) return shellEvaluator;
  try {
    // Subpath types need moduleResolution node16; runtime CJS exports exist.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@at-series/command-policy/shell') as {
      createShellPolicyEvaluator?: () => ShellPolicyEvaluatorLike;
    };
    if (typeof mod.createShellPolicyEvaluator !== 'function') {
      logCommandPolicyUnavailableOnce(new Error('createShellPolicyEvaluator missing'));
      shellEvaluator = null;
      return null;
    }
    shellEvaluator = mod.createShellPolicyEvaluator();
    return shellEvaluator;
  } catch (err) {
    logCommandPolicyUnavailableOnce(err);
    shellEvaluator = null;
    return null;
  }
}

const LIBRARY_UNAVAILABLE_REASON_CODES = new Set([
  'policy.analysis_unavailable',
  'policy.initialization_failed'
]);

function isRemoteExecTool(toolName: string): boolean {
  return REMOTE_COMMAND_TOOL_RE.test(toolName);
}

function clipPolicyReason(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= COMMAND_POLICY_REASON_MAX) return trimmed;
  return `${trimmed.slice(0, COMMAND_POLICY_REASON_MAX)}…`;
}

function formatLibraryReason(decision: {
  reasonCode?: unknown;
  evidence?: ReadonlyArray<{ summary?: string }>;
}): string {
  const code = typeof decision.reasonCode === 'string' ? decision.reasonCode : '';
  const summary = decision.evidence?.find((e) => typeof e.summary === 'string')?.summary ?? '';
  return clipPolicyReason([code, summary].filter((s) => s.length > 0).join('：'));
}

function handwrittenIsReadOnly(command: string): boolean {
  if (SHELL_DANGER_RE.test(command)) return false;
  const segments = command
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 && segments.every(isReadOnlyCommandSegment);
}

/**
 * 远程执行类工具的命令策略预判（简报「命令策略：allow|review|deny」）。
 * 只对 run_remote_command / jumpserver_run_terminal_command 等白名单生效，
 * 绝不对 grafana_query 跑 shell 分析器。库不可用时回退手写表。
 */
export async function previewRemoteCommandPolicy(
  toolName: string,
  args: Record<string, unknown>
): Promise<CommandPolicyPreview | undefined> {
  if (!isRemoteExecTool(toolName)) return undefined;
  const command = firstString(args.command);
  if (command === undefined) return undefined;

  const evaluator = loadShellEvaluator();
  if (evaluator !== null) {
    try {
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined;
      const decision = await Promise.race([
        evaluator.evaluate({
          sourceText: command,
          ...(cwd !== undefined ? { cwd } : {})
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('command-policy evaluate timed out')), 1500);
        })
      ]);
      const reasonCode = typeof decision.reasonCode === 'string' ? decision.reasonCode : '';
      if (!LIBRARY_UNAVAILABLE_REASON_CODES.has(reasonCode)) {
        const action = decision.action;
        if (action === 'allow' || action === 'review' || action === 'deny') {
          return {
            action,
            reason: formatLibraryReason(decision),
            source: 'command-policy'
          };
        }
        return {
          action: 'review',
          reason: '策略判定无效，保持申报风险',
          source: 'command-policy'
        };
      }
      logCommandPolicyUnavailableOnce(reasonCode);
    } catch {
      return {
        action: 'review',
        reason: '策略分析失败，保持申报风险',
        source: 'command-policy'
      };
    }
  }

  return {
    action: handwrittenIsReadOnly(command) ? 'allow' : 'review',
    reason: handwrittenIsReadOnly(command)
      ? '手写表：只读巡检命令'
      : '手写表：非只读命令，保持申报风险',
    source: 'handwritten'
  };
}

/** 简报装配用：同步手写预判，不 await WASM（waiter 必须先于任何 I/O 登记）。 */
export function previewRemoteCommandPolicySync(
  toolName: string,
  args: Record<string, unknown>
): CommandPolicyPreview | undefined {
  if (!isRemoteExecTool(toolName)) return undefined;
  const command = firstString(args.command);
  if (command === undefined) return undefined;
  return {
    action: handwrittenIsReadOnly(command) ? 'allow' : 'review',
    reason: handwrittenIsReadOnly(command)
      ? '手写表：只读巡检命令'
      : '手写表：非只读命令，保持申报风险',
    source: 'handwritten'
  };
}

/** 首词即整体只读的命令（参数任意；重定向已在上层排除）。 */
const READ_ONLY_LEADING_COMMANDS = new Set([
  'hostname',
  'whoami',
  'uname',
  'uptime',
  'df',
  'free',
  'nproc',
  'ps',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  // docs/14 P0-read：常见只读巡检命令
  'w',
  'who',
  'last',
  'id',
  'date',
  'timedatectl',
  'lsblk',
  'lscpu',
  'lsmem',
  'findmnt',
  'vmstat',
  'iostat',
  'netstat',
  'ss',
  'dmesg',
  // 管道滤镜（重定向 / $() / 反引号已被 SHELL_DANGER_RE 整体排除）
  'awk',
  'grep',
  'egrep',
  'fgrep',
  'cut',
  'uniq',
  'tr',
  'column'
]);

/** systemctl 的只读子命令（无子命令的纯 flag 形式如 `systemctl --failed` 也算只读）。 */
const SYSTEMCTL_READ_SUBCOMMANDS = new Set([
  'status',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'list-timers',
  'show'
]);

/** iptables 的链/规则变更选项（命中即非只读）。 */
const IPTABLES_MUTATION_RE =
  /^-(?:[ADIRNXPEZF]$|-(?:append|delete|insert|replace|new-chain|delete-chain|policy|flush|zero|rename-chain))/;

/** ip 的只读对象（show / list 类查询）。 */
const IP_READ_SUBCOMMANDS = new Set(['addr', 'address', 'link', 'route', 'neigh', 'rule']);

/** ip 的变更动作 token（命中即非只读，宁可误伤 `ip addr show up` 这类过滤）。 */
const IP_MUTATION_TOKENS = new Set([
  'add',
  'del',
  'delete',
  'change',
  'replace',
  'set',
  'flush',
  'up',
  'down'
]);

/** docker 的只读子命令（stats 另要求 --no-stream / -n，见下）。 */
const DOCKER_READ_SUBCOMMANDS = new Set([
  'ps',
  'stats',
  'inspect',
  'logs',
  'images',
  'info',
  'port',
  'top'
]);

/** 单段命令（无 && / ; / | 组合）是否只读；不认识的一律 false（保守）。 */
function isReadOnlyCommandSegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const [cmd, ...rest] = tokens;
  if (READ_ONLY_LEADING_COMMANDS.has(cmd)) return true;
  if (cmd === 'top') {
    // 仅批处理模式（top -b / -bn1）只读；交互式 top 不推断。
    return rest.some((t) => /^-[a-z]*b/.test(t));
  }
  if (cmd === 'systemctl') {
    const sub = rest.find((t) => !t.startsWith('-'));
    return sub === undefined ? true : SYSTEMCTL_READ_SUBCOMMANDS.has(sub);
  }
  if (cmd === 'journalctl') {
    // journalctl 只读，除非带 --vacuum-* / --rotate / --flush 维护开关。
    return !rest.some((t) => t.startsWith('--vacuum') || t === '--rotate' || t === '--flush');
  }
  if (cmd === 'mount') {
    // 仅列出挂载（无参数或纯 flag 如 -l）只读；-o / --bind / --move 或出现
    // 设备/挂载点等位置参数即真实挂载动作。
    if (rest.some((t) => /^-o/.test(t) || t.startsWith('--options') || t === '--bind' || t === '--move')) {
      return false;
    }
    return rest.every((t) => t.startsWith('-'));
  }
  if (cmd === 'sysctl') {
    // sysctl 读取内核参数只读；-w / --write 以及 key=value 赋值为写。
    return !rest.some(
      (t) => t === '-w' || t === '--write' || (!t.startsWith('-') && t.includes('='))
    );
  }
  if (cmd === 'sed') {
    // sed 流式过滤只读；-i / --in-place 原地改写文件不算。
    return !rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place'));
  }
  if (cmd === 'sort') {
    // sort 只读；-o / --output 写结果文件不算。
    return !rest.some((t) => /^-[a-zA-Z]*o/.test(t) || t.startsWith('--output'));
  }
  if (cmd === 'ip') {
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub === undefined || !IP_READ_SUBCOMMANDS.has(sub)) return false;
    return !rest.some((t) => IP_MUTATION_TOKENS.has(t));
  }
  if (cmd === 'docker') {
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub === undefined || !DOCKER_READ_SUBCOMMANDS.has(sub)) return false;
    // stats 默认持续刷新（交互式），仅 --no-stream / -n 的一次性输出算只读。
    if (sub === 'stats') return rest.some((t) => t === '--no-stream' || t === '-n');
    return true;
  }
  if (cmd === 'kubectl') return rest.find((t) => !t.startsWith('-')) === 'get';
  if (cmd === 'iptables') {
    const hasList = rest.some((t) => t === '--list' || /^-[a-z]*L/.test(t));
    return hasList && !rest.some((t) => IPTABLES_MUTATION_RE.test(t));
  }
  return false;
}

/**
 * 按命令内容推断远程命令工具的有效风险：
 * 优先 `@at-series/command-policy`（allow → read；review/deny → 保持申报风险）。
 * 库 allow 仍须手写表也认为只读（只能加严：防 command substitution 等库误放）。
 * 库不可用 → 手写只读表兜底。grafana_query 等非远程执行工具不分析。
 */
export async function inferEffectiveRisk(
  toolName: string,
  args: Record<string, unknown>,
  declaredRisk: RiskLevel
): Promise<RiskLevel> {
  if (declaredRisk === 'read') return declaredRisk;
  if (!isRemoteExecTool(toolName)) return declaredRisk;
  const command = firstString(args.command);
  if (command === undefined) return declaredRisk;

  const preview = await previewRemoteCommandPolicy(toolName, args);
  if (preview === undefined) return declaredRisk;
  const hwRead = handwrittenIsReadOnly(command);
  if (preview.source === 'handwritten') {
    return hwRead ? 'read' : declaredRisk;
  }
  if (preview.action === 'allow' && hwRead) return 'read';
  return declaredRisk;
}

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

export async function evaluatePolicy(ctx: PolicyContext): Promise<PolicyDecision> {
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

  // 远程命令按内容推断有效风险（只读巡检命令 → read；见 inferEffectiveRisk）。
  // 后续 ceiling 与审批裁决一律用推断值——run_remote_command 声明 exec，
  // 但 `hostname` / `systemctl status` 这类只读命令不应被 read 硬顶挡住。
  const risk = await inferEffectiveRisk(ctx.toolName, ctx.args, ctx.risk);

  // ── 规则 3：Investigator / Writer / Verifier 默认 read 硬顶 ─────────
  if (ctx.role !== undefined && READ_CEILING_ROLES.has(ctx.role)) {
    const ceiling = ctx.riskCeiling ?? 'read';
    if (RISK_ORDER[risk] > RISK_ORDER[ceiling]) {
      return block(
        OPS_ERROR.RISK_CEILING,
        `${ctx.role} 的 riskCeiling=${ceiling}，拒绝 ${risk} 级工具 ${ctx.toolName}`
      );
    }
  } else if (ctx.riskCeiling !== undefined && RISK_ORDER[risk] > RISK_ORDER[ctx.riskCeiling]) {
    // lead / executor 只在显式给出 riskCeiling 时受顶
    return block(
      OPS_ERROR.RISK_CEILING,
      `riskCeiling=${ctx.riskCeiling}，拒绝 ${risk} 级工具 ${ctx.toolName}`
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

  // ── read：会话免审名单（P1-9）命中即放行；其余 read 也直接放行 ───────
  // 名单只对 read 生效（write/exec 双闸不受影响）。当前 read 本就免审，
  // 显式短路承载「本会话不再问」语义——将来引入 read 级审批（敏感读接口）
  // 时命中名单仍然跳过。推断为 read 的只读远程命令走同一条路。
  if (risk === 'read' && ctx.sessionReadAllowlist?.includes(ctx.toolName) === true) {
    return allow();
  }
  if (risk === 'read') {
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
      `Executor 调用 ${risk} 级工具必须携带有效 approvalToken`
    );
  }

  // 规则 5：at.database 的 write 强制会话审批（插件无确认弹窗缺口），
  // 即使 sessionRequiredFor 被调成 exec-only / never。
  if (ctx.pluginId === 'at.database' && risk === 'write') {
    return needApproval('at.database 写操作无插件弹窗，强制 9 要素审批简报');
  }

  // 规则 6：按全局策略决定是否需要会话审批
  switch (ctx.sessionRequiredFor) {
    case 'write-exec':
      return needApproval(`${risk} 级操作需要 9 要素审批简报（sessionRequiredFor=write-exec）`);
    case 'exec-only':
      return risk === 'exec'
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
