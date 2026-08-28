/**
 * 流式事件合批（默认 40ms，配置 atOpsAgent.streaming.batchMs）。
 *
 * 仅 `transcript/patch`（appendText）与 `thinking/delta` 参与合并；
 * 其它事件先冲刷 pending 再立即发送，保证顺序不乱。
 */
import type { Envelope } from '../protocol';

type PatchPayload = {
  itemId: string;
  patch: { appendText?: string; [key: string]: unknown };
};

type ThinkingPayload = { itemId: string; text: string };

export class StreamBatcher {
  private pending: Envelope[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly post: (env: Envelope) => void,
    private readonly batchMs: () => number
  ) {}

  push(env: Envelope): void {
    if (this.disposed) return;
    if (env.dir === 'evt' && env.type === 'transcript/patch' && this.mergePatch(env)) {
      this.schedule();
      return;
    }
    if (env.dir === 'evt' && env.type === 'thinking/delta' && this.mergeThinking(env)) {
      this.schedule();
      return;
    }
    // 非可合并事件：先冲刷已排队的增量，再直发。
    this.flush();
    this.post(env);
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const env of batch) this.post(env);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    const ms = Math.max(0, this.batchMs());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, ms);
  }

  /** 返回 true 表示已进入 pending（合并或追加）。 */
  private mergePatch(env: Envelope): boolean {
    const payload = env.payload as PatchPayload | undefined;
    if (!payload || typeof payload.itemId !== 'string' || typeof payload.patch !== 'object') {
      return false;
    }
    const existing = this.pending.find(
      (p) =>
        p.type === 'transcript/patch' && (p.payload as PatchPayload).itemId === payload.itemId
    );
    if (existing) {
      const prev = (existing.payload as PatchPayload).patch;
      const next = payload.patch;
      const appendText = (prev.appendText ?? '') + (next.appendText ?? '');
      (existing.payload as PatchPayload).patch = { ...prev, ...next };
      if (appendText.length > 0) {
        (existing.payload as PatchPayload).patch.appendText = appendText;
      }
      (existing as { ts: number }).ts = env.ts;
    } else {
      this.pending.push(env);
    }
    return true;
  }

  private mergeThinking(env: Envelope): boolean {
    const payload = env.payload as ThinkingPayload | undefined;
    if (!payload || typeof payload.itemId !== 'string' || typeof payload.text !== 'string') {
      return false;
    }
    const existing = this.pending.find(
      (p) => p.type === 'thinking/delta' && (p.payload as ThinkingPayload).itemId === payload.itemId
    );
    if (existing) {
      (existing.payload as ThinkingPayload).text += payload.text;
      (existing as { ts: number }).ts = env.ts;
    } else {
      this.pending.push(env);
    }
    return true;
  }
}
