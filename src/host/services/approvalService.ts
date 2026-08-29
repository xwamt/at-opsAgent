/**
 * 审批服务（P0-D 阻塞派发 + P2 会话并行）：
 * - beforeToolCall 权限闸装配（policy.evaluate；orchestrator 侧不重复）；
 * - needSessionApproval 时 runtime 在同一 execute 内 await 会话审批——
 *   批准继续同一调用，无需模型重试；无 playbook run 时 host 本地装配
 *   同构 9 要素简报（审批不依赖 playbook）；
 * - 批准后 host 内存签发 HMAC 令牌（不进 LLM / webview / 日志）；
 * - 审批状态全部按 sessionId 分席（sessions.maxParallel=2 时两席并行、
 *   互不串令牌）：briefId → 所属会话反查，令牌与所属会话绑定。
 * - 配置了 IM webhook 时同步推送脱敏摘要（P2）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ApprovalRespondReq } from '../../protocol';
import type { PolicyContext, ToolCallOrigin } from '../../core';
import {
  hashCommandSet,
  issueApprovalToken,
  verifyApprovalToken,
  type ApprovalRef
} from '../../policy';
import { buildApprovalCommandSet, buildApprovalElements } from '../approvalGate';
import type { ApprovalBriefLike } from '../hostTypes';
import { postApprovalWebhook, toBriefView } from './approvalNotify';
import { describeError, type HostContext } from './context';

const SELECT_TOOL_NAMES = new Set(['ops_select_tools', 'at_select_tools']);

const SUBAGENT_POLICY_ROLES: ReadonlySet<string> = new Set([
  'lead',
  'investigator',
  'executor',
  'writer',
  'verifier'
]);

const RISK_LEVELS: ReadonlySet<string> = new Set(['read', 'write', 'exec']);

/** 生产默认审批超时：15min。测试经 `_timeoutMsForTest` 注入短 TTL，禁止改此默认。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 900_000;

/** 阻塞派发审批的等待者（briefId → 决议 promise；记录所属会话）。 */
interface ApprovalWaiter {
  sessionId: string;
  commandSetSha256: string;
  promise: Promise<'approved' | 'rejected'>;
  resolve: (decision: 'approved' | 'rejected') => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ApprovalService {
  /** briefId → runId（applyApproval 需要 runId 定位 run；host 本地简报为 ''）。 */
  private readonly briefRuns = new Map<string, string>();
  /** briefId → commandSetSha256（批准时签发令牌用；resolved 后清除）。 */
  private readonly briefHashes = new Map<string, string>();
  /** briefId → 所属会话（令牌绑定该会话；并行会话时反查决议目标）。 */
  private readonly briefSessions = new Map<string, string>();
  /** briefId → 阻塞派发等待者（runtime 在 execute 内 await 的 promise）。 */
  private readonly approvalWaiters = new Map<string, ApprovalWaiter>();
  /** sessionId → 本会话内已免审的 read 工具名（「本会话不再问」）。 */
  private readonly readAllowlists = new Map<string, Set<string>>();
  /**
   * sessionId → 会话内当前有效的审批引用。token 只存 host 内存：
   * 不发给 LLM、不发给 webview、不写日志。
   */
  private readonly currentApprovals = new Map<string, ApprovalRef>();
  /** 审批令牌 HMAC 秘钥：进程内随机生成，同样绝不外发/落日志。 */
  private readonly approvalSecret = randomBytes(32).toString('hex');
  /**
   * 测试注入审批超时（毫秒）。未设置时读 `atOpsAgent.approval.timeoutMs`
   *（默认 15min）。0 = 不超时；非法值回退默认。
   */
  _timeoutMsForTest: number | undefined;

  constructor(private readonly ctx: HostContext) {}

  /** 解析 TTL：有限且 ≥0 的数字；0 禁用超时；其余非法回退 15min。 */
  private readTimeoutMs(): number {
    const raw =
      this._timeoutMsForTest !== undefined
        ? this._timeoutMsForTest
        : vscode.workspace
            .getConfiguration('atOpsAgent')
            .get<number>('approval.timeoutMs', DEFAULT_APPROVAL_TIMEOUT_MS);
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
    return n;
  }

  // ── 权限闸（policy.evaluate 装配点） ────────────────────────────────────

  async gateToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    origin?: ToolCallOrigin
  ): Promise<{ block: boolean; reason?: string; needSessionApproval?: boolean; risk?: 'write' | 'exec' }> {
    const ctx = this.ctx;
    try {
      const descriptor = ctx.hub.listAllTools().find((t) => t.name === toolName);
      // ops_* 发现工具视为 read；未知业务工具 fail-closed 为 exec。
      const risk = descriptor?.risk ?? (toolName.startsWith('ops_') ? 'read' : 'exec');
      const config = vscode.workspace.getConfiguration('atOpsAgent');
      const stage = ctx.store.playbookOf(sessionId)?.stage;
      const policyCtx: PolicyContext = {
        toolName,
        args,
        risk,
        ...(descriptor?.pluginId !== undefined ? { pluginId: descriptor.pluginId } : {}),
        ...(stage !== undefined ? { stage } : {}),
        ...(origin?.kind === 'subagent' && SUBAGENT_POLICY_ROLES.has(origin.role)
          ? { role: origin.role as PolicyContext['role'] }
          : {}),
        ...(origin?.kind === 'subagent' && RISK_LEVELS.has(origin.riskCeiling)
          ? { riskCeiling: origin.riskCeiling as PolicyContext['riskCeiling'] }
          : {}),
        approval: this.approvalForOrigin(sessionId, origin),
        sessionRequiredFor: config.get<'write-exec' | 'exec-only' | 'never'>(
          'approval.sessionRequiredFor',
          'write-exec'
        ),
        selectCountThisTask: ctx.playbooks.selectCount(sessionId),
        sessionReadAllowlist: this.readToolAllowlist(sessionId)
      };
      const decision = ctx.core.evaluatePolicy(policyCtx);
      if (decision.block) {
        ctx.log(`[policy] ${toolName} 被拒: ${decision.code} ${decision.reason}`);
        return { block: true, reason: `${decision.code}: ${decision.reason}` };
      }
      if (SELECT_TOOL_NAMES.has(toolName)) {
        ctx.playbooks.bumpSelectCount(sessionId);
      }
      if (decision.needSessionApproval) {
        // 会话审批闭环：runtime 在同一 execute 内 await requestApproval。
        return {
          block: false,
          needSessionApproval: true,
          risk: risk === 'exec' ? 'exec' : 'write',
          reason: decision.reason
        };
      }
      return { block: false };
    } catch (err) {
      // 闸门自身出错必须 fail-closed。
      ctx.log(`[policy] evaluate 异常，fail-closed: ${describeError(err)}`);
      return { block: true, reason: `策略闸异常，已按拒绝处理（${describeError(err)}）` };
    }
  }

