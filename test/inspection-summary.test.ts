/**
 * docs/14 P0-report（vscode-free）：模型整轮只调工具、不对用户说话时，
 * host 根据工具 preview 合成中文巡检结论上屏——
 * - visibleAssistantText / hasVisibleReport 只认最后一条 user 之后的
 *   assistant 正文（thinking 永不算可见）；
 * - synthesizeInspectionMarkdown 以「## 巡检结论」开头、逐工具摘录 preview
 *   （单工具 ≤800 字）、结尾提醒未出现的检查项视为未检查；
 * - ensureVisibleInspectionReport 幂等：已有可见结论/已合成过不再插。
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../src/protocol';
import {
  SYNTHESIS_MARKER,
  ensureVisibleInspectionReport,
  hasVisibleReport,
  synthesizeInspectionMarkdown,
  visibleAssistantText,
  type InspectionReportContext
} from '../src/host/services/inspectionSummary';

function user(text: string): TranscriptItem {
  return { kind: 'user', id: `u-${text.slice(0, 8)}`, text };
}

function assistant(text: string, id = 'a1'): TranscriptItem {
  return { kind: 'assistant', id, text };
}

function thinking(steps: string[]): TranscriptItem {
  return { kind: 'thinking', id: 'th1', steps };
}

let toolSeq = 0;
function tool(name: string, preview?: string, status: 'ok' | 'error' = 'ok'): TranscriptItem {
  toolSeq += 1;
  return {
    kind: 'tool',
    id: `t${toolSeq}`,
    call: { name, risk: 'read', status, ...(preview !== undefined ? { preview } : {}) }
  };
}

function fakeCtx(items: TranscriptItem[]): {
  ctx: InspectionReportContext;
  items: TranscriptItem[];
  emitted: string[];
} {
  const emitted: string[] = [];
  const ctx: InspectionReportContext = {
    store: { itemsOf: () => items },
    emitAssistantNotice: (text) => {
      emitted.push(text);
      // 模拟 HostContext.emitAssistantNotice：以 assistant 身份写回 store。
      items.push({ kind: 'assistant', id: `synth-${emitted.length}`, text });
    }
  };
  return { ctx, items, emitted };
}

describe('inspectionSummary', () => {
  it('整轮只有工具（run_remote_command previews）：无可见结论，合成含巡检结论与 preview 摘录', () => {
    const items: TranscriptItem[] = [
      user('巡检一下 192.168.1.10'),
      tool('run_remote_command', 'Filesystem  Use%\n/dev/vda1   93% /data'),
      tool('run_remote_command', 'load average: 0.42, 0.38, 0.35')
    ];
    expect(hasVisibleReport(items)).toBe(false);
    expect(visibleAssistantText(items)).toBe('');
    const md = synthesizeInspectionMarkdown(items);
    expect(md.startsWith(`## 巡检结论 ${SYNTHESIS_MARKER}`)).toBe(true);
    expect(md).toContain('巡检结论');
    expect(md).toContain('run_remote_command');
    expect(md).toContain('93% /data');
    expect(md).toContain('load average: 0.42');
    expect(md).toContain('未在上文出现的检查项请视为未检查');
  });

  it('最后一条 user 之后 assistant ≥50 字：hasVisibleReport 为 true', () => {
    const report =
      '巡检结论：主机 web-01 负载正常（load 0.4），磁盘 /data 使用率 93% 偏高，内存与服务未见异常，建议清理日志。';
    expect(report.trim().length).toBeGreaterThanOrEqual(50);
    const items: TranscriptItem[] = [
      user('巡检一下'),
      tool('run_remote_command', 'df 输出…'),
      assistant(report)
    ];
    expect(hasVisibleReport(items)).toBe(true);
    expect(visibleAssistantText(items)).toBe(report);
  });

  it('上一轮的长 assistant 不算本轮可见结论（只认最后一条 user 之后）', () => {
    const items: TranscriptItem[] = [
      user('先聊聊'),
      assistant('这是上一轮的很长很长的回答'.repeat(10), 'a-prev'),
      user('现在巡检'),
      tool('run_remote_command', 'uptime 输出')
    ];
    expect(hasVisibleReport(items)).toBe(false);
  });

  it('thinking-only 不算可见结论（ChatTranscript 永不渲染 thinking）', () => {
    const items: TranscriptItem[] = [
      user('巡检一下'),
      thinking(['我先看磁盘，再看内存，然后汇总一份很完整的巡检报告给用户……'.repeat(3)]),
      tool('run_remote_command', 'MemAvailable: 5Gi')
    ];
    expect(visibleAssistantText(items)).toBe('');
    expect(hasVisibleReport(items)).toBe(false);
  });

  it('合成跳过发现/编排类工具（ops_list_* / ops_get_tool / ops_search_tools / ops_select / ops_read_skill）', () => {
    const items: TranscriptItem[] = [
      user('巡检'),
      tool('ops_list_providers', 'providers…'),
      tool('ops_select_tools', 'selected…'),
      tool('ops_get_tool', 'schema…'),
      tool('ops_search_tools', 'results…'),
      tool('ops_read_skill', 'skill…'),
      tool('run_remote_command', 'disk ok 21%')
    ];
    const md = synthesizeInspectionMarkdown(items);
    expect(md).toContain('run_remote_command');
    expect(md).toContain('disk ok 21%');
    expect(md).not.toContain('### ops_list_providers');
    expect(md).not.toContain('### ops_select_tools');
    expect(md).not.toContain('### ops_get_tool');
    expect(md).not.toContain('### ops_search_tools');
    expect(md).not.toContain('### ops_read_skill');
  });

  it('单工具 preview 摘录上限 800 字', () => {
    const long = 'x'.repeat(3000);
    const md = synthesizeInspectionMarkdown([user('巡检'), tool('run_remote_command', long)]);
    const run = /x+/.exec(md)?.[0] ?? '';
    expect(run.length).toBeLessThanOrEqual(800);
    expect(md).toContain('…');
  });

  it('ensureVisibleInspectionReport：无可见结论时合成上屏返回 true，二次调用不重复插入', () => {
    const { ctx, items, emitted } = fakeCtx([
      user('巡检 db-01'),
      tool('run_remote_command', 'df: /var 88%')
    ]);
    expect(ensureVisibleInspectionReport(ctx, 's1')).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('巡检结论');
    expect(emitted[0]).toContain(SYNTHESIS_MARKER);
    expect(emitted[0]).toContain('/var 88%');
    expect(items.at(-1)?.kind).toBe('assistant');
    // 幂等：合成的报告本身就是可见 assistant 正文，close/idle 双入口不双插。
    expect(ensureVisibleInspectionReport(ctx, 's1')).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  it('ensureVisibleInspectionReport：已有 ≥40 字可见结论时返回 false 不上屏', () => {
    const { ctx, emitted } = fakeCtx([
      user('巡检'),
      tool('run_remote_command', 'ok'),
      assistant('巡检结论：主机 web-01 负载、磁盘、内存、服务均正常，本轮未发现异常，未检查项为空，无需整改动作。')
    ]);
    expect(ensureVisibleInspectionReport(ctx, 's1')).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('ensureVisibleInspectionReport：本轮没有业务工具（纯闲聊短回复）不合成', () => {
    const { ctx, emitted } = fakeCtx([user('你好'), assistant('你好！')]);
    expect(ensureVisibleInspectionReport(ctx, 's1')).toBe(false);
    expect(emitted).toHaveLength(0);
    // 只有发现/编排类工具也不合成（没有可汇总的业务输出）。
    const noise = fakeCtx([user('有哪些链路'), tool('ops_list_playbooks', '…')]);
    expect(ensureVisibleInspectionReport(noise.ctx, 's1')).toBe(false);
    expect(noise.emitted).toHaveLength(0);
  });
});
