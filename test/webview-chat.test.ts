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
 * - ChatTranscript CoT 隐藏（visibleUntrustedQuotes：思考步骤永不可见，
 *   仅 untrustedQuotes 警示块渲染，对齐 pi hideThinkingBlock）
 * - HistoryOverlay/WelcomeState 的会话归一化与建议卡（sessions / suggestions）
 * - ModelSelector 模型清单（normalizeChatModels + hydrate 吸收顺序）
 * - 子代理 inspector（collect/active/title + resolveInspectedSubagent：
 *   ChatApp 顶层 SubagentInspector overlay 的 v-if 数据源，无需 mount Vue store）
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SubagentCard, TranscriptItem } from '../src/protocol/host-protocol';
import {
  confidenceClass,
  confidenceLabel,
  normalizeConfidence
} from '../src/webview-chat/confidence';
import { detectLocale, dualConfirmText, normalizeLocale, setLocale, t, tf } from '../src/webview-chat/i18n';
import {
  absorbChatModelFields,
  absorbHydrateMeta,
  absorbHydrateModels,
  activeSubagentCards,
  assistantDisplay,
  buildHistoryList,
  buildPromptPayload,
  buildRenderList,
  buildTimelineStrip,
  buildWelcomeSuggestions,
  canFollowUpFrom,
  collectSubagentCards,
  filterTranscriptForView,
  findAdjacentSubagent,
  formatDataOutputPreview,
  formatThinkingDurationMs,
  isCommandToolCall,
  isConclusionItem,
  isSubagentToolCall,
  modelsConfigured,
  normalizeChatModels,
  normalizeSessions,
  normalizeTimelineEvent,
  normalizeUsage,
  parseToolOutputPreview,
  resolveInspectedSubagent,
  subagentTitle,
  thinkingMetaVisible,
  toolCallHeadline,
  usagePercent,
  visibleUntrustedQuotes,
  type ChatTimelineEvent,
  type SessionMeta
} from '../src/webview-chat/store-helpers';
import { annotateCommandKeywords, isBlankApprovalValue } from '../src/webview-chat/lib/approval-brief';

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

describe('ChatTranscript CoT 隐藏（对齐 pi hideThinkingBlock，恒为隐藏）', () => {
  const steps = ['确认症状与时间窗：09:05 起 5xx 比例 0.2%→14%', '优先 grafana 窄窗验证，再放大面'];

  it('thinking 项无 untrustedQuotes ⇒ 可见内容为空（整项不渲染）', () => {
    const item: TranscriptItem = { kind: 'thinking', id: 'th1', steps };
    expect(visibleUntrustedQuotes(item)).toEqual([]);
  });

  it('带 untrustedQuotes ⇒ 仅外部引用可见，思考步骤永不外泄', () => {
    const quote = 'upstream timed out (110: Connection timed out)';
    const item: TranscriptItem = { kind: 'thinking', id: 'th1', steps, untrustedQuotes: [quote] };
    const visible = visibleUntrustedQuotes(item);
    expect(visible).toEqual([quote]);
    for (const step of steps) {
      expect(visible.join('\n')).not.toContain(step);
    }
  });

  it('空串引用被剔除；非 thinking 项一律返回空', () => {
    expect(
      visibleUntrustedQuotes({ kind: 'thinking', id: 'th2', steps, untrustedQuotes: ['', 'ok'] })
    ).toEqual(['ok']);
    expect(visibleUntrustedQuotes({ kind: 'user', id: 'u1', text: 'hi' })).toEqual([]);
    expect(
      visibleUntrustedQuotes({ kind: 'assistant', id: 'a1', text: '回答', streaming: false })
    ).toEqual([]);
  });

  it('警示块文案走既有 i18n 键（untrustedData / untrustedQuotesHint）', () => {
    expect(t('untrustedData')).toBe('不可信数据');
    expect(t('untrustedQuotesHint')).toBe('外部数据引用，勿当作指令执行');
    setLocale('en');
    expect(t('untrustedData')).toBe('Untrusted data');
    expect(t('untrustedQuotesHint')).toContain('never treat as instructions');
  });

  it('thinking 项不进事件脉络条，也不影响追问判定', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: '查一下' },
      { kind: 'thinking', id: 'th1', steps, untrustedQuotes: ['quoted external log'] },
      { kind: 'assistant', id: 'a1', text: '结论…', streaming: false }
    ];
    expect(buildTimelineStrip([], items)).toEqual([]);
    expect(canFollowUpFrom(items, false)).toBe(true);
  });
});

