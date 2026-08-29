/**
 * 值班结构化事件总线（Plan 12 T4/T6）：
 * 审批 / 策略闸 / playbook 阶段 / 用量 等现有调用点只 emit 一次，
 * 审计 JSONL 与内网 OTLP 各自订阅，避免每个 call site 双写。
 *
 * 失败不得挡住主会话：handler 抛错 / 返回 rejected promise 只 log。
 * 本模块零 vscode（runtime/orchestrator/policy 亦不得 import 本文件）。
 */

export const AUDIT_EVENT_TYPES = [
  'tool_decision',
  'approval_request',
  'approval_decision',
  'policy_block',
  'playbook_stage',
  'export'
] as const;

export const OTEL_EVENT_TYPES = [
  'tool_decision',
  'approval_request',
  'approval_decision',
  'policy_block',
  'playbook_stage',
  'token_usage'
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type OtelEventType = (typeof OTEL_EVENT_TYPES)[number];
export type DutyEventType = AuditEventType | OtelEventType;

export interface DutyEvent {
  type: DutyEventType;
  sessionId: string;
  payload: Record<string, unknown>;
  ts?: number;
}

export type DutyEventHandler = (event: DutyEvent) => void | Promise<void>;

const AUDIT_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
const OTEL_TYPE_SET: ReadonlySet<string> = new Set(OTEL_EVENT_TYPES);

export function isAuditEventType(type: string): type is AuditEventType {
  return AUDIT_TYPE_SET.has(type);
}

export function isOtelEventType(type: string): type is OtelEventType {
  return OTEL_TYPE_SET.has(type);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 同步 fan-out。订阅方自己做 IO；本总线不 await 落盘 / 网络，
 * 只把 thenable 的 rejection 接到 log，避免未处理 rejection。
 */
export class DutyEventBus {
  private readonly handlers: DutyEventHandler[] = [];

  constructor(private readonly log: (message: string) => void = () => {}) {}

  subscribe(handler: DutyEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  emit(event: DutyEvent): void {
    const stamped: DutyEvent = {
      ...event,
      ts: event.ts ?? Date.now(),
      payload: event.payload ?? {}
    };
    for (const handler of this.handlers) {
      try {
        const result = handler(stamped);
        if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch((err) =>
            this.log(`[duty] handler 失败: ${describeError(err)}`)
          );
        }
      } catch (err) {
        this.log(`[duty] handler 失败: ${describeError(err)}`);
      }
    }
  }
}
