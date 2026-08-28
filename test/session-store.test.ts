/**
 * SessionStore 会话切换（vscode-free）：
 * switchSession 先把当前会话态存回内存包，再整体恢复目标会话的
 * transcript / playbook / 简报 / 子代理卡片 / 时间线（UI 收敛后
 * 历史抽屉与设置页 Sessions 页签共同依赖）。
 */
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/host/sessionStore';
import type { ApprovalBriefView, SubagentCard } from '../src/protocol';

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
    const store = new SessionStore();
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
    const store = new SessionStore();
    const active = store.activeSessionId;
    store.appendItem({ kind: 'user', id: 'u1', text: 'hi' });

    expect(store.switchSession('does-not-exist')).toBe(false);
    expect(store.activeSessionId).toBe(active);
    expect(store.items).toHaveLength(1);

    expect(store.switchSession(active)).toBe(true);
    expect(store.items).toHaveLength(1);
  });

  it('snapshot 附带会话列表（历史抽屉数据源）', () => {
    const store = new SessionStore();
    const first = store.activeSessionId;
    const second = store.newSession().id;

    const snap = store.snapshot({});
    expect(snap.sessions?.map((s) => s.id)).toEqual([first, second]);
    expect(snap.sessions?.[0]).toHaveProperty('title');
    expect(snap.sessions?.[0]).toHaveProperty('createdAt');
  });
});