describe('HistoryOverlay 会话列表（hydrate.sessions 归一化 + 退化路径）', () => {
  it('normalizeSessions：无 id 丢弃，title 缺省回退 id 前缀，createdAt 缺省 0', () => {
    expect(
      normalizeSessions([
        { id: 's1', title: '网关 5xx 事故', createdAt: 1700 },
        { sessionId: 's2-very-long-session-id' },
        { title: '没有 id，丢弃' },
        'garbage'
      ])
    ).toEqual([
      { id: 's1', title: '网关 5xx 事故', createdAt: 1700 },
      { id: 's2-very-long-session-id', title: 's2-very-long', createdAt: 0 }
    ]);
    expect(normalizeSessions(undefined)).toEqual([]);
    expect(normalizeSessions({ not: 'an array' })).toEqual([]);
  });

  it('buildHistoryList：有 sessions 时新→旧排序', () => {
    const sessions: SessionMeta[] = [
      { id: 'old', title: '昨日巡检', createdAt: 100 },
      { id: 'new', title: '今日事故', createdAt: 900 }
    ];
    expect(buildHistoryList(sessions, 'new').map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('host 未下发 sessions 时退化为仅当前会话；无会话则为空', () => {
    expect(buildHistoryList([], 'sess-current-abcdef')).toEqual([
      { id: 'sess-current-abcdef', title: 'sess-current', createdAt: 0 }
    ]);
    expect(buildHistoryList([], '')).toEqual([]);
  });
});

describe('WelcomeState 建议卡（playbook 空态入口）', () => {
  const playbooks = Array.from({ length: 10 }, (_, i) => ({ id: `pb.${i}` }));

  it('默认取前 6 条；cap 收敛到 4–8', () => {
    expect(buildWelcomeSuggestions(playbooks)).toHaveLength(6);
    expect(buildWelcomeSuggestions(playbooks, 2)).toHaveLength(4);
    expect(buildWelcomeSuggestions(playbooks, 20)).toHaveLength(8);
  });

  it('playbook 不足 cap 时全部展示', () => {
    expect(buildWelcomeSuggestions(playbooks.slice(0, 3), 6)).toHaveLength(3);
  });
});

describe('i18n：欢迎页 / 历史会话新键（zh-CN + en）', () => {
  it('zh-CN 文案', () => {
    expect(t('historyButton')).toBe('历史');
    expect(t('welcomeTitle')).toBe('开始一次运维调查');
    expect(t('historyNew')).toBe('新会话');
  });

  it('en 文案', () => {
    setLocale('en');
    expect(t('historyButton')).toBe('History');
    expect(t('welcomeTitle')).toBe('Start an ops investigation');
    expect(t('roleUser')).toBe('You');
  });

  it('模型选择器空态引导键（zh-CN + en 同步存在；空态是可点按钮）', () => {
    expect(t('modelSelectorEmpty')).toBe('配置模型');
    expect(t('modelSelectorAria')).toBe('选择模型');
    setLocale('en');
    expect(t('modelSelectorEmpty')).toBe('Configure model');
    expect(t('modelSelectorAria')).toBe('Choose model');
  });

  it('P1-13 补漏键：九要素 / 阶段 / 风险 / 工具状态双语齐备', () => {
    expect(t('elGoal')).toBe('目标');
    expect(t('elRollback')).toBe('回滚方案');
    expect(t('stageTriage')).toBe('分诊');
    expect(t('riskExec')).toBe('执行');
    expect(t('statusToolError')).toBe('失败');
    setLocale('en');
    expect(t('elGoal')).toBe('Goal');
    expect(t('stageAwaitingApproval')).toBe('Awaiting approval');
    expect(t('riskExec')).toBe('exec');
    expect(t('welcomeSetupCta')).toBe('Configure model');
    expect(t('composerCancel')).toBe('Cancel');
  });

  it('tf：{count} 占位符替换（只读聚合组头）', () => {
    expect(tf('toolGroupReads', { count: 4 })).toBe('4 个只读调用');
    setLocale('en');
    expect(tf('toolGroupReads', { count: 4 })).toBe('4 read-only calls');
  });
});

describe('ModelSelector 模型清单归一化（normalizeChatModels）', () => {
  it('空数组 / 非数组 ⇒ []（空 = 未配置，不是解析失败）', () => {
    expect(normalizeChatModels([])).toEqual([]);
    expect(normalizeChatModels(undefined)).toEqual([]);
    expect(normalizeChatModels({ not: 'an array' })).toEqual([]);
  });

  it('完整条目原样归一；provider/label 缺省回退 custom / model id', () => {
    expect(
      normalizeChatModels([
        { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        { model: 'qwen3-max' }
      ])
    ).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { provider: 'custom', model: 'qwen3-max', label: 'qwen3-max' }
    ]);
  });

  it('id/name 字段可替代 model/label；无 model 的条目丢弃', () => {
    expect(
      normalizeChatModels([
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
        { label: '没有 model，丢弃' },
        { model: '   ' },
        'garbage'
      ])
    ).toEqual([{ provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' }]);
  });
});

describe('store：模型清单吸收（hydrate 顶层 / capabilities/snapshot）', () => {
  const empty = { modelOptions: [], modelLabel: '', modelProvider: '' };

  it('初始状态为空（不用假模型占位）', () => {
    expect(empty.modelOptions).toEqual([]);
    expect(empty.modelLabel).toBe('');
    expect(empty.modelProvider).toBe('');
  });

  it('capabilities/snapshot：models 是数组就整体覆盖，含空数组', () => {
    const filled = absorbChatModelFields(empty, {
      model: 'qwen3-max',
      modelProvider: 'custom',
      models: [{ provider: 'custom', model: 'qwen3-max', label: 'Qwen3 Max' }]
    });
    expect(filled.modelOptions).toEqual([
      { provider: 'custom', model: 'qwen3-max', label: 'Qwen3 Max' }
    ]);
    expect(filled.modelLabel).toBe('qwen3-max');
    expect(filled.modelProvider).toBe('custom');
    const cleared = absorbChatModelFields(filled, { models: [] });
    expect(cleared.modelOptions).toEqual([]);
  });

  it('hydrate：顶层 models/model/modelProvider 覆盖 providers 快照里的旧值', () => {
    const next = absorbHydrateModels(empty, {
      providers: {
        providers: [],
        model: 'stale-model',
        models: [{ provider: 'custom', model: 'stale-model' }]
      },
      models: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      model: 'claude-sonnet-4-5',
      modelProvider: 'anthropic'
    });
    expect(next.modelOptions).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }
    ]);
    expect(next.modelLabel).toBe('claude-sonnet-4-5');
    expect(next.modelProvider).toBe('anthropic');
  });

  it('hydrate 未带顶层字段时仍从 providers 快照吸收（旧 host 兼容）', () => {
    const next = absorbHydrateModels(empty, {
      providers: {
        providers: [],
        model: 'qwen3-max',
        models: [{ provider: 'custom', model: 'qwen3-max', label: 'Qwen3 Max' }]
      }
    });
    expect(next.modelOptions).toEqual([
      { provider: 'custom', model: 'qwen3-max', label: 'Qwen3 Max' }
    ]);
    expect(next.modelLabel).toBe('qwen3-max');
  });
});

describe('store：hydrate 元数据吸收（hasApiKey / usage）与未配置判定', () => {
  const empty = { hasApiKey: null, usage: null };

  it('hasApiKey 只认布尔；缺省保持旧值（旧 host 兼容）', () => {
    expect(absorbHydrateMeta(empty, { hasApiKey: true }).hasApiKey).toBe(true);
    expect(absorbHydrateMeta(empty, { hasApiKey: false }).hasApiKey).toBe(false);
    expect(absorbHydrateMeta(empty, {}).hasApiKey).toBeNull();
    expect(absorbHydrateMeta({ hasApiKey: true, usage: null }, {}).hasApiKey).toBe(true);
    expect(absorbHydrateMeta(empty, { hasApiKey: 'yes' }).hasApiKey).toBeNull();
  });

  it('usage：字段缺省保持旧值；下发对象归一化数值', () => {
    const next = absorbHydrateMeta(empty, {
      usage: { inputTokens: 100, contextUsed: 4000, contextWindow: 128_000, costUsd: -1 }
    });
    expect(next.usage).toEqual({
      inputTokens: 100,
      outputTokens: undefined,
      contextUsed: 4000,
      contextWindow: 128_000,
      costUsd: undefined
    });
    const kept = absorbHydrateMeta({ hasApiKey: null, usage: next.usage }, {});
    expect(kept.usage).toBe(next.usage);
  });

  it('normalizeUsage：无任何数值字段 ⇒ null；usagePercent 0–100 取整', () => {
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage('garbage')).toBeNull();
    expect(usagePercent(normalizeUsage({ contextUsed: 46_500, contextWindow: 128_000 }))).toBe(36);
    expect(usagePercent(normalizeUsage({ contextUsed: 200, contextWindow: 100 }))).toBe(100);
    expect(usagePercent(normalizeUsage({ inputTokens: 5 }))).toBeNull();
    expect(usagePercent(null)).toBeNull();
  });

  it('modelsConfigured：无模型或 hasApiKey===false ⇒ 未配置；null 不拦截', () => {
    const models = [{ provider: 'custom', model: 'qwen3-max' }];
    expect(modelsConfigured([], null)).toBe(false);
    expect(modelsConfigured(models, false)).toBe(false);
    expect(modelsConfigured(models, null)).toBe(true);
    expect(modelsConfigured(models, true)).toBe(true);
  });
});

describe('ChatTranscript 渲染列表：连续只读工具聚合（buildRenderList）', () => {
  const readTool = (id: string, status = 'ok' as const): TranscriptItem => ({
    kind: 'tool',
    id,
    call: { name: `read-${id}`, risk: 'read', status }
  });

  it('连续 ≥3 个已结束只读工具折叠为 toolGroup（组 id 取首条）', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: '查一下' },
      readTool('t1'),
      readTool('t2'),
      readTool('t3'),
      { kind: 'assistant', id: 'a1', text: '结论', streaming: false }
    ];
    const out = buildRenderList(items);
    expect(out.map((e) => e.kind)).toEqual(['item', 'toolGroup', 'item']);
    const group = out[1];
    expect(group.kind).toBe('toolGroup');
    if (group.kind === 'toolGroup') {
      expect(group.id).toBe('toolgroup-t1');
      expect(group.items.map((i) => i.id)).toEqual(['t1', 't2', 't3']);
    }
  });

  it('少于 3 个不聚合，原样透传', () => {
    const items: TranscriptItem[] = [readTool('t1'), readTool('t2')];
    expect(buildRenderList(items).map((e) => e.kind)).toEqual(['item', 'item']);
  });

  it('write/exec、running、error 工具打断聚合并保持单卡可见', () => {
    const items: TranscriptItem[] = [
      readTool('t1'),
      readTool('t2'),
      { kind: 'tool', id: 'w1', call: { name: 'write', risk: 'write', status: 'ok' } },
      readTool('t3'),
      readTool('t4', 'error' as never),
      readTool('t5')
    ];
    const out = buildRenderList(items);
    // t1/t2 不足 3 → 单卡；w1 单卡；t3 单卡；t4(error) 单卡；t5 单卡
    expect(out.every((e) => e.kind === 'item')).toBe(true);
    expect(out).toHaveLength(6);
  });

  it('running 只读工具不进组（保持实时可见）', () => {
    const items: TranscriptItem[] = [
      readTool('t1'),
      readTool('t2'),
      readTool('t3'),
      { kind: 'tool', id: 't4', call: { name: 'live', risk: 'read', status: 'running' } }
    ];
    const out = buildRenderList(items);
    expect(out.map((e) => e.kind)).toEqual(['toolGroup', 'item']);
  });
});

