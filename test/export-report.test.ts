/**
 * chat/export（P1-10）：buildOpsReportMarkdown 纯函数渲染值班报告。
 * 覆盖：对话时间线、工具调用表、证据便签、审批记录（已决/未决）、
 * playbook 阶段轨迹；红线 = 报告绝不出现审批令牌 / API key。
 */
import { describe, expect, it } from 'vitest';
import { buildOpsReportMarkdown, exportReportFileName } from '../src/host/exportReport';
import { redactSecrets } from '../src/runtime/sanitize';
import type { TranscriptItem } from '../src/protocol';

const NOW = new Date('2026-08-28T10:30:00Z');

function fullInput() {
  const items: TranscriptItem[] = [
    { kind: 'user', id: 'u1', text: '支付网关 5xx 飙升，排查一下' },
    { kind: 'assistant', id: 'a1', text: '先看网关错误率与最近变更。' },
    {
      kind: 'tool',
      id: 't1',
      call: {
        name: 'metrics.query',
        pluginId: 'at-metrics',
        risk: 'read',
        status: 'ok',
        preview: 'error_rate=12% | window=5m'
      }
    },
    {
      kind: 'tool',
      id: 't2',
      call: {
        name: 'k8s.rollback',
        pluginId: 'at-k8s',
        risk: 'exec',
        status: 'error',
        errorCode: 'E_TIMEOUT',
        errorMessage: 'rollout status 超时'
      }
    },
    {
      kind: 'evidence',
      id: 'e1',
      note: {
        taskId: 'task-1',
        confidence: 'confirmed',
        summary: '18:02 发布 v2.31 后错误率上升',
        refs: [{ kind: 'metric', preview: 'error_rate 0.2%→12%' }]
      }
    },
    { kind: 'notice', id: 'n1', variant: 'error', text: '模型响应超时，已重试' }
  ];
  return {
    sessionId: 'sess-1',
    sessionTitle: '支付网关 5xx',
    playbook: { id: 'pb.incident', stage: 'mitigating' },
    items,
    timeline: [
      { id: 'tl1', ts: NOW.getTime() - 60_000, kind: 'approval', briefId: 'brief-1', decision: 'approved' },
      { id: 'tl2', ts: NOW.getTime() - 30_000, kind: 'playbook_stage', from: 'investigating', stage: 'mitigating' }
    ],
    pendingBriefs: [
      { id: 'brief-2', risk: 'exec' as const, targetLabel: '重启 payment-gw', elements: {}, dualConfirmHint: true }
    ],
    now: NOW
  };
}

describe('buildOpsReportMarkdown', () => {
  it('渲染标题、对话、工具表、证据、审批（已决+未决）与阶段轨迹', () => {
    const md = buildOpsReportMarkdown(fullInput());

    expect(md).toContain('# 值班报告 · 支付网关 5xx');
    expect(md).toContain('- 会话：`sess-1`');
    expect(md).toContain('Playbook：`pb.incident`（阶段 mitigating）');

    // 对话时间线
    expect(md).toContain('支付网关 5xx 飙升，排查一下');
    expect(md).toContain('先看网关错误率与最近变更。');
    expect(md).toContain('> [error] 模型响应超时，已重试');

    // 工具调用表：状态与错误/预览
    expect(md).toContain('| `metrics.query` | at-metrics | 只读 | ok | error_rate=12% \\| window=5m |');
    expect(md).toContain('| `k8s.rollback` | at-k8s | 执行 | error | E_TIMEOUT: rollout status 超时 |');

    // 证据便签
    expect(md).toContain('**[confirmed]** 18:02 发布 v2.31 后错误率上升');

    // 审批：已决 + 未决
    expect(md).toContain('简报 `brief-1` · ✅ 已批准');
    expect(md).toContain('⏳ 未决 · 简报 `brief-2` · 执行 · 重启 payment-gw');

    // 阶段轨迹
    expect(md).toContain('investigating → mitigating');
  });

  it('空会话给出占位提示；报告不含令牌/密钥字样', () => {
    const md = buildOpsReportMarkdown({
      sessionId: 'sess-empty',
      items: [],
      timeline: [],
      now: NOW
    });
    expect(md).toContain('（本会话没有对话内容）');
    expect(md).toContain('（无工具调用）');
    expect(md).toContain('（本会话没有审批事件）');
    expect(md).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(md).not.toMatch(/Bearer\s/);
  });

  it('导出文件名带时间戳且不含冒号等非法字符', () => {
    const name = exportReportFileName(new Date(2026, 7, 28, 10, 5));
    expect(name).toBe('at-ops-report-20260828-1005.md');
    expect(name).not.toMatch(/[:*?"<>|]/);
  });

  it('工具 preview 含 Bearer 时输出 [REDACTED] 且不含 secret-token', () => {
    const md = buildOpsReportMarkdown({
      sessionId: 'sess-secret',
      items: [
        {
          kind: 'tool',
          id: 't-secret',
          call: {
            name: 'http.dump',
            pluginId: 'at.http',
            risk: 'read',
            status: 'ok',
            preview: 'Authorization: Bearer secret-token'
          }
        }
      ],
      timeline: [],
      now: NOW
    });
    expect(md).toContain('[REDACTED]');
    expect(md).not.toContain('secret-token');
    expect(redactSecrets('Authorization: Bearer secret-token').hits).toBeGreaterThanOrEqual(1);
  });

  it('审批段优先读 item.decision（patched），timeline 仅作双源兜底', () => {
    const md = buildOpsReportMarkdown({
      sessionId: 'sess-decision',
      items: [
        {
          kind: 'approval',
          id: 'ap1',
          briefId: 'brief-1',
          decision: 'rejected',
          ts: NOW.getTime()
        }
      ],
      timeline: [
        { id: 'tl1', ts: NOW.getTime() - 60_000, kind: 'approval', briefId: 'brief-1', decision: 'approved' }
      ],
      now: NOW
    });
    expect(md).toContain('简报 `brief-1` · ⛔ 已拒绝');
    expect(md).not.toContain('✅ 已批准');
  });
});
