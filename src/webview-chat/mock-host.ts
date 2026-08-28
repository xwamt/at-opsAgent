/**
 * 本地打开 html 调试时的 mock host：没有 acquireVsCodeApi 时启用。
 * 用假数据回放 hydrate / 流式 / 工具 / 子代理 / 审批事件，postMessage 打回环。
 */
import type { Envelope, TranscriptItem } from '../protocol/host-protocol';

function emit(type: string, payload: unknown): void {
  const envelope: Envelope = { v: 1, id: '', dir: 'evt', type, payload, ts: Date.now() };
  window.dispatchEvent(new MessageEvent('message', { data: envelope }));
}

const HYDRATE_ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: '线上网关 5xx 突增，帮我查' },
  {
    kind: 'thinking',
    id: 'th1',
    steps: ['确认症状与时间窗：09:05 起 5xx 比例 0.2%→14%', '优先 grafana 窄窗验证，再放大面', '并行派发 metrics / logs / changes 调查'],
    untrustedQuotes: ['upstream timed out (110: Connection timed out) while reading response header']
  },
  {
    kind: 'tool',
    id: 't1',
    call: {
      name: 'ops_select_tools',
      pluginId: 'at.grafana',
      risk: 'read',
      status: 'ok',
      durationMs: 12,
      preview: '{ "selected": ["at.grafana"], "exposed": 9 }'
    }
  },
  {
    kind: 'tool',
    id: 't2',
    call: {
      name: 'grafana_query_range',
      pluginId: 'at.grafana',
      risk: 'read',
      status: 'ok',
      durationMs: 843,
      truncated: true,
      preview:
        'sum(rate(http_requests_total{job="api-gateway",code=~"5.."}[1m]))\n09:00 0.002  09:03 0.004  09:05 0.031  09:07 0.090  09:09 0.140\n… (raw series 128KB)',
      artifactUri: 'artifact://sess-demo/t2.json'
    }
  },
  {
    kind: 'subagents',
    id: 'sa-board',
    agents: [
      {
        taskId: 'inv-metrics',
        role: 'investigator',
        label: 'metrics',
        status: 'running',
        riskCeiling: 'read',
        toolCalls: { used: 5, max: 12 },
        wallMs: { used: 42_000, max: 180_000 },
        latest: 'PromQL 窄窗基线 vs 峰值比对中'
      },
      {
        taskId: 'inv-logs',
        role: 'investigator',
        label: 'logs',
        status: 'running',
        riskCeiling: 'read',
        toolCalls: { used: 2, max: 12 },
        wallMs: { used: 31_000, max: 180_000 },
        latest: 'Loki: {app="api-gateway"} |= "timeout" limit 100'
      },
      {
        taskId: 'inv-changes',
        role: 'investigator',
        label: 'changes',
        status: 'ok',
        riskCeiling: 'read',
        toolCalls: { used: 4, max: 12 },
        wallMs: { used: 55_000, max: 180_000 },
        latest: 'Jenkins #482 于 09:02 部署 api-gateway v2.14.1'
      }
    ]
  },
  {
    kind: 'evidence',
    id: 'ev1',
    note: {
      taskId: 'inv-metrics',
      confidence: 'confirmed',
      summary: '09:05 起 api-gateway 5xx 比例 0.2%→14%，与 upstream P99 同步抬升',
      refs: [
        {
          kind: 'metric',
          preview: '5xx ratio 0.002 0.003 0.002 0.004 0.031 0.090 0.140 0.135 0.128',
          artifactUri: 'artifact://sess-demo/ev1-metric.json'
        }
      ]
    }
  },
  {
    kind: 'evidence',
    id: 'ev2',
    note: {
      taskId: 'inv-changes',
      confidence: 'hypothesis',
      summary: '疑似 09:02 Jenkins #482 发布 v2.14.1 引入；尚未取到发布前后 diff 日志',
      refs: [
        { kind: 'pipeline', preview: 'Jenkins api-gateway #482 SUCCESS 09:02:14' },
        { kind: 'log', preview: 'upstream timed out (110) while reading response header from upstream' }
      ]
    }
  },
  {
    kind: 'evidence',
    id: 'ev3',
    note: {
      taskId: 'inv-logs',
      confidence: 'pending',
      summary: '业务日志尚未返回，等待 inv-logs 结果后才能给结论',
      refs: []
    }
  },
  {
    kind: 'assistant',
    id: 'a1',
    text: '初步归纳：5xx 突增（confirmed）与 09:02 的发布时间吻合（hypothesis）。业务日志未回来前不下根因结论。建议回滚 api-gateway 至 v2.14.0，已生成审批简报。'
  },
  { kind: 'approval', id: 'ap1', briefId: 'brief-demo-1' }
];

