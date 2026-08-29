/**
 * Webview 复制：优先 navigator.clipboard.writeText；失败或不存在时
 * postEnvelope('clipboard/write') 让 host 走 vscode.env.clipboard。
 * 不使用 document.execCommand('copy')。
 */
import { onBeforeUnmount, ref } from 'vue';
import { postEnvelope } from '../vscode-api';

export const COPIED_FEEDBACK_MS = 1500;

export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = (
      globalThis as {
        navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
      }
    ).navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to host */
  }
  postEnvelope('clipboard/write', { text });
  return true; // host 异步写；UI 仍给已复制反馈
}

/** 复制成功后 1500ms 内显示「已复制」；须在组件 setup 中调用。 */
export function useCopiedFlag(resetMs = COPIED_FEEDBACK_MS): {
  copied: ReturnType<typeof ref<boolean>>;
  copy: (text: string) => Promise<void>;
} {
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function copy(text: string): Promise<void> {
    await copyText(text);
    copied.value = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      copied.value = false;
      timer = undefined;
    }, resetMs);
  }
  onBeforeUnmount(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
  return { copied, copy };
}
