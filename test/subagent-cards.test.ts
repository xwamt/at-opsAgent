/**
 * patchSubagentCard（vscode-free）：
 * - 新卡标题取 goal，缺席时取角色名——绝不用 latest 大段文本当标题；
 * - 增量合并：goal / visibleTools / latest / status / role 缺席时保留既有值，
 *   goal 到达后升级 label，latest 只进 latest 字段。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/host/sessionStore';
import type { HostContext } from '../src/host/services/context';
import { patchSubagentCard } from '../src/host/services/subagentCards';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCtx(): { ctx: HostContext; store: SessionStore; broadcasts: unknown[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-subagent-cards-'));
  tempDirs.push(dir);
  const store = new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') });
  const broadcasts: unknown[] = [];
  const ctx = {
    store,
    broadcastToSession: (_sid: string, _type: string, payload: unknown) => {
      broadcasts.push(payload);
    }
  } as unknown as HostContext;
  return { ctx, store, broadcasts };
}

describe('patchSubagentCard', () => {
  it('新卡：label 取 goal，latest 只进 latest，visibleTools 落卡', () => {
    const { ctx, store } = fakeCtx();
    const sid = store.activeSessionId;
    const live = patchSubagentCard(ctx, sid, 't1', {
      status: 'running',
      role: 'investigator',
      goal: '检查磁盘水位',
      visibleTools: ['run_remote_command', 'get_terminal_context'],
      latest: '一大段中间输出……'.repeat(50)
    });
    expect(live).toBe(true);
    const card = store.getSubagent('t1', sid);
    expect(card?.label).toBe('检查磁盘水位');
    expect(card?.goal).toBe('检查磁盘水位');
    expect(card?.visibleTools).toEqual(['run_remote_command', 'get_terminal_context']);
    expect(card?.latest).toContain('一大段中间输出');
  });

  it('新卡无 goal：label 取角色名而不是 latest 文本', () => {
    const { ctx, store } = fakeCtx();
    const sid = store.activeSessionId;
    patchSubagentCard(ctx, sid, 't2', { status: 'queued', role: 'writer', latest: '巨量日志输出' });
    const card = store.getSubagent('t2', sid);
    expect(card?.label).toBe('writer');
    expect(card?.latest).toBe('巨量日志输出');
  });

  it('合并：latest 更新绝不覆盖 label；goal/visibleTools 缺席时保留', () => {
    const { ctx, store } = fakeCtx();
    const sid = store.activeSessionId;
    patchSubagentCard(ctx, sid, 't3', {
      status: 'running',
      goal: '巡检 web-01',
      visibleTools: ['run_remote_command']
    });
    patchSubagentCard(ctx, sid, 't3', { status: 'ok', latest: '终态摘要：一切正常……' });
    const card = store.getSubagent('t3', sid);
    expect(card?.label).toBe('巡检 web-01');
    expect(card?.goal).toBe('巡检 web-01');
    expect(card?.visibleTools).toEqual(['run_remote_command']);
    expect(card?.status).toBe('ok');
    expect(card?.latest).toBe('终态摘要：一切正常……');
  });

  it('合并：goal 迟到时升级 label（旧卡曾以角色名做标题）', () => {
    const { ctx, store } = fakeCtx();
    const sid = store.activeSessionId;
    patchSubagentCard(ctx, sid, 't4', { status: 'queued', role: 'investigator' });
    expect(store.getSubagent('t4', sid)?.label).toBe('investigator');
    patchSubagentCard(ctx, sid, 't4', { status: 'running', goal: '排查 nginx 5xx' });
    expect(store.getSubagent('t4', sid)?.label).toBe('排查 nginx 5xx');
  });

  it('终态返回非 live；每次 patch 都广播 subagent/upsert', () => {
    const { ctx, store, broadcasts } = fakeCtx();
    const sid = store.activeSessionId;
    expect(patchSubagentCard(ctx, sid, 't5', { status: 'running' })).toBe(true);
    expect(patchSubagentCard(ctx, sid, 't5', { status: 'failed', latest: '出错了' })).toBe(false);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]).toMatchObject({ taskId: 't5', status: 'failed', latest: '出错了' });
  });

  it('支持 transcript 增量写入与持久化回载', () => {
    const { ctx, store } = fakeCtx();
    const sid = store.activeSessionId;
    patchSubagentCard(ctx, sid, 't6', {
      status: 'ok',
      role: 'investigator',
      goal: '分析慢查询',
      transcript: [
        { kind: 'assistant', id: 'a1', text: '正在排查...', streaming: false },
        { kind: 'thinking', id: 'th1', steps: ['step 1', 'step 2'], durationMs: 100 },
        {
          kind: 'tool',
          id: 'tc1',
          call: { name: 'mysql_slow_log', risk: 'read', status: 'ok', preview: 'slow queries found' }
        }
      ]
    });

    const card = store.getSubagent('t6', sid);
    expect(card?.transcript).toHaveLength(3);
    expect(card?.transcript?.[0].kind).toBe('assistant');
    expect(card?.transcript?.[1].kind).toBe('thinking');
    expect(card?.transcript?.[2].kind).toBe('tool');

    // 落盘并用新 store 回载
    store.persistNow();
    const store2 = new SessionStore({ filePath: (store as unknown as { persistPath: string }).persistPath });
    const card2 = store2.getSubagent('t6', store2.activeSessionId);
    expect(card2).toBeDefined();
    expect(card2?.transcript).toHaveLength(3);
    expect(card2?.label).toBe('分析慢查询');
  });
});
