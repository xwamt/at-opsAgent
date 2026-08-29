/**
 * 内网 OTLP（Plan 12 T6）：默认关，无 SDK。
 * 最小 OTLP HTTP JSON POST（logs）；失败只 log。
 *
 * 仅允许 http(s) 且 hostname 为 RFC1918 / localhost；拒绝公网 SaaS。
 * 零 vscode——endpoint 由 host 注入。runtime/orchestrator/policy 不得 import。
 *
 * 恰好六类：tool_decision / approval_request / approval_decision /
 * policy_block / playbook_stage / token_usage。
 * subagent spawn/终态作为 tool_decision 的属性，不是第七类。
 */
import { isOtelEventType, type DutyEvent } from './dutyEvents';

export interface OtelConfig {
  endpoint: string;
  protocol: string;
}

export type OtelEndpointDecision =
  | { action: 'off' }
  | { action: 'reject'; reason: string }
  | { action: 'allow'; url: string };

export interface OtelExporterDeps {
  readConfig: () => OtelConfig;
  log: (message: string) => void;
  fetchImpl?: typeof fetch;
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

function ipv4Octets(hostname: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  if (octets.some((n) => n > 255)) return undefined;
  return octets;
}

/** RFC1918 或 localhost / 127.0.0.0/8。公网域名与公网 IP 一律 false。 */
export function isIntranetOtlpHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTS.has(host)) return true;
  const ip = ipv4Octets(host);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 空 endpoint = 关（零网络）。非 http(s)、hostname 非内网 = 拒绝（仍零网络）。
 * 无 path 时补 /v1/logs。
 */
export function classifyOtlpEndpoint(endpoint: string): OtelEndpointDecision {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) return { action: 'off' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { action: 'reject', reason: '不是合法 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'reject', reason: '只允许 http(s)' };
  }
  if (!isIntranetOtlpHostname(url.hostname)) {
    return { action: 'reject', reason: `拒绝公网 collector：${url.hostname}` };
  }
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/v1/logs';
  }
  return { action: 'allow', url: url.toString() };
}

function attribute(key: string, value: unknown): { key: string; value: Record<string, unknown> } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === 'boolean') {
    return { key, value: { boolValue: value } };
  }
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return { key, value: { stringValue: text } };
}

export function buildOtlpLogsBody(event: DutyEvent): unknown {
  const ts = event.ts ?? Date.now();
  const timeUnixNano = `${BigInt(ts) * 1_000_000n}`;
  const attrs = [
    attribute('event.type', event.type),
    attribute('session.id', event.sessionId)
  ];
  for (const [key, value] of Object.entries(event.payload)) {
    if (value === undefined) continue;
    attrs.push(attribute(key, value));
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attribute('service.name', 'at-ops-agent')]
        },
        scopeLogs: [
          {
            scope: { name: 'at-ops-agent.duty' },
            logRecords: [
              {
                timeUnixNano,
                severityText: 'INFO',
                body: { stringValue: event.type },
                attributes: attrs
              }
            ]
          }
        ]
      }
    ]
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class OtelExporter {
  constructor(private readonly deps: OtelExporterDeps) {}

  async export(event: DutyEvent): Promise<void> {
    if (!isOtelEventType(event.type)) return;
    let config: OtelConfig;
    try {
      config = this.deps.readConfig();
    } catch (err) {
      this.deps.log(`[otel] 读配置失败: ${describeError(err)}`);
      return;
    }
    const decision = classifyOtlpEndpoint(config.endpoint ?? '');
    if (decision.action === 'off') return;
    if (decision.action === 'reject') {
      this.deps.log(`[otel] ${decision.reason}`);
      return;
    }
    const protocol = (config.protocol ?? 'http/protobuf').trim() || 'http/protobuf';
    if (protocol !== 'http/protobuf') {
      this.deps.log(`[otel] 仅支持 http/protobuf，忽略 ${protocol}（仍以 HTTP JSON 发送）`);
    }
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      this.deps.log('[otel] 当前运行时没有 fetch，跳过');
      return;
    }
    try {
      const res = await fetchImpl(decision.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildOtlpLogsBody(event)),
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) {
        this.deps.log(`[otel] collector 返回 ${res.status}`);
      }
    } catch (err) {
      this.deps.log(`[otel] 发送失败: ${describeError(err)}`);
    }
  }
}

export function createOtelExporter(deps: OtelExporterDeps): OtelExporter {
  return new OtelExporter(deps);
}
