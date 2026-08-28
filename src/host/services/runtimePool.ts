/**
 * 会话 runtime 池（P2：atOpsAgent.sessions.maxParallel ≤ 2）。
 *
 * sessionId → runtime 的 Map：最多两个会话可以同时跑 Agent 循环
 * （典型场景：一席查数据库、一席查主机）。本文件保持 vscode-free，
 * 配置读取 / context key / 会话态清理全部经回调注入，可直接单测。
 *
 * 语义：
 * - ensure(sessionId)：取或懒建该会话的 runtime。名额不足时优先驱逐
 *   最久未活动的**空闲**会话（onEvicted 让上层清理会话态）；全部在忙
 *   则抛 SessionPoolExhaustedError（上层转成 UI 提示，不排队阻塞）。
 * - busy / idle 每会话独立：markBusy 在 prompt 派发时、markIdle 在该会话
 *   runtime 的 idle 事件时调用；挂起的重建（换模型 / 新工具）在**该会话**
 *   idle 后才释放（P1-15 逐 runtime 生效）。
 * - abort / rebuild / evict 均按 sessionId 定向，互不牵连另一席。
 */
import type { RuntimeLike } from '../hostTypes';

/** 产品硬顶：并行会话席位最多 2（配置值再大也被夹到 2）。 */
export const MAX_PARALLEL_SESSIONS = 2;

/** 名额耗尽（其余席位都在忙、无可驱逐的空闲 runtime）。 */
export class SessionPoolExhaustedError extends Error {
  constructor(readonly maxParallel: number) {
    super(
      `并行会话已达上限（${maxParallel}）：请等待其他会话空闲或停止后再发送。`
    );
    this.name = 'SessionPoolExhaustedError';
  }
}

export interface SessionRuntimePoolOptions {
  /** 当前配置的并行席位数（每次 ensure 时读取；内部夹到 1..2）。 */
  maxParallel(): number;
  /** 为指定会话创建 runtime（上层绑定 resumeSessionFile 等会话上下文）。 */
  createRuntime(sessionId: string): Promise<RuntimeLike>;
  /** 会话被驱逐出池（runtime 已释放）：上层清理该会话的审批/playbook 运行态。 */
  onEvicted?(sessionId: string): void;
  /** 任一会话 busy 状态变化（上层重算 atOpsAgent.running context key）。 */
  onBusyChange?(): void;
  log?(message: string): void;
}

interface PoolEntry {
  readonly sessionId: string;
  runtime?: RuntimeLike;
  creation?: Promise<RuntimeLike>;
  busy: boolean;
  /** P1-15：运行中收到的重建请求先挂起，该会话 idle 后再释放 runtime。 */
  pendingRebuildReason?: string;
  lastActiveAt: number;
}

