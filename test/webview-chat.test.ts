/**
 * webview-chat 组件层单测（docs/09 §8 组件测）。
 *
 * vitest 没有 vue SFC 编译插件（不改 package.json），所以不 mount .vue 组件；
 * 按降级路径测试组件抽出的纯 TS helper：
 * - ApprovalBar 双确认文案（dualConfirmText，仅 dualConfirmHint === true 时出现）
 * - EvidenceNote 三态 class（confidenceClass / confidenceLabel）
 * - i18n 启动包（<html lang> 检测 + hydrate locale 切换）
 * - Composer/store 的 prompt 组装（steer / followUp / attachments）
 * - ChatTranscript 事件脉络条（timeline 事件 + 证据便签）
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../src/protocol/host-protocol';
import {
  confidenceClass,
  confidenceLabel,
  normalizeConfidence
} from '../src/webview-chat/confidence';
import { detectLocale, dualConfirmText, normalizeLocale, setLocale, t } from '../src/webview-chat/i18n';
import {
  buildPromptPayload,
  buildTimelineStrip,
  canFollowUpFrom,
  normalizeTimelineEvent,
  type ChatTimelineEvent
} from '../src/webview-chat/store-helpers';

// root tsconfig 无 DOM lib：jsdom 的 document 通过 globalThis 收窄访问
function setHtmlLang(lang: string): void {
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (doc) {
    doc.documentElement.lang = lang;
  }
}

beforeEach(() => {
  setHtmlLang('zh-CN');
  setLocale('zh-CN');
});

describe('ApprovalBar 双确认文案（dualConfirmHint）', () => {
  const brief = {
    id: 'brief-1',
    risk: 'exec' as const,
    targetLabel: '回滚 api-gateway',
    elements: {},
    dualConfirmHint: true
  };

  it('dualConfirmHint=true 时返回整句双确认提示', () => {
    const text = dualConfirmText(brief);
    expect(text).toContain('批准后插件仍可能再次确认');
    expect(text).toContain('插件弹窗不是本次批准');
  });

  it('dualConfirmHint=false / 缺失 / 无简报时不出现', () => {
    expect(dualConfirmText({ ...brief, dualConfirmHint: false })).toBe('');
    expect(dualConfirmText({} as { dualConfirmHint?: boolean })).toBe('');
    expect(dualConfirmText(null)).toBe('');
    expect(dualConfirmText(undefined)).toBe('');
  });

  it('en locale 下返回英文句子', () => {
    setLocale('en');
    const text = dualConfirmText(brief);
    expect(text).toContain('The plugin dialog is not this approval');
  });
});

describe('EvidenceNote 三态 class（confidence helper）', () => {
  it('三态各自映射 ops-confidence-* class', () => {
    expect(confidenceClass('confirmed')).toBe('ops-confidence-confirmed');
    expect(confidenceClass('hypothesis')).toBe('ops-confidence-hypothesis');
    expect(confidenceClass('pending')).toBe('ops-confidence-pending');
  });

  it('未知/缺失一律归 pending（未检查 ≠ 正常）', () => {
    expect(normalizeConfidence('garbage')).toBe('pending');
    expect(normalizeConfidence(undefined)).toBe('pending');
    expect(confidenceClass(null)).toBe('ops-confidence-pending');
  });

  it('标签是颜色之外的第二通道：zh 带中文说明，en 纯词', () => {
    expect(confidenceLabel('confirmed')).toBe('已确证 confirmed');
    expect(confidenceLabel('hypothesis', 'en')).toBe('hypothesis');
  });
});

describe('i18n 启动包：locale 检测与切换', () => {
  it('normalizeLocale：zh*/en* 归一，其它返回 null', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-tw')).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale('')).toBeNull();
  });

  it('detectLocale 读 <html lang>，识别不了默认 zh-CN', () => {
    setHtmlLang('en-US');
    expect(detectLocale()).toBe('en');
    setHtmlLang('zh-CN');
    expect(detectLocale()).toBe('zh-CN');
    setHtmlLang('');
    expect(detectLocale()).toBe('zh-CN');
  });

  it('setLocale（hydrate locale 字段）切换取词；未知值保持当前语言', () => {
    expect(t('approvalApprove')).toBe('批准');
    setLocale('en');
    expect(t('approvalApprove')).toBe('Approve');
    expect(t('pickerPlaybookTitle')).toContain('Playbook');
    setLocale('klingon');
    expect(t('approvalApprove')).toBe('Approve');
  });
});