  /** 配置 + 会话内「本会话不再问」集合的合并 read 免审清单。 */
  private readToolAllowlist(sessionId: string): string[] {
    const configured = vscode.workspace
      .getConfiguration('atOpsAgent')
      .get<string[]>('approval.sessionReadAllowlist', []);
    return [
      ...new Set([
        ...(Array.isArray(configured) ? configured.filter((v) => typeof v === 'string') : []),
        ...(this.readAllowlists.get(sessionId) ?? [])
      ])
    ];
  }

  /** 调用方的审批引用：主会话用该席 currentApproval；子代理按 briefId 对齐。 */
  private approvalForOrigin(
    sessionId: string,
    origin: ToolCallOrigin | undefined
  ): ApprovalRef | null {
    const approval = this.validApproval(sessionId);
    if (!approval) return null;
    if (origin?.kind === 'subagent') {
      // origin.approvalToken = TaskSpec.approvalToken.briefId（简报 id 引用）。
      return origin.approvalToken === approval.briefId ? approval : null;
    }
    return approval;
  }

  /** host 内存中的审批引用；HMAC 与所属会话验证不过即视为无审批。 */
  private validApproval(sessionId: string): ApprovalRef | null {
    const approval = this.currentApprovals.get(sessionId);
    if (!approval) return null;
    const ok = verifyApprovalToken(
      approval.token,
      approval.briefId,
      approval.commandSetSha256,
      sessionId,
      this.approvalSecret
    );
    if (!ok) {
      // 会话已换代等：引用作废，不留过期令牌。
      this.currentApprovals.delete(sessionId);
      return null;
    }
    return approval;
  }