describe('SubagentBoard/ChatApp 子代理 inspector（docs/12 §3）', () => {
  const card = (taskId: string, status: SubagentCard['status'], goal?: string): SubagentCard => ({
    taskId,
    role: 'investigator',
    label: `label-${taskId}`,
    status,
    riskCeiling: 'read',
    toolCalls: { used: 1, max: 6 },
    wallMs: { used: 1200, max: 60000 },
    goal
  });

  it('collectSubagentCards：跨看板平铺，同 taskId 后到覆盖先到', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: '巡检' },
      { kind: 'subagents', id: 'b1', agents: [card('t1', 'running'), card('t2', 'queued')] },
      { kind: 'assistant', id: 'a1', text: '…', streaming: false },
      { kind: 'subagents', id: 'b2', agents: [card('t1', 'ok'), card('t3', 'failed')] }
    ];
    const cards = collectSubagentCards(items);
    expect(cards.map((c) => c.taskId)).toEqual(['t1', 't2', 't3']);
    expect(cards[0].status).toBe('ok');
  });

  it('activeSubagentCards：只留 queued/running（顶栏运行条数据源）', () => {
    const cards = [card('t1', 'ok'), card('t2', 'running'), card('t3', 'queued'), card('t4', 'aborted')];
    expect(activeSubagentCards(cards).map((c) => c.taskId)).toEqual(['t2', 't3']);
  });

  it('subagentTitle：goal 首行优先；goal 空白/缺失回退 label', () => {
    expect(subagentTitle(card('t1', 'running', '检查磁盘水位\n第二行不进标题'))).toBe('检查磁盘水位');
    expect(subagentTitle(card('t2', 'running'))).toBe('label-t2');
    expect(subagentTitle(card('t3', 'running', '  \n'))).toBe('label-t3');
  });

  it('resolveInspectedSubagent：命中返回卡；null / id 失配（卡被移除）视同关闭（ChatApp overlay 数据源）', () => {
    const items: TranscriptItem[] = [
      { kind: 'subagents', id: 'b1', agents: [card('t1', 'running')] }
    ];
    expect(resolveInspectedSubagent(items, null)).toBeNull();
    expect(resolveInspectedSubagent(items, 't1')?.taskId).toBe('t1');
    // 卡被移除（transcript 覆盖）→ id 失配视同关闭，overlay 不渲染
    expect(resolveInspectedSubagent([], 't1')).toBeNull();
  });

  it('findAdjacentSubagent：环状翻页导航（<=1 张返回 null；>1 张 prev/next 循环）', () => {
    const cards = [card('t1', 'running'), card('t2', 'running'), card('t3', 'ok')];
    expect(findAdjacentSubagent(cards, 't1', 'next')).toBe('t2');
    expect(findAdjacentSubagent(cards, 't2', 'next')).toBe('t3');
    expect(findAdjacentSubagent(cards, 't3', 'next')).toBe('t1');
    expect(findAdjacentSubagent(cards, 't1', 'prev')).toBe('t3');
    expect(findAdjacentSubagent(cards, 't3', 'prev')).toBe('t2');
    expect(findAdjacentSubagent([card('t1', 'running')], 't1', 'next')).toBeNull();
    expect(findAdjacentSubagent(cards, 'not-exist', 'next')).toBeNull();
  });

  it('inspector 新增文案 zh/en 双语齐备（含空输出与顶栏条）', () => {
    expect(t('subagentNoOutput')).toBe('尚无输出');
    expect(tf('subagentStripCount', { count: 2 })).toBe('2 个子代理进行中');
    setLocale('en');
    expect(t('subagentNoOutput')).toBe('No output yet');
    expect(tf('subagentStripCount', { count: 2 })).toContain('2');
    expect(t('subagentVisibleTools')).toBe('Visible tools');
  });
});

