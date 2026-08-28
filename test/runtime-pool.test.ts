/**
 * SessionRuntimePool（P2：atOpsAgent.sessions.maxParallel ≤ 2）单元测试。
 *
 * 池是 vscode-free 的：配置 / 驱逐 / busy 回调全部注入，这里直接以
 * 假 runtime 工厂驱动，验证并行席位、LRU 驱逐、逐会话 abort 与
 * 「运行中挂起重建、idle 后释放」的语义。
 */
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeLike } from '../src/host/hostTypes';
import {
  MAX_PARALLEL_SESSIONS,
  SessionPoolExhaustedError,
  SessionRuntimePool,
  type SessionRuntimePoolOptions
} from '../src/host/services/runtimePool';

type FakeRuntime = RuntimeLike & {
  id: string;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

function makeFakeRuntime(id: string): FakeRuntime {
  return {
    id,
    prompt: vi.fn(async () => {}),
    abort: vi.fn(),
    dispose: vi.fn()
  };
}

/** dispose 走微任务（Promise.resolve().then），等一个宏任务即可观测。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function tick(ms = 2): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness(overrides: Partial<SessionRuntimePoolOptions> = {}) {
  const created: FakeRuntime[] = [];
  const evicted: string[] = [];
  let busyChanges = 0;
  let max = 2;
  const pool = new SessionRuntimePool({
    maxParallel: () => max,
    createRuntime: async (sessionId) => {
      const runtime = makeFakeRuntime(sessionId);
      created.push(runtime);
      return runtime;
    },
    onEvicted: (sessionId) => evicted.push(sessionId),
    onBusyChange: () => {
      busyChanges += 1;
    },
    ...overrides
  });
  return {
    pool,
    created,
    evicted,
    setMax: (n: number) => {
      max = n;
    },
    busyChanges: () => busyChanges
  };
}

describe('SessionRuntimePool · maxParallel 配置', () => {
  it('effectiveMaxParallel 夹到 [1, 2]：0→1、5→2、NaN→1', () => {
    const h = createHarness();
    h.setMax(0);
    expect(h.pool.effectiveMaxParallel()).toBe(1);
    h.setMax(5);
    expect(h.pool.effectiveMaxParallel()).toBe(MAX_PARALLEL_SESSIONS);
    h.setMax(Number.NaN);
    expect(h.pool.effectiveMaxParallel()).toBe(1);
    h.setMax(2);
    expect(h.pool.effectiveMaxParallel()).toBe(2);
  });
});

describe('SessionRuntimePool · 并行席位与隔离', () => {
  it('maxParallel=2：两个会话各持独立 runtime，busy 互不影响', async () => {
    const h = createHarness();
    const a = await h.pool.ensure('sess-a');
    const b = await h.pool.ensure('sess-b');
    expect(a).not.toBe(b);
    expect(h.pool.liveSessionIds().sort()).toEqual(['sess-a', 'sess-b']);

    h.pool.markBusy('sess-a');
    expect(h.pool.isBusy('sess-a')).toBe(true);
    expect(h.pool.isBusy('sess-b')).toBe(false);
    expect(h.busyChanges()).toBe(1);

    // 已入池会话再次 ensure 直接复用，不重复创建。
    expect(await h.pool.ensure('sess-a')).toBe(a);
    expect(h.created).toHaveLength(2);
  });

  it('同会话并发 ensure 去重为一次创建', async () => {
    const h = createHarness();
    const [r1, r2] = await Promise.all([h.pool.ensure('sess-a'), h.pool.ensure('sess-a')]);
    expect(r1).toBe(r2);
    expect(h.created).toHaveLength(1);
  });

  it('abort 只定向目标会话，另一席不受牵连', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    const b = (await h.pool.ensure('sess-b')) as FakeRuntime;
    h.pool.abort('sess-a', 'stop');
    expect(a.abort).toHaveBeenCalledWith('stop');
    expect(b.abort).not.toHaveBeenCalled();
  });
});

describe('SessionRuntimePool · 名额与驱逐', () => {
  it('名额满：LRU 驱逐最久未活动的空闲会话给新会话让位', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    await tick();
    await h.pool.ensure('sess-b');
    await h.pool.ensure('sess-c');
    await flush();

    expect(h.evicted).toEqual(['sess-a']);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(h.pool.runtimeOf('sess-a')).toBeUndefined();
    expect(h.pool.liveSessionIds().sort()).toEqual(['sess-b', 'sess-c']);
  });

  it('全部席位在忙：抛 SessionPoolExhaustedError，不驱逐运行中的会话', async () => {
    const h = createHarness();
    await h.pool.ensure('sess-a');
    await h.pool.ensure('sess-b');
    h.pool.markBusy('sess-a');
    h.pool.markBusy('sess-b');

    await expect(h.pool.ensure('sess-c')).rejects.toBeInstanceOf(SessionPoolExhaustedError);
    expect(h.evicted).toEqual([]);
    expect(h.pool.liveSessionIds().sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('evictAllExcept 只保留指定会话（maxParallel=1 的切换语义）', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    const b = (await h.pool.ensure('sess-b')) as FakeRuntime;
    h.pool.evictAllExcept('sess-b');
    await flush();

    expect(h.evicted).toEqual(['sess-a']);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    expect(h.pool.runtimeOf('sess-b')).toBeDefined();
  });

  it('创建期间被驱逐：runtime 到货后直接释放，不入池', async () => {
    let release: (runtime: RuntimeLike) => void = () => {};
    const pending = makeFakeRuntime('late');
    const h = createHarness({
      createRuntime: () =>
        new Promise<RuntimeLike>((resolve) => {
          release = resolve;
        })
    });

    const creation = h.pool.ensure('sess-a');
    h.pool.evict('sess-a');
    release(pending);
    await creation;
    await flush();

    expect(pending.dispose).toHaveBeenCalledTimes(1);
    expect(h.pool.runtimeOf('sess-a')).toBeUndefined();
    expect(h.evicted).toEqual(['sess-a']);
  });

  it('dispose 清空所有席位并释放全部 runtime', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    const b = (await h.pool.ensure('sess-b')) as FakeRuntime;
    h.pool.dispose();
    await flush();

    expect(h.evicted.sort()).toEqual(['sess-a', 'sess-b']);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(h.pool.liveSessionIds()).toEqual([]);
  });
});

describe('SessionRuntimePool · 重建（P1-15 逐 runtime）', () => {
  it('运行中 scheduleRebuild 挂起，idle 后才释放；席位保留、下次 ensure 重建', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    h.pool.markBusy('sess-a');
    h.pool.scheduleRebuild('sess-a', '换模型');
    await flush();
    expect(a.dispose).not.toHaveBeenCalled();
    expect(h.pool.runtimeOf('sess-a')).toBe(a);

    h.pool.markIdle('sess-a');
    await flush();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(h.pool.runtimeOf('sess-a')).toBeUndefined();
    // 重建 ≠ 驱逐：会话运行态（审批/playbook）不被清理。
    expect(h.evicted).toEqual([]);

    const rebuilt = await h.pool.ensure('sess-a');
    expect(rebuilt).not.toBe(a);
    expect(h.created).toHaveLength(2);
  });

  it('空闲时 scheduleRebuild 立即释放 runtime', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    h.pool.scheduleRebuild('sess-a', '工具目录变化');
    await flush();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(h.evicted).toEqual([]);
  });

  it('scheduleRebuildAll 对每席独立生效：忙的挂起、闲的立即', async () => {
    const h = createHarness();
    const a = (await h.pool.ensure('sess-a')) as FakeRuntime;
    const b = (await h.pool.ensure('sess-b')) as FakeRuntime;
    h.pool.markBusy('sess-a');
    h.pool.scheduleRebuildAll('换模型');
    await flush();

    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalledTimes(1);

    h.pool.markIdle('sess-a');
    await flush();
    expect(a.dispose).toHaveBeenCalledTimes(1);
  });
});
