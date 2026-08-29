/**
 * Plan 08 T1：溢出 compact 必带运维 customInstructions；
 * 无 compact / compact throw / retry throw 仍抛 COMPACTION_NEW_SESSION_MESSAGE。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPACTION_NEW_SESSION_MESSAGE,
  OPS_COMPACT_INSTRUCTIONS,
  recoverFromPromptError
} from '../src/runtime/compaction';

describe('recoverFromPromptError · OPS_COMPACT_INSTRUCTIONS', () => {
  it('溢出路径 compact 带运维指令（SRE / on-call / evidence）', async () => {
    const compact = vi.fn(async (x: string | undefined) => x);
    await recoverFromPromptError({
      session: { compact },
      error: new Error('prompt is too long'),
      retry: async () => {}
    });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(expect.stringMatching(/SRE|on-call|evidence/i));
    expect(compact.mock.calls[0]?.[0]).toContain('evidence-note');
    expect(compact.mock.calls[0]?.[0]).toContain('playbook');
    expect(OPS_COMPACT_INSTRUCTIONS).toMatch(/SRE|on-call/i);
  });

  it('非溢出错误原样 rethrow，不 compact', async () => {
    const boom = new Error('ECONNRESET');
    const compact = vi.fn(async () => undefined);
    await expect(
      recoverFromPromptError({
        session: { compact },
        error: boom,
        retry: async () => {}
      })
    ).rejects.toBe(boom);
    expect(compact).not.toHaveBeenCalled();
  });

  it('无 compact 方法仍抛 COMPACTION_NEW_SESSION_MESSAGE', async () => {
    await expect(
      recoverFromPromptError({
        session: {},
        error: new Error('prompt too long'),
        retry: async () => {
          throw new Error('不应被调用');
        }
      })
    ).rejects.toThrow(COMPACTION_NEW_SESSION_MESSAGE);
  });

  it('compact throw 仍抛 COMPACTION_NEW_SESSION_MESSAGE 且不 retry', async () => {
    let retries = 0;
    await expect(
      recoverFromPromptError({
        session: {
          compact: async () => {
            throw new Error('compaction failed');
          }
        },
        error: new Error('prompt too long'),
        retry: async () => {
          retries += 1;
        }
      })
    ).rejects.toThrow(COMPACTION_NEW_SESSION_MESSAGE);
    expect(retries).toBe(0);
  });

  it('retry throw 仍抛 COMPACTION_NEW_SESSION_MESSAGE（compact 一次）', async () => {
    const compact = vi.fn(async () => ({ summary: 'ok' }));
    let retries = 0;
    await expect(
      recoverFromPromptError({
        session: { compact },
        error: new Error('prompt is too long'),
        retry: async () => {
          retries += 1;
          throw new Error('prompt is too long');
        }
      })
    ).rejects.toThrow(COMPACTION_NEW_SESSION_MESSAGE);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(retries).toBe(1);
  });

  it('COMPACTION_NEW_SESSION_MESSAGE 提示可点击交接按钮', () => {
    expect(COMPACTION_NEW_SESSION_MESSAGE).toContain('可点击下方按钮，把证据与阶段带到新会话');
  });
});
