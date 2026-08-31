import { describe, expect, it } from 'vitest';
import type { SubagentTranscriptItem } from '../src/protocol/host-protocol';
import {
  appendSubagentTextDelta,
  appendSubagentThinkingDelta,
  createEmptySubagentTranscript,
  deriveSubagentPreview,
  endSubagentTool,
  finalizeSubagentAssistant,
  finalizeSubagentThinking,
  getLastAssistantText,
  MAX_TOOL_PREVIEW_BYTES,
  MAX_TRANSCRIPT_ITEMS,
  startSubagentAssistant,
  startSubagentThinking,
  startSubagentTool
} from '../src/runtime/subagent-transcript';

describe('subagent-transcript builder', () => {
  it('text_delta 追加到 assistant 项而不新增条目', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentAssistant(t, 'a1');
    t = appendSubagentTextDelta(t, 'a1', 'hello');
    t = appendSubagentTextDelta(t, 'a1', ' world');
    const last = t[t.length - 1];
    expect(last.kind).toBe('assistant');
    if (last.kind === 'assistant') {
      expect(last.text).toBe('hello world');
      expect(last.streaming).toBe(true);
    }

    t = finalizeSubagentAssistant(t, 'a1');
    const finalized = t.find((i: SubagentTranscriptItem) => i.id === 'a1');
    if (finalized && finalized.kind === 'assistant') {
      expect(finalized.streaming).toBe(false);
    }
  });

  it('text_delta 自动创建 assistant 项如果尚未显式 start', () => {
    let t = createEmptySubagentTranscript();
    t = appendSubagentTextDelta(t, 'a_auto', 'auto started');
    expect(t.length).toBe(1);
    expect(t[0].kind).toBe('assistant');
    if (t[0].kind === 'assistant') {
      expect(t[0].text).toBe('auto started');
    }
  });

  it('thinking_delta 累积 steps 并支持 finalize', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentThinking(t, 'th1');
    t = appendSubagentThinkingDelta(t, 'th1', 'step one');
    t = appendSubagentThinkingDelta(t, 'th1', ' step two');
    const item = t.find((i: SubagentTranscriptItem) => i.kind === 'thinking');
    expect(item && item.kind === 'thinking' ? item.steps.join('') : '').toContain('step one step two');

    t = finalizeSubagentThinking(t, 'th1', 500);
    const finalized = t.find((i: SubagentTranscriptItem) => i.id === 'th1');
    if (finalized && finalized.kind === 'thinking') {
      expect(finalized.streaming).toBe(false);
      expect(finalized.durationMs).toBe(500);
    }
  });

  it('tool start/end 产生 ToolCallView 状态迁移', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentTool(t, 'tc1', { name: 'at.zabbix.query', risk: 'read' });
    const started = t.find((i: SubagentTranscriptItem) => i.kind === 'tool');
    expect(started && started.kind === 'tool' ? started.call.status : '').toBe('running');

    t = endSubagentTool(t, 'tc1', { status: 'ok', preview: '{"hosts":1}', durationMs: 120 });
    const tool = t.find((i: SubagentTranscriptItem) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' ? tool.call.status : '').toBe('ok');
    expect(tool && tool.kind === 'tool' ? tool.call.preview : '').toContain('hosts');
    expect(tool && tool.kind === 'tool' ? tool.call.durationMs : 0).toBe(120);
  });

  it('tool preview 超过上限 4096 字符时自动截断并标记 truncated', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentTool(t, 'tc_long', { name: 'bash', risk: 'exec' });
    const hugeOutput = 'x'.repeat(MAX_TOOL_PREVIEW_BYTES + 500);
    t = endSubagentTool(t, 'tc_long', { status: 'ok', preview: hugeOutput });
    const tool = t.find((i: SubagentTranscriptItem) => i.id === 'tc_long');
    if (tool && tool.kind === 'tool') {
      expect(tool.call.preview?.length).toBe(MAX_TOOL_PREVIEW_BYTES);
      expect(tool.call.truncated).toBe(true);
    }
  });

  it('超过 MAX_TRANSCRIPT_ITEMS (500) 条目时自动 clamp 尾部', () => {
    let t = createEmptySubagentTranscript();
    for (let i = 0; i < MAX_TRANSCRIPT_ITEMS + 20; i++) {
      t = startSubagentAssistant(t, `a_${i}`, `text ${i}`);
    }
    expect(t.length).toBe(MAX_TRANSCRIPT_ITEMS);
    expect(t[0].id).toBe('a_20');
    expect(t[t.length - 1].id).toBe(`a_${MAX_TRANSCRIPT_ITEMS + 19}`);
  });

  it('getLastAssistantText 和 deriveSubagentPreview 提取末条 assistant', () => {
    let t = createEmptySubagentTranscript();
    expect(getLastAssistantText(t)).toBe('');
    expect(deriveSubagentPreview(t, 'fallback summary')).toBe('fallback summary');

    t = startSubagentAssistant(t, 'a1', 'First message');
    t = startSubagentTool(t, 't1', { name: 'test' });
    t = startSubagentAssistant(t, 'a2', 'Second message with details');

    expect(getLastAssistantText(t)).toBe('Second message with details');
    expect(deriveSubagentPreview(t)).toBe('Second message with details');

    const longText = 'A'.repeat(100);
    t = startSubagentAssistant(t, 'a3', longText);
    expect(deriveSubagentPreview(t)).toBe(`${'A'.repeat(80)}…`);
  });

  it('tool-gate recordToolPreview / takeToolPreview 存取消费', async () => {
    const { recordToolPreview, takeToolPreview } = await import('../src/runtime/tool-gate');
    recordToolPreview('tc_cache_1', { preview: 'cached preview', error: undefined });
    expect(takeToolPreview('tc_cache_1')).toEqual({ preview: 'cached preview', error: undefined });
    // 再次取应已被消费删除
    expect(takeToolPreview('tc_cache_1')).toBeUndefined();
  });
});
