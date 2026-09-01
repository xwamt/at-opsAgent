/**
 * 用户消息编辑/删除：abort → navigateTree → 截断 transcript。
 * 纯函数 applyChatEdit，不启 VS Code。
 */
import { describe, expect, it, vi } from 'vitest';
import { applyChatEdit, resolvePiEntryId } from '../src/host/services/chatEdit';
import type { TranscriptItem } from '../src/protocol';

function items(): TranscriptItem[] {
  return [
    { kind: 'user', id: 'u1', text: '第一问', piEntryId: 'e1' },
    { kind: 'assistant', id: 'a1', text: '答' },
    { kind: 'user', id: 'u2', text: '第二问', piEntryId: 'e2' },
    { kind: 'assistant', id: 'a2', text: '答2' }
  ];
}

describe('applyChatEdit', () => {
  it('edit：navigate + 截断含该用户条，返回 editorText', async () => {
    const transcript = items();
    const navigate = vi.fn(async () => ({ cancelled: false, editorText: '第二问' }));
    const abort = vi.fn();
    const truncateFrom = vi.fn((id: string) => {
      const index = transcript.findIndex((row) => row.id === id);
      const rewindExecuted = false;
      transcript.splice(index);
      return { ok: true, removed: 2, rewindExecuted };
    });

    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u2',
      streaming: true,
      items: transcript,
      abort,
      navigate,
      truncateFrom
    });

    expect(abort).toHaveBeenCalledWith('stop');
    expect(navigate).toHaveBeenCalledWith('e2');
    expect(res).toEqual({ ok: true, editorText: '第二问', rewindExecuted: false });
    expect(transcript.map((row) => row.id)).toEqual(['u1', 'a1']);
  });

  it('delete：截断且不返回 editorText', async () => {
    const transcript = items();
    const res = await applyChatEdit({
      action: 'delete',
      itemId: 'u2',
      streaming: false,
      items: transcript,
      abort: vi.fn(),
      navigate: async () => ({ cancelled: false, editorText: '第二问' }),
      truncateFrom: (id) => {
        const index = transcript.findIndex((row) => row.id === id);
        transcript.splice(index);
        return { ok: true, removed: 2, rewindExecuted: false };
      }
    });
    expect(res).toEqual({ ok: true, rewindExecuted: false });
    expect(res.editorText).toBeUndefined();
  });

  it('无 piEntryId 且无 forking → 拒绝，不 navigate', async () => {
    const navigate = vi.fn();
    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u1',
      streaming: false,
      items: [{ kind: 'user', id: 'u1', text: '旧会话' }],
      abort: vi.fn(),
      navigate,
      truncateFrom: vi.fn()
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('无法回溯');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('无 piEntryId 时按 forking 文本对齐解析 entryId 并编辑', async () => {
    const transcript: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: '第一问' },
      { kind: 'assistant', id: 'a1', text: '答' }
    ];
    const navigate = vi.fn(async () => ({ cancelled: false, editorText: '第一问' }));
    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u1',
      streaming: false,
      items: transcript,
      abort: vi.fn(),
      navigate,
      truncateFrom: (id) => {
        const index = transcript.findIndex((row) => row.id === id);
        transcript.splice(index);
        return { ok: true, removed: 2, rewindExecuted: false };
      },
      forking: [{ entryId: 'jsonl-1', text: '第一问' }]
    });
    expect(navigate).toHaveBeenCalledWith('jsonl-1');
    expect(res).toEqual({ ok: true, editorText: '第一问', rewindExecuted: false });
  });

  it('resolvePiEntryId：重复正文按出现次序对齐', () => {
    expect(
      resolvePiEntryId(
        [
          { kind: 'user', id: 'u1', text: '同样' },
          { kind: 'user', id: 'u2', text: '同样' }
        ],
        'u2',
        [
          { entryId: 'e1', text: '同样' },
          { entryId: 'e2', text: '同样' }
        ]
      )
    ).toBe('e2');
  });

  it('navigate cancelled → 不截 UI', async () => {
    const transcript = items();
    const truncateFrom = vi.fn();
    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u2',
      streaming: false,
      items: transcript,
      abort: vi.fn(),
      navigate: async () => ({ cancelled: true }),
      truncateFrom
    });
    expect(res.ok).toBe(false);
    expect(truncateFrom).not.toHaveBeenCalled();
  });
});
