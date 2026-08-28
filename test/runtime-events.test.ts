/**
 * RuntimeEventRouter（docs/14 P0-id）：runtime 对同一 assistant 消息的
 * thinking_delta / text_delta 共用一个消息 id，router 必须按 kind 拆成
 * `${id}:thinking` / `${id}:assistant` 两个 transcript 项——否则先到的
 * thinking 项占住 id，正文被 appendAssistantText 静默丢弃（用户只见工具卡）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/host/sessionStore';
import type { HostContext } from '../src/host/services/context';
import { RuntimeEventRouter } from '../src/host/services/runtimeEvents';

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

function fakeRouter(): {
  router: RuntimeEventRouter;
  store: SessionStore;
  sid: string;
  broadcasts: Broadcast[];
  idled: string[];
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-runtime-events-'));
  tempDirs.push(dir);
  const store = new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') });
  const broadcasts: Broadcast[] = [];
  const ctx = {
    store,
    broadcastToSession: (_sid: string, type: string, payload: unknown) => {
      broadcasts.push({ type, payload });
    }
  } as unknown as HostContext;
  const idled: string[] = [];
  const router = new RuntimeEventRouter(ctx, {
    onIdle: (sessionId) => idled.push(sessionId),
    setUsage: () => {}
  });
  return { router, store, sid: store.activeSessionId, broadcasts, idled };
}

describe('RuntimeEventRouter：thinking / assistant 分 id（P0-id）', () => {
  it('thinking 先到、正文后到：两项都在，正文不被吞', () => {
    const { router, store, sid } = fakeRouter();
    router.route(sid, { type: 'thinking_delta', id: 'msg1', text: 'hidden reasoning' });
    router.route(sid, { type: 'text_delta', id: 'msg1', text: '# 巡检结论\n磁盘正常' });

    const items = store.itemsOf(sid);
    const thinking = items.filter((i) => i.kind === 'thinking');
    const assistants = items.filter((i) => i.kind === 'assistant');
    expect(thinking).toHaveLength(1);
    expect(assistants).toHaveLength(1);
    expect(thinking[0].id).toBe('msg1:thinking');
    expect(thinking[0].kind === 'thinking' && thinking[0].steps.join('')).toContain(
      'hidden reasoning'
    );
    expect(assistants[0].id).toBe('msg1:assistant');
    expect(assistants[0].kind === 'assistant' && assistants[0].text).toContain('巡检结论');
  });

  it('正文先到、thinking 后到：同样两项都在', () => {
    const { router, store, sid } = fakeRouter();
    router.route(sid, { type: 'text_delta', id: 'msg1', text: '# 巡检结论\n磁盘正常' });
    router.route(sid, { type: 'thinking_delta', id: 'msg1', text: 'hidden reasoning' });

    const items = store.itemsOf(sid);
    const thinking = items.find((i) => i.kind === 'thinking');
    const assistant = items.find((i) => i.kind === 'assistant');
    expect(thinking?.id).toBe('msg1:thinking');
    expect(thinking?.kind === 'thinking' && thinking.steps.join('')).toContain('hidden reasoning');
    expect(assistant?.id).toBe('msg1:assistant');
    expect(assistant?.kind === 'assistant' && assistant.text).toContain('巡检结论');
  });

  it('多段 delta 各自累加到自己的项；广播 itemId 带对应后缀', () => {
    const { router, store, sid, broadcasts } = fakeRouter();
    router.route(sid, { type: 'thinking_delta', id: 'msg1', text: '想一想，' });
    router.route(sid, { type: 'text_delta', id: 'msg1', text: '磁盘' });
    router.route(sid, { type: 'thinking_delta', id: 'msg1', text: '再想想。' });
    router.route(sid, { type: 'text_delta', id: 'msg1', text: '正常' });

    const assistant = store.findItem('msg1:assistant', sid);
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('磁盘正常');
    const thinking = store.findItem('msg1:thinking', sid);
    expect(thinking?.kind === 'thinking' && thinking.steps.join('')).toBe('想一想，再想想。');

    const patchIds = broadcasts
      .filter((b) => b.type === 'transcript/patch')
      .map((b) => (b.payload as { itemId: string }).itemId);
    expect(patchIds).toEqual(['msg1:assistant', 'msg1:assistant']);
    const thinkingIds = broadcasts
      .filter((b) => b.type === 'thinking/delta')
      .map((b) => (b.payload as { itemId: string }).itemId);
    expect(thinkingIds).toEqual(['msg1:thinking', 'msg1:thinking']);
  });

  it('idle 仍按 kind=assistant && streaming 收尾正文项，thinking 项不受影响', () => {
    const { router, store, sid, idled } = fakeRouter();
    router.route(sid, { type: 'thinking_delta', id: 'msg1', text: 'hidden reasoning' });
    router.route(sid, { type: 'text_delta', id: 'msg1', text: '结论' });
    router.route(sid, { type: 'idle' });

    const assistant = store.findItem('msg1:assistant', sid);
    expect(assistant?.kind === 'assistant' && assistant.streaming).toBe(false);
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('结论');
    expect(store.findItem('msg1:thinking', sid)?.kind).toBe('thinking');
    expect(idled).toEqual([sid]);
  });

  it('防御性幂等：事件 id 已带后缀时不二次拼接', () => {
    const { router, store, sid } = fakeRouter();
    router.route(sid, { type: 'text_delta', id: 'msg1:assistant', text: '结论' });
    router.route(sid, { type: 'thinking_delta', id: 'msg1:thinking', text: '推理' });

    const assistant = store.findItem('msg1:assistant', sid);
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('结论');
    const thinking = store.findItem('msg1:thinking', sid);
    expect(thinking?.kind === 'thinking' && thinking.steps.join('')).toBe('推理');
    expect(store.findItem('msg1:assistant:assistant', sid)).toBeUndefined();
    expect(store.findItem('msg1:thinking:thinking', sid)).toBeUndefined();
  });
});
