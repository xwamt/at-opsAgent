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
    hub: { listAllTools: () => [] },
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

const SCREENSHOT_ENVELOPE = JSON.stringify({
  ok: true,
  result: {
    serverId: '4d1fbefc-aeef-42e9-9008-62c04915affe',
    serverLabel: '99.90',
    host: '192.168.99.90',
    command: 'hostname',
    exitCode: 0,
    stdout: 'cl\n',
    stderr: '',
    durationMs: 258,
    timedOut: false,
    truncated: false
  },
  attemptCount: 1,
  durationMs: 261
});

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
      .filter((b) => {
        const patch = (b.payload as { patch?: { appendText?: string } }).patch;
        return typeof patch?.appendText === 'string';
      })
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

  it('thinking 结束时写入 durationMs（text_delta 一次；idle 不重复）', () => {
    const { router, store, sid, broadcasts } = fakeRouter();
    router.route(sid, { type: 'thinking_delta', id: 'msg1', text: 'hidden reasoning' });
    router.route(sid, { type: 'text_delta', id: 'msg1', text: '结论' });

    const thinking = store.findItem('msg1:thinking', sid);
    expect(thinking?.kind).toBe('thinking');
    if (thinking?.kind !== 'thinking') return;
    expect(typeof thinking.durationMs).toBe('number');
    expect(thinking.durationMs).toBeGreaterThanOrEqual(0);

    const durationPatches = broadcasts.filter((b) => {
      if (b.type !== 'transcript/patch') return false;
      const payload = b.payload as { itemId?: string; patch?: { durationMs?: number } };
      return payload.itemId === 'msg1:thinking' && typeof payload.patch?.durationMs === 'number';
    });
    expect(durationPatches).toHaveLength(1);

    const firstDuration = thinking.durationMs;
    router.route(sid, { type: 'idle' });
    const afterIdle = store.findItem('msg1:thinking', sid);
    expect(afterIdle?.kind === 'thinking' && afterIdle.durationMs).toBe(firstDuration);
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

  it('tool_start 携带 preview 参数下发；tool_update 增量更新；tool_end 结算', () => {
    const { router, store, sid, broadcasts } = fakeRouter();
    const argsJson = JSON.stringify({ serverName: '192.168.99.92', command: 'free -m' });
    router.route(sid, {
      type: 'tool_start',
      id: 'tool-1',
      name: 'run_remote_command',
      preview: argsJson
    });

    const item1 = store.findItem('tool-1', sid);
    expect(item1?.kind).toBe('tool');
    if (item1?.kind === 'tool') {
      expect(item1.call.name).toBe('run_remote_command');
      expect(item1.call.status).toBe('running');
      expect(item1.call.preview).toBe(argsJson);
    }
    expect(broadcasts.some((b) => b.type === 'tool/start')).toBe(true);

    // tool_update 更新中间增量
    router.route(sid, {
      type: 'tool_update',
      id: 'tool-1',
      name: 'run_remote_command',
      preview: 'total used free\nMem: 16G 8G 8G'
    });
    const item2 = store.findItem('tool-1', sid);
    if (item2?.kind === 'tool') {
      expect(item2.call.preview).toContain('Mem: 16G');
    }
    expect(broadcasts.some((b) => b.type === 'tool/update')).toBe(true);

    // tool_end 完成
    router.route(sid, {
      type: 'tool_end',
      id: 'tool-1',
      name: 'run_remote_command',
      ok: true,
      preview: JSON.stringify({ stdout: 'total used free\nMem: 16G 8G 8G', exitCode: 0 })
    });
    const item3 = store.findItem('tool-1', sid);
    if (item3?.kind === 'tool') {
      expect(item3.call.status).toBe('ok');
      expect(item3.call.preview).toContain('exitCode');
    }
    expect(broadcasts.some((b) => b.type === 'tool/end')).toBe(true);
  });

  it('tool_start 冻结 inputPreview；update/end 只改 preview', () => {
    const { router, store, sid } = fakeRouter();
    const argsJson = JSON.stringify({
      command: '# Purpose: 查看负载\nuptime',
      serverId: 's1'
    });
    router.route(sid, {
      type: 'tool_start',
      id: 'tool-keep',
      name: 'run_remote_command',
      preview: argsJson
    });
    router.route(sid, {
      type: 'tool_update',
      id: 'tool-keep',
      name: 'run_remote_command',
      preview: '09:48 up 42 days'
    });
    router.route(sid, {
      type: 'tool_end',
      id: 'tool-keep',
      name: 'run_remote_command',
      ok: true,
      preview: SCREENSHOT_ENVELOPE
    });
    const item = store.findItem('tool-keep', sid);
    expect(item?.kind).toBe('tool');
    if (item?.kind === 'tool') {
      expect(item.call.inputPreview).toBe(argsJson);
      expect(item.call.preview).toBe(SCREENSHOT_ENVELOPE);
    }
  });

  it('idle 时自动从 assistant 文本提取 evidence-note@1 转为 evidence 卡片并清洗正文', () => {
    const { router, store, sid, broadcasts } = fakeRouter();
    const rawNote = JSON.stringify({
      contract: 'evidence-note@1',
      taskId: 'mem-uat-service-10114941',
      confidence: 'confirmed',
      summary: 'uat-service 32G 内存：10 个 ZGC Java 进程为主要占用方',
      timeWindow: { from: '2026-05-22T05:25:00Z', to: '2026-05-22T05:30:00Z' },
      refs: [{ kind: 'host', toolName: 'jumpserver_run_terminal_command', pluginId: 'at.jumpserver', preview: 'free -h' }],
      conflicts: []
    });
    const assistantContent = `排查完成，结论如下：\n- 内存占用过高，主要由 Java 进程堆内存引起。\n\n${rawNote}`;

    router.route(sid, { type: 'text_delta', id: 'msg-ev', text: assistantContent });
    router.route(sid, { type: 'idle' });

    // 1. assistant 正文中的裸 JSON 被清洗剥离
    const assistant = store.findItem('msg-ev:assistant', sid);
    expect(assistant?.kind === 'assistant').toBe(true);
    if (assistant?.kind === 'assistant') {
      expect(assistant.text).toBe('排查完成，结论如下：\n- 内存占用过高，主要由 Java 进程堆内存引起。');
      expect(assistant.text).not.toContain('contract');
      expect(assistant.streaming).toBe(false);
    }

    // 2. store 中生成了独立的 evidence 卡片项
    const items = store.itemsOf(sid);
    const evidenceItem = items.find((i) => i.kind === 'evidence');
    expect(evidenceItem).toBeDefined();
    if (evidenceItem?.kind === 'evidence') {
      expect(evidenceItem.note.taskId).toBe('mem-uat-service-10114941');
      expect(evidenceItem.note.confidence).toBe('confirmed');
      expect(evidenceItem.note.summary).toContain('uat-service 32G 内存');
      expect(evidenceItem.note.refs).toHaveLength(1);
    }

    // 3. store 时间线中也记录了该证据便签
    const timeline = store.timeline;
    expect(timeline.some((t) => t.kind === 'evidence' && t.taskId === 'mem-uat-service-10114941')).toBe(true);

    // 4. 广播中包含了 transcript/patch 清洗后的正文与 transcript/append 的 evidence 项
    expect(broadcasts.some((b) => b.type === 'transcript/append' && (b.payload as { item: { kind: string } }).item.kind === 'evidence')).toBe(true);
  });
});