  // ── 阻塞派发审批（P0-D） ────────────────────────────────────────────────

  /**
   * runtime 在工具 execute 内 await 本方法：
   * - 有 playbook run：经 orchestrator.requestApproval 产出 9 要素简报
   *   （approval/request 事件由 PlaybookService 路由回本服务登记+广播）；
   * - 无 run（普通问答的 write/exec）：host 本地装配同构简报并走同一广播；
   * - 同一会话同一命令集已有待审简报时共享同一决议 promise。
   * 用户在 ApprovalBar / 命令面板决议后（applyApproval）该 promise 才落定。
   */
  async resolveSessionApproval(
    sessionId: string,
    input: {
      toolName: string;
      args: Record<string, unknown>;
      risk: 'write' | 'exec';
      reason?: string;
      origin?: ToolCallOrigin;
    }
  ): Promise<'approved' | 'rejected'> {
    const ctx = this.ctx;
    const commandSet = buildApprovalCommandSet(input.toolName, input.args);
    const commandSetSha256 = hashCommandSet(commandSet);
    // 同一会话同一命令集已在等待决议（并行子代理等）：共享同一 promise。
    for (const waiter of this.approvalWaiters.values()) {
      if (waiter.sessionId === sessionId && waiter.commandSetSha256 === commandSetSha256) {
        return waiter.promise;
      }
    }
    const pluginId = this.pluginIdOf(input.toolName);
    const stage = ctx.store.playbookOf(sessionId)?.stage;
    const elements = buildApprovalElements({
      toolName: input.toolName,
      args: input.args,
      risk: input.risk,
      commandSet,
      ...(pluginId !== undefined ? { pluginId } : {}),
      ...(stage !== undefined ? { stage } : {})
    });

    let brief: ApprovalBriefLike | undefined;
    const run = ctx.playbooks.runOf(sessionId);
    if (run) {
      try {
        const orchestrator = await ctx.playbooks.ensureOrchestrator();
        if (orchestrator.requestApproval) {
          // awaitingApproval 只能从 synthesizing / executing 进入；调查中先推进。
          if (ctx.playbooks.currentStage(run, sessionId) === 'investigating') {
            ctx.playbooks.tryAdvance(run, 'synthesizing');
          }
          brief = orchestrator.requestApproval(run.id, {
            risk: input.risk,
            commandSet,
            elements
          });
          // approval/request 事件已同步广播（PlaybookService → registerBrief）。
        }
      } catch (err) {
        ctx.log(`[orchestrator] requestApproval 失败: ${describeError(err)}，改走 host 本地简报`);
      }
    }
    if (!brief) {
      // 无 playbook run 的普通会话审批（P0 修复：审批不再依赖 playbook）。
      brief = {
        briefId: `brief-local-${randomUUID().slice(0, 8)}`,
        runId: '',
        risk: input.risk,
        commandSet,
        commandSetSha256,
        elements
      };
      this.registerBrief(brief, sessionId);
    }
    const briefId = brief.briefId;

    let resolve!: (decision: 'approved' | 'rejected') => void;
    const promise = new Promise<'approved' | 'rejected'>((r) => {
      resolve = r;
    });
    const waiter: ApprovalWaiter = { sessionId, commandSetSha256, promise, resolve };
    const timeoutMs = this.readTimeoutMs();
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        this.onApprovalTimeout(briefId);
      }, timeoutMs);
    }
    this.approvalWaiters.set(briefId, waiter);
    return promise;
  }

  private pluginIdOf(toolName: string): string | undefined {
    try {
      return this.ctx.hub.listAllTools().find((t) => t.name === toolName)?.pluginId;
    } catch {
      return undefined;
    }
  }

  // ── 简报登记 / 决议 ─────────────────────────────────────────────────────

  /**
   * 待审简报登记（orchestrator approval/request 事件与 host 本地简报共用）：
   * 记录 briefId → run/hash/session 映射，写 store（目标会话），
   * 活动会话实时广播，配置了 IM webhook 时推送脱敏摘要。
   */
  registerBrief(brief: ApprovalBriefLike, sessionId: string): void {
    const ctx = this.ctx;
    const view = toBriefView(brief);
    this.briefRuns.set(brief.briefId, brief.runId);
    this.briefSessions.set(brief.briefId, sessionId);
    if (typeof brief.commandSetSha256 === 'string') {
      this.briefHashes.set(brief.briefId, brief.commandSetSha256);
    }
    ctx.store.addBrief(view, sessionId);
    const item = { kind: 'approval' as const, id: randomUUID(), briefId: view.id };
    ctx.store.appendItem(item, sessionId);
    ctx.broadcastToSession(sessionId, 'transcript/append', { item });
    ctx.broadcastToSession(sessionId, 'approval/request', view);
    postApprovalWebhook(ctx, view, sessionId);
  }

  /** orchestrator approval/resolved 事件：清理视图与映射（幂等）。 */
  handleResolvedEvent(briefId: string, decision: 'approved' | 'rejected'): void {
    const sessionId = this.briefSessions.get(briefId) ?? this.ctx.store.activeSessionId;
    if (this.ctx.store.resolveBrief(briefId, sessionId)) {
      this.ctx.broadcastToSession(sessionId, 'approval/resolve', { briefId, decision });
    }
    this.briefRuns.delete(briefId);
    this.briefHashes.delete(briefId);
    this.briefSessions.delete(briefId);
  }

  /**
   * 用户审批决议（webview ApprovalBar / 命令面板）：
   * - 先签发 HMAC 令牌（approved 时；令牌绑定简报**所属会话**，跨会话无效）；
   * - 有 playbook run 的简报再走 orchestrator.applyApproval（推进状态机）；
   * - 最后决议阻塞派发的等待者：runtime 在同一 execute 内继续/拒绝该调用。
   * 旧的非阻塞路径（简报存在但没有等待者）在批准后 followUp 提示模型重试。
   */
  async applyApproval(req: ApprovalRespondReq): Promise<{ ok: boolean }> {
    const ctx = this.ctx;
    if (typeof req?.briefId !== 'string') return { ok: false };
    const sessionId = this.briefSessions.get(req.briefId) ?? ctx.store.activeSessionId;
    const runId = this.briefRuns.get(req.briefId) ?? '';
    // approval/resolved 事件会同步清 briefHashes，先取哈希。
    const commandSetSha256 = this.briefHashes.get(req.briefId);
    // 令牌必须在等待者决议 / orchestrator.applyApproval 之前就位：
    // 放行后的同一命令集重试要经 policy 的 approval 校验命中。
    if (req.decision === 'approved') {
      if (commandSetSha256 !== undefined) {
        this.currentApprovals.set(sessionId, {
          briefId: req.briefId,
          commandSetSha256,
          token: issueApprovalToken(req.briefId, commandSetSha256, sessionId, this.approvalSecret)
        });
      }
    } else {
      this.currentApprovals.delete(sessionId);
    }
    if (runId.length > 0) {
      try {
        const orchestrator = await ctx.playbooks.ensureOrchestrator();
        orchestrator.applyApproval({
          brief: { briefId: req.briefId, runId },
          decision: req.decision
        });
      } catch (err) {
        ctx.log(`[orchestrator] applyApproval 失败: ${describeError(err)}`);
      }
    }
    // 事件路径（approval/resolved）已清理时为幂等 no-op。
    if (ctx.store.resolveBrief(req.briefId, sessionId)) {
      ctx.broadcastToSession(sessionId, 'approval/resolve', {
        briefId: req.briefId,
        decision: req.decision
      });
    }
    this.briefRuns.delete(req.briefId);
    this.briefHashes.delete(req.briefId);
    this.briefSessions.delete(req.briefId);
    ctx.store.appendTimeline(
      { kind: 'approval', briefId: req.briefId, decision: req.decision },
      sessionId
    );

    const hadWaiter = this.resolveApprovalWaiter(req.briefId, req.decision);
    if (!hadWaiter && req.decision === 'approved') {
      // 非阻塞旧路径：模型此前已收到结构化拒绝，批准后 followUp 提示继续。
      const runtime = ctx.chat.runtimeFor(sessionId);
      if (runtime) {
        void runtime
          .prompt('审批已通过，请继续执行刚才被拦截的操作（同一命令集）。', { mode: 'followUp' })
          .catch((err) => ctx.log(`[runtime] 审批 followUp 失败: ${describeError(err)}`));
      }
    }
    return { ok: true };
  }

  /** 决议阻塞派发等待者；返回是否存在等待者。决议时清 TTL，避免事后二次 reject。 */
  private resolveApprovalWaiter(briefId: string, decision: 'approved' | 'rejected'): boolean {
    const waiter = this.approvalWaiters.get(briefId);
    if (!waiter) return false;
    this.approvalWaiters.delete(briefId);
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiter.resolve(decision);
    return true;
  }

  /**
   * 审批 TTL 到期：fail-closed 为 rejected（永不 approved）。
   * 清 UI / 映射 / 令牌，不走 orchestrator.applyApproval（不推进 executing）。
   */
  private onApprovalTimeout(briefId: string): void {
    const waiter = this.approvalWaiters.get(briefId);
    if (!waiter) return;
    const sessionId = waiter.sessionId;
    if (!this.resolveApprovalWaiter(briefId, 'rejected')) return;
    this.finalizeRejection(briefId, sessionId, 'timeout');
  }

  /**
   * 拒绝落定后的 store / 广播 / 令牌清理（timeout / abort 与用户拒绝同形）。
   * 用户点拒绝仍走 applyApproval（含 orchestrator）；本方法不推进状态机。
   */
  private finalizeRejection(
    briefId: string,
    sessionId: string,
    reason: 'user' | 'timeout' | 'abort'
  ): void {
    this.currentApprovals.delete(sessionId);
    if (this.ctx.store.resolveBrief(briefId, sessionId)) {
      this.ctx.broadcastToSession(sessionId, 'approval/resolve', {
        briefId,
        decision: 'rejected'
      });
    }
    this.briefRuns.delete(briefId);
    this.briefHashes.delete(briefId);
    this.briefSessions.delete(briefId);
    this.ctx.store.appendTimeline(
      {
        kind: 'approval',
        briefId,
        decision: reason === 'timeout' ? 'timeout' : 'rejected',
        ...(reason === 'user' ? {} : { reason })
      },
      sessionId
    );
    if (reason === 'timeout') {
      this.ctx.log(`[approval] 审批超时 briefId=${briefId} session=${sessionId}`);
      this.ctx.emitAssistantNotice('审批已超时，已按拒绝处理', sessionId);
    }
  }

  /** 指定会话的全部挂起审批按拒绝决议（stop / cancel / 驱逐时避免 execute 悬挂）。 */
  rejectWaitersFor(sessionId: string): void {
    for (const [briefId, waiter] of [...this.approvalWaiters]) {
      if (waiter.sessionId === sessionId) this.resolveApprovalWaiter(briefId, 'rejected');
    }
  }

  /** 会话被驱逐出席位：清空该会话的全部审批运行态（令牌绝不跨会话复用）。 */
  clearSession(sessionId: string): void {
    this.rejectWaitersFor(sessionId);
    this.currentApprovals.delete(sessionId);
    this.readAllowlists.delete(sessionId);
    for (const [briefId, sid] of [...this.briefSessions]) {
      if (sid !== sessionId) continue;
      this.briefSessions.delete(briefId);
      this.briefRuns.delete(briefId);
      this.briefHashes.delete(briefId);
    }
  }

  dispose(): void {
    for (const briefId of [...this.approvalWaiters.keys()]) {
      this.resolveApprovalWaiter(briefId, 'rejected');
    }
  }
}