describe('ToolCallCard 标题意图（toolCallHeadline，docs/14 P1-ui）', () => {
  it('纯文本 preview 首行提命令并映射意图：df -h → 磁盘', () => {
    expect(toolCallHeadline({ name: 'run_remote_command', preview: 'df -h' })).toBe('磁盘 · df -h');
    expect(toolCallHeadline({ name: 'run_remote_command', preview: 'free -m\nMem: ...' })).toBe(
      '内存 · free -m'
    );
  });

  it('run_remote_command 的 JSON preview 走 .command 字段', () => {
    expect(
      toolCallHeadline({
        name: 'run_remote_command',
        preview: '{"command":"docker ps -a","serverName":"prod-gw-01"}'
      })
    ).toBe('容器 · docker ps -a');
    expect(
      toolCallHeadline({ name: 'run_remote_command', preview: JSON.stringify({ command: 'systemctl status nginx' }) })
    ).toBe('服务 · systemctl status nginx');
  });

  it('组合命令取首词；sudo 前缀被跳过', () => {
    expect(toolCallHeadline({ name: 'run_remote_command', preview: 'hostname && uptime && w' })).toBe(
      '主机 · hostname && uptime && w'
    );
    expect(toolCallHeadline({ name: 'run_remote_command', preview: 'sudo journalctl -u nginx -n 50' })).toBe(
      '日志 · sudo journalctl -u nginx -n 50'
    );
  });

  it('长命令截断到 48 字符并加省略号', () => {
    const cmd = 'journalctl -u nginx --since "2026-08-28" --no-pager | grep -i error | head -n 200';
    expect(toolCallHeadline({ name: 'run_remote_command', preview: cmd })).toBe(
      `日志 · ${cmd.slice(0, 48)}…`
    );
  });

  it('工具名本身可映射（list_ssh_servers → SSH 目标），无命令时回退 name', () => {
    expect(toolCallHeadline({ name: 'list_ssh_servers' })).toBe('SSH 目标 · list_ssh_servers');
    expect(toolCallHeadline({ name: 'list_ssh_servers', preview: '{"servers":[]}' })).toBe(
      'SSH 目标 · list_ssh_servers'
    );
  });

  it('未知工具/提不出意图回退 name（有命令时附短命令）', () => {
    expect(toolCallHeadline({ name: 'mystery_tool' })).toBe('mystery_tool');
    expect(toolCallHeadline({ name: 'run_remote_command', preview: '{"result":"ok"}' })).toBe(
      'run_remote_command'
    );
    expect(toolCallHeadline({ name: 'run_remote_command', preview: 'cat /etc/os-release' })).toBe(
      'run_remote_command · cat /etc/os-release'
    );
  });

  it('parseToolOutputPreview：JSON 解析提取 command / exitCode / stdout / stderr，回退纯文本', () => {
    const jsonStr = JSON.stringify({
      command: 'systemctl status nginx',
      exitCode: 0,
      stdout: 'Active: active (running)'
    });
    expect(parseToolOutputPreview(jsonStr)).toEqual({
      command: 'systemctl status nginx',
      exitCode: 0,
      stdout: 'Active: active (running)',
      stderr: undefined,
      rawText: jsonStr
    });
    expect(parseToolOutputPreview('plain string output')).toEqual({
      rawText: 'plain string output'
    });
    expect(parseToolOutputPreview(undefined)).toEqual({
      rawText: ''
    });
  });
});

