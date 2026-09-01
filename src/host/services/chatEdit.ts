import type { ChatEditRes, TranscriptItem } from '../../protocol';

export type ForkingUserMessage = { entryId: string; text: string };

/** 优先用 UI 已回填的 piEntryId；否则按同正文出现次序对齐 JSONL forking 列表。 */
export function resolvePiEntryId(
  items: readonly TranscriptItem[],
  itemId: string,
  forking: readonly ForkingUserMessage[] = []
): string | undefined {
  const target = items.find((row) => row.id === itemId);
  if (!target || target.kind !== 'user') return undefined;
  if (typeof target.piEntryId === 'string' && target.piEntryId.length > 0) {
    return target.piEntryId;
  }
  const same = items.filter((row) => row.kind === 'user' && row.text === target.text);
  const index = same.findIndex((row) => row.id === itemId);
  if (index < 0) return undefined;
  return forking.filter((row) => row.text === target.text)[index]?.entryId;
}

export async function applyChatEdit(input: {
  action: 'edit' | 'delete';
  itemId: string;
  streaming: boolean;
  items: readonly TranscriptItem[];
  abort: (mode: 'stop') => void;
  navigate: (entryId: string) => Promise<{ editorText?: string; cancelled: boolean }>;
  truncateFrom: (itemId: string) => { ok: boolean; removed: number; rewindExecuted: boolean };
  forking?: readonly ForkingUserMessage[];
}): Promise<ChatEditRes> {
  const target = input.items.find((row) => row.id === input.itemId);
  if (!target || target.kind !== 'user') {
    return { ok: false, reason: '找不到这条用户消息' };
  }
  const entryId = resolvePiEntryId(input.items, input.itemId, input.forking ?? []);
  if (!entryId) {
    return { ok: false, reason: '该条无法回溯（旧会话没有 pi 条目 id）' };
  }
  if (input.streaming) input.abort('stop');
  const nav = await input.navigate(entryId);
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