export class SessionRuntimePool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(private readonly options: SessionRuntimePoolOptions) {}

  /** 配置值夹到 [1, MAX_PARALLEL_SESSIONS]。 */
  effectiveMaxParallel(): number {
    const raw = this.options.maxParallel();
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
    return Math.min(MAX_PARALLEL_SESSIONS, Math.max(1, n));
  }

  /** 已就绪的 runtime（不触发创建）。 */
  runtimeOf(sessionId: string): RuntimeLike | undefined {
    return this.entries.get(sessionId)?.runtime;
  }

  isBusy(sessionId: string): boolean {
    return this.entries.get(sessionId)?.busy === true;
  }

  /** 占用席位（有 runtime 或创建中）的会话 id 列表。 */
  liveSessionIds(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.runtime !== undefined || e.creation !== undefined)
      .map((e) => e.sessionId);
  }

  /** 取或懒建 runtime；名额不足且无可驱逐空闲席位时抛 SessionPoolExhaustedError。 */
  async ensure(sessionId: string): Promise<RuntimeLike> {
    const existing = this.entries.get(sessionId);
    if (existing?.runtime) {
      existing.lastActiveAt = Date.now();
      return existing.runtime;
    }
    if (existing?.creation) return existing.creation;

    const max = this.effectiveMaxParallel();
    const others = [...this.entries.values()].filter(
      (e) => e.sessionId !== sessionId && (e.runtime !== undefined || e.creation !== undefined)
    );
    const overflow = others.length - (max - 1);
    if (overflow > 0) {
      // 优先驱逐最久未活动的空闲席位；创建中的席位不可驱逐。
      const evictable = others
        .filter((e) => !e.busy && e.creation === undefined)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      if (evictable.length < overflow) throw new SessionPoolExhaustedError(max);
      for (const victim of evictable.slice(0, overflow)) this.evict(victim.sessionId);
    }

    const entry: PoolEntry =
      this.entries.get(sessionId) ?? { sessionId, busy: false, lastActiveAt: Date.now() };
    this.entries.set(sessionId, entry);
    entry.lastActiveAt = Date.now();
    const creation = this.options
      .createRuntime(sessionId)
      .then((runtime) => {
        if (this.entries.get(sessionId) !== entry) {
          // 创建期间被驱逐：runtime 不入池，立即释放。
          this.disposeRuntime(sessionId, runtime);
          return runtime;
        }
        entry.runtime = runtime;
        return runtime;
      })
      .finally(() => {
        entry.creation = undefined;
      });
    entry.creation = creation;
    return creation;
  }

  /** prompt 派发：该会话进入运行中。 */
  markBusy(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.busy) return;
    entry.busy = true;
    entry.lastActiveAt = Date.now();
    this.options.onBusyChange?.();
  }

  /** 该会话 idle：清 busy，并释放挂起的重建（下次 prompt 续接重建）。 */
  markIdle(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.busy) {
      entry.busy = false;
      this.options.onBusyChange?.();
    }
    if (entry.pendingRebuildReason !== undefined) {
      const reason = entry.pendingRebuildReason;
      entry.pendingRebuildReason = undefined;
      this.rebuildNow(entry, reason);
    }
  }

  /**
   * 请求重建该会话的 runtime（换模型 / 工具目录变化）：
   * 运行中先挂起，idle 后释放；空闲立即释放。下一次 prompt 以
   * resumeSessionFile 续接同一 pi JSONL 重建（P0-C 不失忆）。
   */
  scheduleRebuild(sessionId: string, reason: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || (entry.runtime === undefined && entry.creation === undefined)) return;
    if (entry.busy) {
      entry.pendingRebuildReason = reason;
      this.options.log?.(`[runtime] ${reason}：会话进行中，等 idle 后重建`);
      return;
    }
    this.rebuildNow(entry, reason);
  }

  /** 全部在池会话请求重建（换模型对每席生效，各自等 idle）。 */
  scheduleRebuildAll(reason: string): void {
    for (const sessionId of [...this.entries.keys()]) {
      this.scheduleRebuild(sessionId, reason);
    }
  }

  private rebuildNow(entry: PoolEntry, reason: string): void {
    const runtime = entry.runtime;
    entry.runtime = undefined;
    if (!runtime) return;
    this.options.log?.(`[runtime] ${reason}：释放当前 runtime，下次 prompt 续接重建`);
    this.disposeRuntime(entry.sessionId, runtime);
  }

  /** 定向中止：只作用于该会话的 runtime，不牵连另一席。 */
  abort(sessionId: string, mode?: 'cancel' | 'stop'): void {
    const runtime = this.entries.get(sessionId)?.runtime;
    if (!runtime) return;
    try {
      runtime.abort(mode);
    } catch (err) {
      this.options.log?.(
        `[runtime] abort 失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 驱逐会话：释放 runtime、移出席位，并回调上层清理会话运行态。 */
  evict(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    const wasBusy = entry.busy;
    entry.busy = false;
    const runtime = entry.runtime;
    entry.runtime = undefined;
    if (runtime) this.disposeRuntime(sessionId, runtime);
    // 创建中的 runtime 由 ensure 的 then 分支检测到 entry 已换代后自行释放。
    if (wasBusy) this.options.onBusyChange?.();
    this.options.onEvicted?.(sessionId);
  }

  /** maxParallel=1 时切换会话即释放其余席位（保持既有单会话行为）。 */
  evictAllExcept(keepSessionId: string): void {
    for (const sessionId of [...this.entries.keys()]) {
      if (sessionId !== keepSessionId) this.evict(sessionId);
    }
  }

  dispose(): void {
    for (const sessionId of [...this.entries.keys()]) {
      this.evict(sessionId);
    }
  }

  private disposeRuntime(sessionId: string, runtime: RuntimeLike): void {
    void Promise.resolve()
      .then(() => runtime.dispose())
      .catch((err) =>
        this.options.log?.(
          `[runtime] dispose 失败（${sessionId}）: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}