describe('ChatTranscript 空 assistant（assistantDisplay，docs/14 P1-ui）', () => {
  it('空正文 + 已结束 ⇒ skip（不留空白气泡，无 DOM）', () => {
    expect(assistantDisplay({ text: '', streaming: false })).toBe('skip');
    expect(assistantDisplay({ text: '  \n ' })).toBe('skip');
  });

  it('空正文 + 流式中 ⇒ progress（「正在巡检…」单行占位）', () => {
    expect(assistantDisplay({ text: '', streaming: true })).toBe('progress');
    expect(assistantDisplay({ text: '   ', streaming: true })).toBe('progress');
  });

  it('有正文 / error ⇒ content 照常渲染（含错误 + Retry）', () => {
    expect(assistantDisplay({ text: '巡检结论…', streaming: false })).toBe('content');
    expect(assistantDisplay({ text: '结论', streaming: true })).toBe('content');
    expect(assistantDisplay({ text: '', streaming: false, error: true })).toBe('content');
  });

  it('inspectingProgress 文案 zh/en 齐备', () => {
    expect(t('inspectingProgress')).toBe('正在巡检…');
    setLocale('en');
    expect(t('inspectingProgress')).toBe('Inspecting…');
  });
});

describe('复制 i18n + clipboard helper（P0-E hover 复制）', () => {
  it('copy / copied / copyAria zh+en 齐备', () => {
    expect(t('copy')).toBe('复制');
    expect(t('copied')).toBe('已复制');
    expect(t('copyAria')).toBe('复制到剪贴板');
    expect(t('historyExportAria')).toBe('导出值班报告');
    setLocale('en');
    expect(t('copy')).toBe('Copy');
    expect(t('copied')).toBe('Copied');
    expect(t('copyAria')).toBe('Copy to clipboard');
    expect(t('historyExportAria')).toBe('Export duty report');
  });

  it('工具卡复制文本是 headline 不是 preview 全文', () => {
    const call = {
      name: 'run_remote_command',
      preview: 'df -h\nFilesystem      Size  Used Avail Use%\n/dev/vda1        50G   46G  4.0G  93%'
    };
    const headline = toolCallHeadline(call);
    expect(headline).toBe('磁盘 · df -h');
    expect(headline).not.toContain('Filesystem');
    expect(headline).not.toContain('93%');
  });

  it('copyText 成功路径走 navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const nav = globalThis as { navigator: { clipboard?: { writeText: (s: string) => Promise<void> } } };
    Object.defineProperty(nav.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    // 非字面量 import：避免 tsc 把 webview vscode-api（window）拉进 node tsconfig
    const spec = '../src/webview-chat/lib/clipboard';
    const { copyText } = (await import(spec)) as { copyText: (text: string) => Promise<boolean> };
    await expect(copyText('df -h')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('df -h');
  });

  it('copyText 在 clipboard 失败时 post clipboard/write', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const nav = globalThis as { navigator: { clipboard?: { writeText: (s: string) => Promise<void> } } };
    Object.defineProperty(nav.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const posted: unknown[] = [];
    const apiSpec = '../src/webview-chat/vscode-api';
    const { getVsCodeApi } = (await import(apiSpec)) as {
      getVsCodeApi: () => { postMessage: (message: unknown) => void };
    };
    const api = getVsCodeApi();
    const orig = api.postMessage.bind(api);
    api.postMessage = (message: unknown) => {
      posted.push(message);
    };
    const spec = '../src/webview-chat/lib/clipboard';
    const { copyText } = (await import(spec)) as { copyText: (text: string) => Promise<boolean> };
    await expect(copyText('systemctl status nginx')).resolves.toBe(true);
    expect(
      posted.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'clipboard/write' &&
          (m as { payload?: { text?: string } }).payload?.text === 'systemctl status nginx'
      )
    ).toBe(true);
    api.postMessage = orig;
  });

  it('三处复制组件含 codicon-copy；工具卡 @click.stop 且不复制 preview', () => {
    const dir = path.join(process.cwd(), 'src/webview-chat/components');
    const markdown = readFileSync(path.join(dir, 'MarkdownBlock.vue'), 'utf8');
    const tool = readFileSync(path.join(dir, 'ToolCallCard.vue'), 'utf8');
    const approval = readFileSync(path.join(dir, 'ApprovalBar.vue'), 'utf8');
    const history = readFileSync(path.join(dir, 'HistoryOverlay.vue'), 'utf8');
    expect(markdown).toContain('codicon-copy');
    expect(tool).toContain('codicon-copy');
    expect(approval).toContain('codicon-copy');
    expect(tool).toContain('@click.stop="copyHeadline"');
    expect(tool).not.toMatch(/copy\(preview/);
    expect(tool).not.toContain('copyPreview');
    expect(history).toContain("store.post('chat/export', { sessionId");
    expect(history).toContain('@click.stop="exportSession');
  });
});

describe('ChatTranscript 流式 Markdown + 审批留痕（Plan 10）', () => {
  const transcript = readFileSync(
    path.join(process.cwd(), 'src/webview-chat/components/ChatTranscript.vue'),
    'utf8'
  );

  it('assistant content 走 MarkdownBlock + streaming，不再插值原文；caret 仍只有一套', () => {
    expect(transcript).toContain(
      '<MarkdownBlock :source="entry.item.text" :streaming="!!entry.item.streaming" />'
    );
    expect(transcript).not.toMatch(
      /\{\{\s*entry\.item\.text\s*\}\}\s*<span class="transcript__caret"/
    );
    expect((transcript.match(/class="transcript__caret"/g) ?? []).length).toBe(1);
  });

  it('user / error 分支仍可插值原文', () => {
    expect(transcript).toContain('class="transcript__text transcript__well">{{ entry.item.text }}');
    expect(transcript).toContain('class="transcript__text transcript__text--error"');
  });

  it('审批行显示决议 + toLocaleTimeString，不再只写已处理', () => {
    expect(transcript).toContain('approvalOutcomeText(entry.item)');
    expect(transcript).toContain('toLocaleTimeString');
    expect(transcript).toContain("t('approvalTimeout')");
    expect(transcript).not.toMatch(/v-else>\{\{\s*t\('approvalHandled'\)\s*\}\}<\/span>/);
  });
});

describe('T11 helpers smoke（结论模式 / 思考时长 / 审批空要素）', () => {
  it('filterTranscriptForView 结论模式只留 assistant/evidence/notice', () => {
    const items = [
      { kind: 'assistant', id: 'a', text: 'ok' },
      { kind: 'thinking', id: 't', steps: ['cot'] },
      { kind: 'notice', id: 'n', variant: 'info' as const, text: 'hi' }
    ] as TranscriptItem[];
    expect(filterTranscriptForView(items, { conclusionMode: false })).toHaveLength(3);
    expect(filterTranscriptForView(items, { conclusionMode: true }).map((i) => i.kind)).toEqual([
      'assistant',
      'notice'
    ]);
    expect(isConclusionItem(items[0])).toBe(true);
  });

  it('thinkingMetaVisible 与 formatThinkingDurationMs', () => {
    expect(thinkingMetaVisible(true, false)).toBe(true);
    expect(thinkingMetaVisible(true, true)).toBe(false);
    expect(formatThinkingDurationMs(850)).toBe('850ms');
    expect(formatThinkingDurationMs(undefined)).toBeNull();
  });

  it('ApprovalBar 空值折叠 + 命令关键词', () => {
    expect(isBlankApprovalValue('')).toBe(true);
    expect(isBlankApprovalValue('rm -rf /')).toBe(false);
    const segs = annotateCommandKeywords('rm -rf /tmp && kubectl apply -f x');
    expect(segs.some((s) => s.keyword && s.text === 'rm')).toBe(true);
    expect(segs.some((s) => s.keyword && s.text === 'kubectl apply')).toBe(true);
  });
});

describe('结论模式 filter（Plan 12 T11）', () => {
  const items: TranscriptItem[] = [
    { kind: 'user', id: 'u1', text: '查一下' },
    { kind: 'thinking', id: 'th1', steps: ['hidden'], durationMs: 1200 },
    { kind: 'tool', id: 't1', call: { name: 'df', risk: 'read', status: 'ok' } },
    { kind: 'assistant', id: 'a1', text: '磁盘 93%', streaming: false },
    {
      kind: 'evidence',
      id: 'ev1',
      note: { taskId: 't1', confidence: 'confirmed', summary: 'df -h', refs: [] }
    },
    { kind: 'notice', id: 'n1', variant: 'info', text: '已写入 OPS.md' },
    { kind: 'system', id: 'sys1', text: '上下文已压缩' }
  ];

  it('isConclusionItem 只认 assistant / evidence / notice', () => {
    expect(items.filter(isConclusionItem).map((item) => item.kind)).toEqual([
      'assistant',
      'evidence',
      'notice'
    ]);
  });

  it('conclusionMode 隐藏 tool/thinking/user/system，保留结论三件套', () => {
    const filtered = filterTranscriptForView(items, { conclusionMode: true });
    expect(filtered.map((item) => item.kind)).toEqual(['assistant', 'evidence', 'notice']);
    expect(filterTranscriptForView(items, { conclusionMode: false })).toBe(items);
  });

  it('结论模式下列表走 filter 后再聚合，工具组不会漏出来', () => {
    const out = buildRenderList(filterTranscriptForView(items, { conclusionMode: true }));
    expect(out.every((entry) => entry.kind === 'item')).toBe(true);
    expect(out.map((entry) => (entry.kind === 'item' ? entry.item.kind : entry.kind))).toEqual([
      'assistant',
      'evidence',
      'notice'
    ]);
  });

  it('Composer 旁有结论模式 toggle；store 不持久化该 flag', () => {
    const composer = readFileSync(
      path.join(process.cwd(), 'src/webview-chat/components/Composer.vue'),
      'utf8'
    );
    const store = readFileSync(path.join(process.cwd(), 'src/webview-chat/store.ts'), 'utf8');
    expect(composer).toContain('toggleConclusionMode');
    expect(composer).toContain('conclusionModeAria');
    expect(store).toContain('conclusionMode: false');
    expect(store).toContain('toggleConclusionMode');
    expect(store).not.toMatch(/setState\(\{[^}]*conclusionMode/);
  });
});

describe('ApprovalBar 空要素折叠 + 命令关键词 span（Plan 12 T11）', () => {
  it('isBlankApprovalValue：空串 / 破折号 / 空数组 / null 视为空', () => {
    expect(isBlankApprovalValue(undefined)).toBe(true);
    expect(isBlankApprovalValue(null)).toBe(true);
    expect(isBlankApprovalValue('')).toBe(true);
    expect(isBlankApprovalValue('  ')).toBe(true);
    expect(isBlankApprovalValue('—')).toBe(true);
    expect(isBlankApprovalValue([])).toBe(true);
    expect(isBlankApprovalValue(['', '  '])).toBe(true);
    expect(isBlankApprovalValue({})).toBe(true);
    expect(isBlankApprovalValue('回滚 api-gateway')).toBe(false);
    expect(isBlankApprovalValue(['kubectl apply -f x.yaml'])).toBe(false);
  });

  it('annotateCommandKeywords：只给 rm / kubectl apply / delete 套 span，不是整行', () => {
    const segs = annotateCommandKeywords('rm -rf /tmp && kubectl apply -f n.yaml && kubectl delete pod x');
    const keywords = segs.filter((seg) => seg.keyword).map((seg) => seg.text);
    expect(keywords).toEqual(['rm', 'kubectl apply', 'delete']);
    expect(segs.map((seg) => seg.text).join('')).toBe(
      'rm -rf /tmp && kubectl apply -f n.yaml && kubectl delete pod x'
    );
    expect(annotateCommandKeywords('echo hello').every((seg) => !seg.keyword)).toBe(true);
  });

  it('ApprovalBar 模板：关键词 class 在 span；复制钮仍在；空行不再写死破折号', () => {
    const approval = readFileSync(
      path.join(process.cwd(), 'src/webview-chat/components/ApprovalBar.vue'),
      'utf8'
    );
    expect(approval).toContain('annotateCommandKeywords');
    expect(approval).toContain('isBlankApprovalValue');
    expect(approval).toContain('approval__kw');
    expect(approval).toContain('codicon-copy');
    expect(approval).toContain('@click.stop="copyCommands(row)"');
    expect(approval).not.toContain("? '—'");
  });
});

describe('board leftover emoji → codicon（Plan 12 T11）', () => {
  it('IncidentTimeline 严重级用 codicon，不再用 ○△✗', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/webview-board/components/IncidentTimeline.vue'),
      'utf8'
    );
    expect(src).toContain('codicon-circle-outline');
    expect(src).toContain('codicon-warning');
    expect(src).toContain('codicon-error');
    expect(src).not.toContain("'○'");
    expect(src).not.toContain("'△'");
    expect(src).not.toContain("'✗'");
  });
});

