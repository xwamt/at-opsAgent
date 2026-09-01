import type { ChatEditRes, TranscriptItem } from '../../protocol';

export async function applyChatEdit(input: {
  action: 'edit' | 'delete';
  itemId: string;
  streaming: boolean;
  items: readonly TranscriptItem[];
  abort: (mode: 'stop') => void;
  navigate: (entryId: string) => Promise<{ editorText?: string; cancelled: boolean }>;
  truncateFrom: (itemId: string) => { ok: boolean; removed: number; rewindExecuted: boolean };
}): Promise<ChatEditRes> {
  const target = input.items.find((row) => row.id === input.itemId);
  if (!target || target.kind !== 'user') {
    return { ok: false, reason: '找不到这条用户消息' };
  }
  if (typeof target.piEntryId !== 'string' || target.piEntryId.length === 0) {
    return { ok: false, reason: '该条无法回溯（旧会话没有 pi 条目 id）' };
  }
  if (input.streaming) input.abort('stop');
  const nav = await input.navigate(target.piEntryId);
  if (nav.cancelled) {
    return { ok: false, reason: '无法回到这条消息（会话树导航失败）' };
  }
  const cut = input.truncateFrom(input.itemId);
  if (!cut.ok) return { ok: false, reason: '截断会话记录失败' };
  if (input.action === 'edit') {
    return {
      ok: true,
      editorText: nav.editorText ?? target.text,
      rewindExecuted: cut.rewindExecuted
    };
  }
  return { ok: true, rewindExecuted: cut.rewindExecuted };
}
