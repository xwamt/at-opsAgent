/**
 * Plan 12 T6：内网 OTLP（默认关，无 SDK）。
 * - 空 endpoint → 零 fetch
 * - https://example.com → 拒绝（非内网）
 * - http://127.0.0.1:4318 mock 收到 1 条
 */
import { describe, expect, it, vi } from 'vitest';
import { DutyEventBus } from '../src/host/services/dutyEvents';
import {
  classifyOtlpEndpoint,
  createOtelExporter,
  isIntranetOtlpHostname
} from '../src/host/services/otel';

describe('otel endpoint policy', () => {
  it('空字符串为关', () => {
    expect(classifyOtlpEndpoint('')).toEqual({ action: 'off' });
    expect(classifyOtlpEndpoint('   ')).toEqual({ action: 'off' });
  });

  it('https://example.com 拒绝公网 SaaS', () => {
    const decision = classifyOtlpEndpoint('https://example.com');
    expect(decision.action).toBe('reject');
    if (decision.action === 'reject') {
      expect(decision.reason).toMatch(/example\.com|公网/);
    }
  });

  it('RFC1918 与 localhost 允许', () => {
    expect(isIntranetOtlpHostname('127.0.0.1')).toBe(true);
    expect(isIntranetOtlpHostname('localhost')).toBe(true);
    expect(isIntranetOtlpHostname('10.1.2.3')).toBe(true);
    expect(isIntranetOtlpHostname('192.168.0.8')).toBe(true);
    expect(isIntranetOtlpHostname('172.16.9.1')).toBe(true);
    expect(isIntranetOtlpHostname('8.8.8.8')).toBe(false);
    expect(isIntranetOtlpHostname('otel.grafana.net')).toBe(false);
    const loopback = classifyOtlpEndpoint('http://127.0.0.1:4318');
    expect(loopback.action).toBe('allow');
    if (loopback.action === 'allow') {
      expect(loopback.url).toContain('/v1/logs');
    }
  });
});

describe('OtelExporter', () => {
  it('空 endpoint → 零 fetch', async () => {
    const fetchImpl = vi.fn();
    const exporter = createOtelExporter({
      readConfig: () => ({ endpoint: '', protocol: 'http/protobuf' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {}
    });
    await exporter.export({
      type: 'tool_decision',
      sessionId: 's1',
      payload: { toolName: 'metrics.query', block: false }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('https://example.com 拒绝且零 fetch', async () => {
    const fetchImpl = vi.fn();
    const logs: string[] = [];
    const exporter = createOtelExporter({
      readConfig: () => ({ endpoint: 'https://example.com', protocol: 'http/protobuf' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (m) => logs.push(m)
    });
    await exporter.export({
      type: 'approval_request',
      sessionId: 's1',
      payload: { briefId: 'brief-1' }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('[otel]') && /example\.com|公网/.test(line))).toBe(
      true
    );
  });

  it('http://127.0.0.1:4318 mock 收到 1 条 log record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = createOtelExporter({
      readConfig: () => ({ endpoint: 'http://127.0.0.1:4318', protocol: 'http/protobuf' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {}
    });
    await exporter.export({
      type: 'playbook_stage',
      sessionId: 's1',
      ts: Date.parse('2026-08-29T12:00:00Z'),
      payload: { playbookId: 'pb.inspection', stage: 'closed' }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:4318/v1/logs');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body)) as {
      resourceLogs: Array<{
        scopeLogs: Array<{ logRecords: unknown[] }>;
      }>;
    };
    expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
  });

  it('export 类型不发送（审计专属）；六类之外零网络', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = createOtelExporter({
      readConfig: () => ({ endpoint: 'http://127.0.0.1:4318', protocol: 'http/protobuf' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {}
    });
    await exporter.export({
      type: 'export',
      sessionId: 's1',
      payload: { format: 'audit-jsonl' }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetch 失败只 log，不抛给调用方', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const logs: string[] = [];
    const exporter = createOtelExporter({
      readConfig: () => ({ endpoint: 'http://10.0.0.9:4318', protocol: 'http/protobuf' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (m) => logs.push(m)
    });
    await expect(
      exporter.export({
        type: 'token_usage',
        sessionId: 's1',
        payload: { inputTokens: 3, outputTokens: 1 }
      })
    ).resolves.toBeUndefined();
    expect(logs.some((line) => line.includes('ECONNREFUSED'))).toBe(true);
  });

  it('duty bus 订阅后一条 tool_decision 只 POST 一次', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = createOtelExporter({
      readConfig: () => ({ endpoint: 'http://127.0.0.1:4318', protocol: 'http/protobuf' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {}
    });
    const bus = new DutyEventBus();
    const done = new Promise<void>((resolve, reject) => {
      bus.subscribe((event) => {
        void exporter.export(event).then(resolve, reject);
      });
    });
    bus.emit({
      type: 'tool_decision',
      sessionId: 's1',
      payload: {
        toolName: 'ops_dispatch_subagent',
        block: false,
        subagent: { taskId: 't1', status: 'running', event: 'spawn', role: 'investigator' }
      }
    });
    await done;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
