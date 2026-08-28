/** 本地打开 html 调试看板时的 mock：先展示空态，再回放几条时间线事件。 */
import type { Envelope } from '../protocol/host-protocol';

function emit(type: string, payload: unknown): void {
  const envelope: Envelope = { v: 1, id: '', dir: 'evt', type, payload, ts: Date.now() };
  window.dispatchEvent(new MessageEvent('message', { data: envelope }));
}

export function installBoardMockHost(): void {
  (window as unknown as Record<string, unknown>).__opsMockPostMessage = (raw: unknown) => {
    console.info('[ops-board-mock] req', raw);
  };

  const now = Date.now();
  const samples = [
    {
      id: 'ev-1',
      ts: now - 12 * 60_000,
      severity: 'crit',
      title: 'api-gateway 5xx 比例 0.2% → 14%',
      incidentId: 'inc-20260828-01',
      kind: 'metric',
      status: 'investigating'
    },
    {
      id: 'ev-2',
      ts: now - 10 * 60_000,
      severity: 'warn',
      title: 'Jenkins #482 于 09:02 部署 api-gateway v2.14.1（疑似关联）',
      incidentId: 'inc-20260828-01',
      kind: 'pipeline',
      confidence: 'hypothesis',
      pipeline: { job: 'api-gateway', build: 482, result: 'success' }
    },
    {
      id: 'ev-2b',
      ts: now - 8 * 60_000,
      severity: 'info',
      title: '5xx 尖峰窄窗复核完成：0.2% → 14%（09:05 起）',
      incidentId: 'inc-20260828-01',
      kind: 'evidence',
      confidence: 'confirmed'
    },
    {
      id: 'ev-2c',
      ts: now - 6 * 60_000,
      severity: 'info',
      title: 'inv-host 已连接目标主机做只读取证',
      incidentId: 'inc-20260828-01',
      kind: 'host',
      host: { pluginId: 'at.jumpserver', label: 'prod-gw-01 (ssh)', connected: true }
    },
    {
      id: 'ev-3',
      ts: now - 2 * 60_000,
      severity: 'info',
      title: '回滚审批已提交，等待用户批准',
      incidentId: 'inc-20260828-01',
      kind: 'approval',
      confidence: 'pending',
      detail: 'kubectl -n prod rollout undo deploy/api-gateway'
    }
  ];

  // 延迟回放：先能看到空态「尚无事故」
  samples.forEach((sample, i) => {
    window.setTimeout(() => emit('timeline/upsert', sample), 900 + i * 700);
  });
}
