/**
 * GuidedManual notice：无「回复已完成」打字指令；双按钮 action id。
 */
import { describe, expect, it } from 'vitest';
import {
  GUIDED_MANUAL_NOTICE_ACTIONS,
  buildGuidedManualNotice
} from '../src/host/guidedManual';

describe('buildGuidedManualNotice', () => {
  it('不含「回复「已完成」」或不让用户打 已完成', () => {
    const text = buildGuidedManualNotice('pb.release', undefined);
    expect(text).toBeDefined();
    expect(text).not.toContain('回复「已完成」');
    expect(text).not.toMatch(/回复.{0,8}已完成/);
    expect(text).not.toContain('打「已完成」');
  });

  it('提示打开插件，完成后点按钮', () => {
    const text = buildGuidedManualNotice('pb.config-change', undefined);
    expect(text).toContain('【引导式人工操作】');
    expect(text).toContain('点下方按钮');
  });
});

describe('GUIDED_MANUAL_NOTICE_ACTIONS', () => {
  it('含打开插件与我已在 UI 完成两个 action id', () => {
    const ids = GUIDED_MANUAL_NOTICE_ACTIONS.map((a) => a.id);
    expect(ids).toEqual(['gm-open', 'gm-complete']);
    expect(GUIDED_MANUAL_NOTICE_ACTIONS[0]?.request).toBe('guidedManual/open');
    expect(GUIDED_MANUAL_NOTICE_ACTIONS[1]?.request).toBe('guidedManual/complete');
    expect(GUIDED_MANUAL_NOTICE_ACTIONS[0]?.label).toBe('打开对应插件');
    expect(GUIDED_MANUAL_NOTICE_ACTIONS[1]?.label).toBe('我已在 UI 完成');
  });
});