describe('思考时长 + Focus/showThinking（Plan 12 T11）', () => {
  it('协议 thinking 变体可带可选 durationMs', () => {
    const item: TranscriptItem = {
      kind: 'thinking',
      id: 'th1',
      steps: ['hidden cot'],
      durationMs: 1840
    };
    expect(item.durationMs).toBe(1840);
    const bare: TranscriptItem = { kind: 'thinking', id: 'th2', steps: [] };
    expect(bare.kind === 'thinking' && bare.durationMs).toBeUndefined();
  });

  it('formatThinkingDurationMs：毫秒 / 秒；非法值 null', () => {
    expect(formatThinkingDurationMs(850)).toBe('850ms');
    expect(formatThinkingDurationMs(0)).toBe('0ms');
    expect(formatThinkingDurationMs(1200)).toBe('1.2s');
    expect(formatThinkingDurationMs(11_000)).toBe('11s');
    expect(formatThinkingDurationMs(undefined)).toBeNull();
    expect(formatThinkingDurationMs(-1)).toBeNull();
  });

  it('thinkingMetaVisible：默认 true；结论/Focus 强制 false', () => {
    expect(thinkingMetaVisible(true, false)).toBe(true);
    expect(thinkingMetaVisible(false, false)).toBe(false);
    expect(thinkingMetaVisible(true, true)).toBe(false);
    expect(thinkingMetaVisible(false, true)).toBe(false);
  });

  it('ChatTranscript：集成 ThinkingBlock 组件呈现思考链；保留 Plan 10 Markdown 与 Plan 11 存档 hover', () => {
    const transcript = readFileSync(
      path.join(process.cwd(), 'src/webview-chat/components/ChatTranscript.vue'),
      'utf8'
    );
    expect(transcript).toContain('<ThinkingBlock');
    expect(transcript).toContain('thinkingMetaVisible(store.showThinking, store.conclusionMode)');
    expect(transcript).toContain(
      '<MarkdownBlock :source="entry.item.text" :streaming="!!entry.item.streaming" />'
    );
    expect(transcript).toContain('store.saveOpsDoc(entry.item.id)');
    expect(transcript).toContain('transcript__save-doc');
    expect(transcript).toContain('padding: var(--ops-space-1) var(--ops-space-2)');
  });

  it('思考时长 i18n zh/en 齐备', () => {
    expect(t('thinkingInProgress')).toBe('思考中…');
    expect(tf('thinkingDuration', { duration: '1.2s' })).toBe('思考 1.2s');
    expect(t('conclusionMode')).toBe('结论模式');
    setLocale('en');
    expect(t('thinkingInProgress')).toBe('Thinking…');
    expect(tf('thinkingDuration', { duration: '1.2s' })).toBe('Thought 1.2s');
    expect(t('conclusionModeAria')).toContain('Conclusion');
  });
});

