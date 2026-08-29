/**
 * Plan 05：审批 waiter TTL + 软停解挂（注入短超时，不改生产 15min 默认）。
 *
 * ApprovalService / ChatService 顶层 import vscode，这里用 vi.mock 替身；
 * 超时毫秒经 `_timeoutMsForTest` 注入，禁止把生产默认改成几十毫秒。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue
    })
  },
  commands: {
    executeCommand: () => Promise.resolve()
  }
}));

import {
  ApprovalService,
  DEFAULT_APPROVAL_TIMEOUT_MS
} from '../src/host/services/approvalService';
import { ChatService } from '../src/host/services/chatService';
import type { HostContext } from '../src/host/services/context';
import { SessionStore } from '../src/host/sessionStore';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Broadcast {
  type: string;
  payload: unknown;
}

interface Notice {
  text: string;
  sessionId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raceDecision(
  promise: Promise<'approved' | 'rejected'>,
  ms: number
): Promise<'approved' | 'rejected' | 'hung'> {
  return Promise.race([
    promise,
    sleep(ms).then(() => 'hung' as const)
  ]);
}

function createApprovalHarness(): {
  svc: ApprovalService;
  store: SessionStore;
  sid: string;
  broadcasts: Broadcast[];
  notices: Notice[];
  logs: string[];
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-approval-ttl-'));
  tempDirs.push(dir);
  const store = new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') });
  const broadcasts: Broadcast[] = [];
  const notices: Notice[] = [];
  const logs: string[] = [];
  const ctx = {
    store,
    hub: { listAllTools: () => [] },
    playbooks: { runOf: () => undefined },
    log: (m: string) => {
      logs.push(m);
    },
    broadcastToSession: (_sid: string, type: string, payload: unknown) => {
      broadcasts.push({ type, payload });
    },
    emitAssistantNotice: (text: string, sessionId?: string) => {
      notices.push({ text, sessionId });
    }
  } as unknown as HostContext;
  return {
    svc: new ApprovalService(ctx),
    store,
    sid: store.activeSessionId,
    broadcasts,
    notices,
    logs
  };
}

function requestExec(svc: ApprovalService, sessionId: string): Promise<'approved' | 'rejected'> {
  return svc.resolveSessionApproval(sessionId, {
    toolName: 'terminal_run_command',
    args: { command: 'systemctl restart nginx' },
    risk: 'exec'
  });
}

describe('approval TTL · waiter 超时 fail-closed', () => {
  it('生产默认仍是 15min（测试注入不得改此常量）', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(900_000);
  });

  it('timeoutMs: 50 且不调用 applyApproval → 200ms 内 rejected（永不 approved）', async () => {
    const { svc, store, sid, broadcasts, notices, logs } = createApprovalHarness();
    svc._timeoutMsForTest = 50;
    const pending = requestExec(svc, sid);
    expect(store.pendingBriefs.length).toBe(1);
    const briefId = store.pendingBriefs[0]!.id;

    const decision = await raceDecision(pending, 200);
    expect(decision).toBe('rejected');
    expect(decision).not.toBe('approved');
    expect(store.pendingBriefs.find((b) => b.id === briefId)).toBeUndefined();
    expect(
      broadcasts.some(
        (b) =>
          b.type === 'approval/resolve' &&
          (b.payload as { briefId?: string; decision?: string }).briefId === briefId &&
          (b.payload as { decision?: string }).decision === 'rejected'
      )
    ).toBe(true);
    expect(notices.some((n) => n.text === '审批已超时，已按拒绝处理' && n.sessionId === sid)).toBe(
      true
    );
    expect(logs.some((l) => l.includes('审批超时') && l.includes(briefId))).toBe(true);
    expect(store.timeline.some((e) => e.kind === 'approval' && e.decision === 'timeout')).toBe(
      true
    );

    svc.dispose();
  });

  it('超时后可再挂起新审批（席位未永久占用）', async () => {
    const { svc, store, sid } = createApprovalHarness();
    svc._timeoutMsForTest = 50;
    await expect(raceDecision(requestExec(svc, sid), 200)).resolves.toBe('rejected');
    expect(store.pendingBriefs).toHaveLength(0);

    const second = requestExec(svc, sid);
    expect(store.pendingBriefs).toHaveLength(1);
    svc.rejectWaitersFor(sid);
    await expect(second).resolves.toBe('rejected');
    svc.dispose();
  });

  it('applyApproval 在超时前批准 → timer 已 clear，不会随后又 reject', async () => {
    const { svc, store, sid } = createApprovalHarness();
    svc._timeoutMsForTest = 200;
    const pending = requestExec(svc, sid);
    const briefId = store.pendingBriefs[0]!.id;
    await svc.applyApproval({ briefId, decision: 'approved' });
    await expect(pending).resolves.toBe('approved');
    await sleep(250);
    await expect(pending).resolves.toBe('approved');
    svc.dispose();
  });

  it('未注入短 TTL 时 80ms 内不落定（生产默认 15min 仍生效）', async () => {
    const { svc, sid } = createApprovalHarness();
    const pending = requestExec(svc, sid);
    expect(await raceDecision(pending, 80)).toBe('hung');
    svc.rejectWaitersFor(sid);
    await expect(pending).resolves.toBe('rejected');
    svc.dispose();
  });

  it('timeoutMs=0 禁用超时', async () => {
    const { svc, sid } = createApprovalHarness();
    svc._timeoutMsForTest = 0;
    const pending = requestExec(svc, sid);
    expect(await raceDecision(pending, 80)).toBe('hung');
    svc.rejectWaitersFor(sid);
    await expect(pending).resolves.toBe('rejected');
    svc.dispose();
  });
});

describe('abort cancel / stop 解挂 waiter', () => {
  it('rejectWaitersFor 将挂起审批按 rejected 落定', async () => {
    const { svc, sid } = createApprovalHarness();
    svc._timeoutMsForTest = 0;
    const pending = requestExec(svc, sid);
    svc.rejectWaitersFor(sid);
    await expect(pending).resolves.toBe('rejected');
    svc.dispose();
  });

  it("ChatService.abort('cancel') 与 abort('stop') 都调用 rejectWaitersFor", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-abort-cancel-'));
    tempDirs.push(dir);
    const store = new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') });
    const rejectWaitersFor = vi.fn();
    const ctx = {
      store,
      approvals: { rejectWaitersFor },
      playbooks: { getPlaybooks: async () => [] },
      playbooksDir: path.join(dir, 'playbooks'),
      log: () => {}
    } as unknown as HostContext;
    const chat = new ChatService(ctx);
    const sid = store.activeSessionId;

    chat.abort('cancel');
    expect(rejectWaitersFor).toHaveBeenCalledWith(sid);

    rejectWaitersFor.mockClear();
    chat.abort('stop');
    expect(rejectWaitersFor).toHaveBeenCalledWith(sid);

    chat.dispose();
  });

  it("abort('cancel') 解开真实 ApprovalService waiter", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-abort-waiter-'));
    tempDirs.push(dir);
    const store = new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') });
    const ctx = {
      store,
      hub: { listAllTools: () => [] },
      playbooks: {
        runOf: () => undefined,
        getPlaybooks: async () => []
      },
      playbooksDir: path.join(dir, 'playbooks'),
      log: () => {},
      broadcastToSession: () => {},
      emitAssistantNotice: () => {},
      approvals: undefined as unknown
    } as unknown as HostContext;
    const approvals = new ApprovalService(ctx);
    approvals._timeoutMsForTest = 0;
    (ctx as { approvals: ApprovalService }).approvals = approvals;
    const chat = new ChatService(ctx);
    const sid = store.activeSessionId;

    const pending = requestExec(approvals, sid);
    chat.abort('cancel', sid);
    await expect(pending).resolves.toBe('rejected');

    chat.dispose();
    approvals.dispose();
  });
});