describe('Composer/store prompt 组装（steer / followUp / attachments）', () => {
  const doneTurn: TranscriptItem[] = [
    { kind: 'user', id: 'u1', text: '网关 5xx 突增' },
    { kind: 'assistant', id: 'a1', text: '初步归纳…', streaming: false }
  ];

  it('流式中 ⇒ mode steer', () => {
    const payload = buildPromptPayload('收紧窗口', { streaming: true, canFollowUp: false });
    expect(payload?.mode).toBe('steer');
  });

  it('刚结束一轮 ⇒ canFollowUp=true ⇒ mode followUp', () => {
    expect(canFollowUpFrom(doneTurn, false)).toBe(true);
    const payload = buildPromptPayload('再看下日志', { streaming: false, canFollowUp: true });
    expect(payload?.mode).toBe('followUp');
  });

  it('空会话首问 ⇒ 无 mode；流式中的 assistant 不算已结束', () => {
    expect(canFollowUpFrom([], false)).toBe(false);
    expect(
      canFollowUpFrom(
        [
          { kind: 'user', id: 'u1', text: 'hi' },
          { kind: 'assistant', id: 'a1', text: '…', streaming: true }
        ],
        false
      )
    ).toBe(false);
    const payload = buildPromptPayload('首问', { streaming: false, canFollowUp: false });
    expect(payload?.mode).toBeUndefined();
  });

  it('@资产附件透传为 {kind:file, uri}；空文本不发', () => {
    const payload = buildPromptPayload(
      '看看这台机器 ',
      { streaming: false, canFollowUp: false },
      [{ kind: 'file', uri: 'host://prod-gw-01' }]
    );
    expect(payload).not.toBeNull();
    expect(payload?.text).toBe('看看这台机器');
    expect(payload?.attachments).toEqual([{ kind: 'file', uri: 'host://prod-gw-01' }]);
    expect(buildPromptPayload('   ', { streaming: false, canFollowUp: true })).toBeNull();
  });
});

describe('ChatTranscript 事件脉络条（timeline + 证据便签）', () => {
  it('timeline/upsert payload 归一化：severity 归 info/warn/crit，无 id 丢弃', () => {
    expect(normalizeTimelineEvent({ id: 'e1', title: '发布', severity: 'ERROR' })).toMatchObject({
      id: 'e1',
      title: '发布',
      severity: 'crit'
    });
    expect(normalizeTimelineEvent({ event: { id: 'e2', summary: '巡检', level: 'warning' } })).toMatchObject({
      id: 'e2',
      title: '巡检',
      severity: 'warn'
    });
    expect(normalizeTimelineEvent({ title: '没有 id' })).toBeNull();
  });

  it('host 不发 timeline 时，仅由证据便签撑起条带（tone = 三态）', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: '查一下' },
      {
        kind: 'evidence',
        id: 'ev1',
        note: { taskId: 't1', confidence: 'confirmed', summary: '5xx 突增', refs: [] }
      },
      {
        kind: 'evidence',
        id: 'ev2',
        note: { taskId: 't2', confidence: 'hypothesis', summary: '疑似发布引入', refs: [] }
      }
    ];
    const strip = buildTimelineStrip([], items);
    expect(strip).toEqual([
      { id: 'ev-ev1', label: '5xx 突增', tone: 'confirmed' },
      { id: 'ev-ev2', label: '疑似发布引入', tone: 'hypothesis' }
    ]);
  });

  it('timeline 事件在前、证据在后，超出 cap 保留最新', () => {
    const timeline: ChatTimelineEvent[] = [
      { id: 't1', ts: 1, title: '发布 #482', severity: 'warn' },
      { id: 't2', ts: 2, title: '5xx 突增', severity: 'crit' }
    ];
    const items: TranscriptItem[] = [
      {
        kind: 'evidence',
        id: 'ev1',
        note: { taskId: 'x', confidence: 'pending', summary: '日志未回', refs: [] }
      }
    ];
    expect(buildTimelineStrip(timeline, items).map((entry) => entry.tone)).toEqual([
      'warn',
      'crit',
      'pending'
    ]);
    expect(buildTimelineStrip(timeline, items, 2).map((entry) => entry.id)).toEqual([
      'tl-t2',
      'ev-ev1'
    ]);
  });
});