describe('终端命令执行组件（Kilo / Cursor 终端解耦，2026-08-31）', () => {
  it('ToolCallCard：分离命令卡与 TerminalViewer 终端视窗', () => {
    const card = readFileSync(
      path.join(process.cwd(), 'src/webview-chat/components/ToolCallCard.vue'),
      'utf8'
    );
    expect(card).toContain('TerminalViewer');
    expect(card).toContain('tool__cmd-bar');
    expect(card).toContain('tool__cmd-prompt');
    expect(card).toContain('tool__cmd-copy');
    expect(card).toContain('tool__term-viewer');
  });

  it('TerminalViewer：具备终端顶栏、退出码徽标、自动贴底开关与呼吸光标', () => {
    const term = readFileSync(
      path.join(process.cwd(), 'src/webview-chat/components/TerminalViewer.vue'),
      'utf8'
    );
    expect(term).toContain('terminal-win');
    expect(term).toContain('terminal-win__header');
    expect(term).toContain('terminal-win__exit-badge');
    expect(term).toContain('toggleAutoScroll');
    expect(term).toContain('terminal-win__cursor');
    expect(term).toContain('parseAnsiToLines');
  });

  it('终端 i18n zh/en 齐备', () => {
    setLocale('zh-cn');
    expect(t('terminalTitle')).toBe('终端输出');
    expect(t('terminalAutoScroll')).toBe('自动贴底');
    expect(t('terminalCopyOutput')).toBe('复制输出');
    expect(t('terminalCopiedOutput')).toBe('已复制输出');
    expect(t('terminalNoOutput')).toBe('（终端无输出）');
    setLocale('en');
    expect(t('terminalTitle')).toBe('Terminal Output');
    expect(t('terminalAutoScroll')).toBe('Auto-scroll');
    expect(t('terminalCopyOutput')).toBe('Copy Output');
    expect(t('terminalCopiedOutput')).toBe('Output Copied');
    expect(t('terminalNoOutput')).toBe('(No output recorded)');
  });

  it('工具分类与子代理隔离（isCommandToolCall / isSubagentToolCall）', () => {
    expect(isCommandToolCall({ name: 'run_remote_command', preview: '{"command":"df -h"}' })).toBe(true);
    expect(isCommandToolCall({ name: 'terminal_run_command', preview: '' })).toBe(true);
    expect(isCommandToolCall({ name: 'ops_dispatch_subagent', preview: '{"role":"investigator"}' })).toBe(false);
    expect(isCommandToolCall({ name: 'ops_list_playbooks', preview: '{"playbooks":[]}' })).toBe(false);
    expect(isCommandToolCall({ name: 'ops_read_skill', preview: '{"content":"# Title"}' })).toBe(false);

    expect(isSubagentToolCall({ name: 'ops_dispatch_subagent' })).toBe(true);
    expect(isSubagentToolCall({ name: 'run_remote_command' })).toBe(false);

    expect(formatDataOutputPreview('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});
