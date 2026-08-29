/**
 * Plan 08 T4：携带交接包开新会话。from 会话 1 条 evidence →
 * 新会话 itemsOf 含 system digest 且含该 summary。不自动开新会话。
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
  DISMISS_COMPACTION_NOTICE_ACTION,
  HANDOFF_NEW_SESSION_ACTION,
  ChatService
} from '../src/host/services/chatService';
import type { HostContext } from '../src/host/services/context';
import { SessionStore } from '../src/host/sessionStore';
import { COMPACTION_NEW_SESSION_MESSAGE } from '../src/runtime/compaction';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createChatHarness(): {
  chat: ChatService;
  store: SessionStore;
  sid: string;
  hydrates: number;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-handoff-'));
  tempDirs.push(dir);
  const store = new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') });
  let hydrates = 0;
  const ctx = {
    store,
    hub: {
      listExposedTools: () => [{ name: 'at.grafana' }],
      listAllTools: () => [],
      getProviders: () => ({ hostApp: 'vscode', providers: [] })
    },
    playbooks: {
      getPlaybooks: async () => [],
      runOf: () => undefined,
      cachedPlaybooks: () => undefined
    },
    playbooksDir: path.join(dir, 'playbooks'),
    config: { safeProviders: () => ({}) },
    models: { chatModelsExtra: () => ({}) },
    core: {
      buildSystemPrompt: () => ''
    },
    log: () => {},
    broadcast: (type: string) => {
      if (type === 'hydrate') hydrates += 1;
    },
    broadcastToSession: () => {},
    approvals: { clearSession: () => {}, rejectWaitersFor: () => {} }
  } as unknown as HostContext;
  const chat = new ChatService(ctx);
  (ctx as { chat: ChatService }).chat = chat;
  return { chat, store, sid: store.activeSessionId, hydrates };
}

describe('ChatService.startHandoffSession', () => {
  it('from 会话 1 条 evidence → 新会话 system digest 含该 summary', async () => {
    const { chat, store, sid } = createChatHarness();
    const summary = '18:02 发布后错误率上升';
    store.appendItem({
      kind: 'evidence',
      id: 'ev-1',
      note: {
        taskId: 't1',
        confidence: 'confirmed',
        summary,
        refs: [{ kind: 'log', preview: 'THIS_PREVIEW_MUST_NOT_APPEAR_IN_DIGEST' }]
      }
    });
    store.appendTimeline({ kind: 'approval', briefId: 'abc123', decision: 'approved' });

    const result = await chat.startHandoffSession(sid);
    expect(result.ok).toBe(true);
    expect(result.sessionId).not.toBe(sid);
    expect(store.activeSessionId).toBe(result.sessionId);

    const items = store.itemsOf(result.sessionId);
    const system = items.find((i) => i.kind === 'system');
    expect(system).toBeDefined();
    expect(system && system.kind === 'system' && system.text).toContain('# L-mem');
    expect(system && system.kind === 'system' && system.text).toContain(summary);
    expect(system && system.kind === 'system' && system.text).toContain('brief abc123 approved');
    expect(system && system.kind === 'system' && system.text).not.toContain(
      'THIS_PREVIEW_MUST_NOT_APPEAR_IN_DIGEST'
    );

    const newMeta = store.sessions.find((s) => s.id === result.sessionId);
    expect(newMeta?.title.startsWith('交接 ')).toBe(true);
  });

  it('handleNoticeAction(handoff-new-session) 走交接；dismiss 为 no-op', async () => {
    const { chat, store, sid } = createChatHarness();
    store.appendItem({
      kind: 'evidence',
      id: 'ev-1',
      note: { taskId: 't1', confidence: 'pending', summary: '待确认告警', refs: [] }
    });
    const before = store.sessions.length;
    const dismissed = await chat.handleNoticeAction(DISMISS_COMPACTION_NOTICE_ACTION.id, sid);
    expect(dismissed.ok).toBe(true);
    expect(store.sessions.length).toBe(before);
    expect(store.activeSessionId).toBe(sid);

    const handed = await chat.handleNoticeAction(HANDOFF_NEW_SESSION_ACTION.id, sid);
    expect(handed.ok).toBe(true);
    expect(handed.sessionId).not.toBe(sid);
    expect(store.sessions.length).toBe(before + 1);
  });

  it('溢出文案含交接按钮提示；notice actions 含交接 + 仅提示', () => {
    expect(COMPACTION_NEW_SESSION_MESSAGE).toContain('可点击下方按钮');
    expect(HANDOFF_NEW_SESSION_ACTION.label).toBe('携带交接包开新会话');
    expect(DISMISS_COMPACTION_NOTICE_ACTION.label).toBe('仅提示');
    expect(HANDOFF_NEW_SESSION_ACTION.request).toBeUndefined();
    expect(DISMISS_COMPACTION_NOTICE_ACTION.request).toBeUndefined();
  });
});
