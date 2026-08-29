/**
 * SessionStore（vscode-free）：
 * - switchSession 先把当前会话态存回内存包，再整体恢复目标会话的
 *   transcript / playbook / 简报 / 子代理卡片 / 时间线；
 * - P1-3 / P0-C：持久化到 <tmp>/ui-sessions.json 并在构造时回载
 *   （标题取首条用户消息；sessionFile 随会话保存；流式中断项被清洗）。
 * 测试一律用临时目录，绝不读写真实 ~/.at-series。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalService } from '../src/host/services/approvalService';
import type { HostContext } from '../src/host/services/context';
import { SessionStore } from '../src/host/sessionStore';
import type { ApprovalBriefView, SubagentCard } from '../src/protocol';

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

const tempDirs: string[] = [];

function tempStore(filePath?: string): { store: SessionStore; filePath: string } {
  const dir = filePath ? path.dirname(filePath) : mkdtempSync(path.join(os.tmpdir(), 'at-ops-sessions-'));
  if (!filePath) tempDirs.push(dir);
  const file = filePath ?? path.join(dir, 'ui-sessions.json');
  return { store: new SessionStore({ filePath: file }), filePath: file };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function brief(id: string): ApprovalBriefView {
  return { id, risk: 'exec', targetLabel: `变更 ${id}`, elements: {}, dualConfirmHint: true };
}

function card(taskId: string): SubagentCard {
  return {
    taskId,
    role: 'investigator',
    label: `调查 ${taskId}`,
    status: 'running',
    riskCeiling: 'read',
    toolCalls: { used: 1, max: 10 },
    wallMs: { used: 100, max: 60_000 }
  };
}

describe('SessionStore · switchSession', () => {
  it('保存当前会话态并恢复目标会话的完整内存包', () => {
    const { store } = tempStore();
    const first = store.activeSessionId;

    store.appendItem({ kind: 'user', id: 'u1', text: '第一会话消息' });
    store.setPlaybook({ id: 'pb.incident', stage: 'investigating' });
    store.addBrief(brief('brief-1'));
    store.upsertSubagent(card('task-1'));
    store.appendTimeline({ kind: 'playbook_stage', stage: 'investigating' });

    const second = store.newSession().id;
    expect(store.activeSessionId).toBe(second);
    // 新会话是干净的
    expect(store.items).toHaveLength(0);
    expect(store.playbook).toBeUndefined();
    expect(store.pendingBriefs).toHaveLength(0);
    expect(store.timeline).toHaveLength(0);

    store.appendItem({ kind: 'user', id: 'u2', text: '第二会话消息' });

    // 切回第一会话：全部会话态恢复（user 消息 + 子代理卡片两条 transcript）
    expect(store.switchSession(first)).toBe(true);
    expect(store.activeSessionId).toBe(first);
    expect(store.items.map((i) => i.kind)).toEqual(['user', 'subagents']);
    expect(store.items[0]).toMatchObject({ kind: 'user', id: 'u1', text: '第一会话消息' });
    expect(store.playbook).toEqual({ id: 'pb.incident', stage: 'investigating' });
    expect(store.pendingBriefs.map((b) => b.id)).toEqual(['brief-1']);
    expect(store.getSubagent('task-1')?.label).toBe('调查 task-1');
    expect(store.timeline).toHaveLength(1);

    // 再切回第二会话：第二会话的 transcript 原样保留
    expect(store.switchSession(second)).toBe(true);
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ kind: 'user', id: 'u2' });
    expect(store.playbook).toBeUndefined();
  });

  it('未知会话 id 返回 false 且不改动当前状态；切到当前会话是 no-op', () => {
    const { store } = tempStore();
    const active = store.activeSessionId;
    store.appendItem({ kind: 'user', id: 'u1', text: 'hi' });

    expect(store.switchSession('does-not-exist')).toBe(false);
    expect(store.activeSessionId).toBe(active);
    expect(store.items).toHaveLength(1);

    expect(store.switchSession(active)).toBe(true);
    expect(store.items).toHaveLength(1);
  });

  it('snapshot 附带会话列表（历史抽屉数据源）', () => {
    const { store } = tempStore();
    const first = store.activeSessionId;
    const second = store.newSession().id;

    const snap = store.snapshot({});
    expect(snap.sessions?.map((s) => s.id)).toEqual([first, second]);
    expect(snap.sessions?.[0]).toHaveProperty('title');
    expect(snap.sessions?.[0]).toHaveProperty('createdAt');
  });
});

describe('SessionStore · 标题', () => {
  it('首条用户消息覆盖自动标题「会话 N」，超长截 40 字', () => {
    const { store } = tempStore();
    expect(store.sessions[0].title).toMatch(/^会话 \d+$/);

    store.appendItem({ kind: 'user', id: 'u1', text: '  查一下  支付网关  超时  ' });
    expect(store.sessions[0].title).toBe('查一下 支付网关 超时');

    // 第二条不再覆盖
    store.appendItem({ kind: 'user', id: 'u2', text: '另一条消息' });
    expect(store.sessions[0].title).toBe('查一下 支付网关 超时');
  });

  it('超长首条消息截断并带省略号', () => {
    const { store } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: 'x'.repeat(120) });
    expect(store.sessions[0].title).toBe(`${'x'.repeat(40)}…`);
  });
});

describe('SessionStore · 持久化（P1-3 / P0-C）', () => {
  it('persistNow 后同路径新实例回载会话、transcript、playbook 与 sessionFile', () => {
    const { store, filePath } = tempStore();
    const first = store.activeSessionId;
    store.appendItem({ kind: 'user', id: 'u1', text: '排查磁盘告警' });
    store.setPlaybook({ id: 'pb.diagnose', stage: 'observe' });
    store.setSessionFile(first, '/tmp/pi/session-1.jsonl');
    const second = store.newSession().id;
    store.appendItem({ kind: 'user', id: 'u2', text: '第二会话' });
    store.persistNow();

    const revived = new SessionStore({ filePath });
    expect(revived.sessions.map((s) => s.id)).toEqual([first, second]);
    expect(revived.sessions[0].title).toBe('排查磁盘告警');
    expect(revived.sessionFileOf(first)).toBe('/tmp/pi/session-1.jsonl');
    // 活动会话恢复为持久化时的活动会话
    expect(revived.activeSessionId).toBe(second);
    expect(revived.items[0]).toMatchObject({ kind: 'user', text: '第二会话' });

    expect(revived.switchSession(first)).toBe(true);
    expect(revived.items[0]).toMatchObject({ kind: 'user', text: '排查磁盘告警' });
    expect(revived.playbook).toEqual({ id: 'pb.diagnose', stage: 'observe' });
    revived.dispose();
    store.dispose();
  });

  it('回载时清洗流式中断项：assistant streaming 收尾、running 工具标记 interrupted；待批简报作废', () => {
    const { store, filePath } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: 'hi' });
    store.appendItem({ kind: 'assistant', id: 'a1', text: '回复中', streaming: true });
    store.appendItem({
      kind: 'tool',
      id: 't1',
      call: { name: 'k8s.rollout', risk: 'exec', status: 'running' }
    });
    store.addBrief(brief('brief-x'));
    store.persistNow();

    const revived = new SessionStore({ filePath });
    const assistant = revived.items.find((i) => i.id === 'a1');
    expect(assistant).toMatchObject({ kind: 'assistant', streaming: false });
    const tool = revived.items.find((i) => i.id === 't1');
    expect(tool).toMatchObject({ kind: 'tool', call: { status: 'interrupted' } });
    // 审批令牌只在 host 内存：跨重载简报一律作废
    expect(revived.pendingBriefs).toHaveLength(0);
    revived.dispose();
    store.dispose();
  });

  it('持久化文件缺失或损坏时回退到全新会话（不抛异常）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-sessions-'));
    tempDirs.push(dir);

    const missing = new SessionStore({ filePath: path.join(dir, 'missing.json') });
    expect(missing.sessions).toHaveLength(1);
    expect(missing.items).toHaveLength(0);
    missing.dispose();

    const corruptPath = path.join(dir, 'corrupt.json');
    writeFileSync(corruptPath, '{not json', 'utf8');
    const corrupt = new SessionStore({ filePath: corruptPath });
    expect(corrupt.sessions).toHaveLength(1);
    expect(corrupt.items).toHaveLength(0);
    corrupt.dispose();
  });

  it('persistNow 刮密 tool preview / errorMessage / text，磁盘无 Bearer 明文', () => {
    const { store, filePath } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: 'Authorization: Bearer secret-token' });
    store.appendItem({
      kind: 'tool',
      id: 't1',
      call: {
        name: 'http.dump',
        risk: 'read',
        status: 'ok',
        preview: 'Authorization: Bearer secret-token'
      }
    });
    store.appendItem({
      kind: 'tool',
      id: 't2',
      call: {
        name: 'db.query',
        pluginId: 'at.database',
        risk: 'read',
        status: 'error',
        errorCode: 'E_AUTH',
        errorMessage: 'password=hunter2 rejected'
      }
    });
    store.persistNow();

    const disk = readFileSync(filePath, 'utf8');
    expect(disk).not.toContain('secret-token');
    expect(disk).not.toContain('hunter2');
    expect(disk).toContain('[REDACTED]');
    store.dispose();
  });
});

describe('SessionStore · appendItem ts / patchItem（Plan 10）', () => {
  it('调用方省略 ts 时 appendItem 写入 Date.now()', () => {
    const { store } = tempStore();
    const before = Date.now();
    store.appendItem({ kind: 'user', id: 'u1', text: 'hi' });
    expect(typeof store.items[0]?.ts).toBe('number');
    expect(store.items[0]!.ts).toBeGreaterThanOrEqual(before);
    store.dispose();
  });

  it('调用方传入 ts 时不覆盖', () => {
    const { store } = tempStore();
    store.appendItem({ kind: 'assistant', id: 'a1', text: 'ok', ts: 42 });
    expect(store.items[0]).toMatchObject({ id: 'a1', ts: 42 });
    store.dispose();
  });

  it('patchItem 按 id 合并；persist/hydrate 不丢 approval decision+ts', () => {
    const { store, filePath } = tempStore();
    store.appendItem({ kind: 'approval', id: 'ap1', briefId: 'brief-1', decision: 'pending' });
    const ts = 1_703_000_000_000;
    expect(store.patchItem('ap1', { decision: 'approved', ts })).toMatchObject({
      kind: 'approval',
      decision: 'approved',
      ts
    });
    expect(store.patchItem('missing', { decision: 'rejected' })).toBeUndefined();
    store.persistNow();

    const revived = new SessionStore({ filePath });
    expect(revived.items.find((i) => i.id === 'ap1')).toMatchObject({
      kind: 'approval',
      briefId: 'brief-1',
      decision: 'approved',
      ts
    });
    revived.dispose();
    store.dispose();
  });
});

describe('ApprovalService · registerBrief + applyApproval 写 decision+ts', () => {
  it('register 为 pending；applyApproval 后 itemsOf 为 approved 且 ts 为 number；hydrate 不丢', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-approval-item-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'ui-sessions.json');
    const store = new SessionStore({ filePath });
    const ctx = {
      store,
      hub: { listAllTools: () => [] },
      playbooks: { runOf: () => undefined },
      log: () => {},
      broadcastToSession: () => {}
    } as unknown as HostContext;
    const svc = new ApprovalService(ctx);
    svc._timeoutMsForTest = 0;
    const sid = store.activeSessionId;
    const pending = svc.resolveSessionApproval(sid, {
      toolName: 'k8s.rollback',
      args: { deployment: 'nginx' },
      risk: 'exec'
    });
    const approval = store.items.find((i) => i.kind === 'approval');
    expect(approval).toMatchObject({ kind: 'approval', decision: 'pending' });
    expect(typeof approval?.ts).toBe('number');
    const briefId = approval && approval.kind === 'approval' ? approval.briefId : '';
    await svc.applyApproval({ briefId, decision: 'approved' });
    await pending;
    const decided = store.itemsOf(sid).find((i) => i.kind === 'approval' && i.briefId === briefId);
    expect(decided).toMatchObject({ kind: 'approval', decision: 'approved' });
    expect(typeof decided?.ts).toBe('number');
    store.persistNow();
    svc.dispose();
    store.dispose();

    const revived = new SessionStore({ filePath });
    expect(revived.items.find((i) => i.kind === 'approval')).toMatchObject({
      kind: 'approval',
      briefId,
      decision: 'approved'
    });
    expect(typeof revived.items.find((i) => i.kind === 'approval')?.ts).toBe('number');
    revived.dispose();
  });
});

describe('SessionStore · rename / delete', () => {
  it('renameSession trim、空拒、超长截断，persist 写回标题', () => {
    const { store, filePath } = tempStore();
    const id = store.activeSessionId;
    expect(store.renameSession(id, '  支付网关超时  ')).toBe(true);
    expect(store.sessions[0].title).toBe('支付网关超时');
    expect(store.renameSession(id, '   ')).toBe(false);
    expect(store.sessions[0].title).toBe('支付网关超时');
    expect(store.renameSession('missing', 'x')).toBe(false);
    expect(store.renameSession(id, 'y'.repeat(80))).toBe(true);
    expect(store.sessions[0].title).toBe(`${'y'.repeat(40)}…`);
    store.persistNow();

    const revived = new SessionStore({ filePath });
    expect(revived.sessions[0].title).toBe(`${'y'.repeat(40)}…`);
    revived.dispose();
    store.dispose();
  });

  it('deleteSession 删 bag+列表；删活动会话切到最近一条；删光则 newSession', () => {
    const { store, filePath } = tempStore();
    const first = store.activeSessionId;
    store.appendItem({ kind: 'user', id: 'u1', text: '第一' });
    const second = store.newSession().id;
    store.appendItem({ kind: 'user', id: 'u2', text: '第二' });
    expect(store.deleteSession('missing')).toBe(false);

    expect(store.deleteSession(first)).toBe(true);
    expect(store.sessions.map((s) => s.id)).toEqual([second]);
    expect(store.activeSessionId).toBe(second);
    expect(store.switchSession(first)).toBe(false);

    expect(store.deleteSession(second)).toBe(true);
    expect(store.sessions).toHaveLength(1);
    expect(store.activeSessionId.length).toBeGreaterThan(0);
    expect(store.activeSessionId).not.toBe(second);
    expect(store.items).toHaveLength(0);
    store.persistNow();

    const revived = new SessionStore({ filePath });
    expect(revived.sessions.map((s) => s.id)).not.toContain(first);
    expect(revived.sessions.map((s) => s.id)).not.toContain(second);
    expect(revived.activeSessionId.length).toBeGreaterThan(0);
    revived.dispose();
    store.dispose();
  });
});