function demoBrief() {
  return {
    id: 'brief-demo-1',
    risk: 'exec' as const,
    targetLabel: '回滚 api-gateway → v2.14.0（prod）',
    dualConfirmHint: true,
    elements: {
      goal: '恢复网关可用性，将 5xx 比例降回 <1%',
      evidence: '5xx 0.2%→14%（confirmed）；09:02 发布 v2.14.1（hypothesis）',
      impact: 'prod api-gateway 3 实例滚动回滚，预计抖动 <30s',
      prechecks: '确认 v2.14.0 镜像存在；当前无进行中发布',
      backup: '保留 v2.14.1 镜像与当前配置快照',
      commands: [
        { tool: 'at.terminal/run_remote_command', command: 'kubectl -n prod rollout undo deploy/api-gateway' }
      ],
      successCriteria: '10 分钟内 5xx <1%，P99 恢复基线',
      rollback: '重新 rollout 至 v2.14.1',
      unknowns: '业务日志未确认根因，回滚属止血操作'
    }
  };
}

export function installMockHost(): void {
  (window as unknown as Record<string, unknown>).__opsMockPostMessage = (raw: unknown) => {
    const msg = raw as Partial<Envelope>;
    console.info('[ops-mock-host] req', msg.type, msg.payload);
    if (msg.type === 'chat/prompt') {
      const payload = (msg.payload ?? {}) as { text?: string };
      const stamp = Date.now().toString(36);
      emit('transcript/append', { kind: 'user', id: `u-${stamp}`, text: payload.text ?? '' });
      const assistantId = `a-${stamp}`;
      emit('transcript/append', { kind: 'assistant', id: assistantId, text: '', streaming: true });
      const chunks = ['收到。', '按 pb.incident 纪律：', '先窄窗确认尖刺，再查业务日志。'];
      chunks.forEach((chunk, i) => {
        window.setTimeout(() => {
          emit('transcript/patch', { itemId: assistantId, patch: { appendText: chunk } });
          if (i === chunks.length - 1) {
            emit('transcript/patch', { itemId: assistantId, patch: { streaming: false } });
          }
        }, 350 * (i + 1));
      });
    } else if (msg.type === 'subagent/abort') {
      const payload = (msg.payload ?? {}) as { taskId?: string };
      emit('subagent/upsert', { taskId: payload.taskId, status: 'aborted', latest: '用户中止' });
    } else if (msg.type === 'approval/respond') {
      const payload = (msg.payload ?? {}) as { decision?: string };
      emit('transcript/append', {
        kind: 'assistant',
        id: `a-appr-${Date.now().toString(36)}`,
        text: payload.decision === 'approved' ? '已批准，Executor 开始执行（插件可能再次确认）。' : '已拒绝，转出方案报告。'
      });
      if (payload.decision === 'approved') {
        emit('playbook/stage', { id: 'pb.incident', stage: 'Executing' });
        emit('subagent/upsert', {
          taskId: 'exec-rollback',
          role: 'executor',
          label: 'rollback',
          status: 'running',
          riskCeiling: 'exec',
          approvalBriefId: 'brief-demo-1',
          toolCalls: { used: 0, max: 4 },
          wallMs: { used: 0, max: 300_000 },
          latest: 'kubectl rollout undo…'
        });
      }
    }
  };

  window.setTimeout(() => {
    emit('hydrate', {
      sessionId: 'sess-demo',
      playbook: { id: 'pb.incident', stage: 'Investigating' },
      items: HYDRATE_ITEMS,
      providers: {
        providers: [
          { id: 'at.grafana', label: 'AT Grafana', connected: true },
          { id: 'at.terminal', label: 'AT Terminal', connected: true },
          { id: 'at.jenkins', label: 'AT Jenkins', connected: false }
        ],
        model: 'qwen3-max'
      },
      pendingApproval: demoBrief()
    });
  }, 60);
}
