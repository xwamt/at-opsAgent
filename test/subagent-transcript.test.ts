import { describe, expect, it } from 'vitest';
import {
  appendSubagentTextDelta,
  createEmptySubagentTranscript,
  startSubagentAssistant,
  startSubagentThinking,
  appendSubagentThinkingDelta,
  startSubagentTool,
  endSubagentTool
} from '../src/runtime/subagent-transcript';

describe('subagent-transcript builder', () => {
  it('text_delta 追加到 assistant 项而不新增条目', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentAssistant(t, 'a1');
    t = appendSubagentTextDelta(t, 'a1', 'hello');
    t = appendSubagentTextDelta(t, 'a1', ' world');
    const last = t[t.length - 1];
    expect(last.kind).toBe('assistant');
    if (last.kind === 'assistant') expect(last.text).toBe('hello world');
  });

  it('thinking_delta 累积 steps', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentThinking(t, 'th1');
    t = appendSubagentThinkingDelta(t, 'th1', 'step one');
    const item = t.find((i) => i.kind === 'thinking');
    expect(item && item.kind === 'thinking' ? item.steps.join('') : '').toContain('step one');
  });

  it('tool start/end 产生 ToolCallView 状态迁移', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentTool(t, 'tc1', { name: 'at.zabbix.query', risk: 'read' });
    t = endSubagentTool(t, 'tc1', { status: 'ok', preview: '{"hosts":1}', durationMs: 120 });
    const tool = t.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' ? tool.call.status : '').toBe('ok');
    expect(tool && tool.kind === 'tool' ? tool.call.preview : '').toContain('hosts');
  });
});
