/**
 * Typed envelope between extension host and webviews / runtime.
 * Do not import vscode here.
 */

export interface Envelope<T = unknown> {
  v: 1;
  id: string;
  dir: 'req' | 'res' | 'evt';
  type: string;
  payload: T;
  ts: number;
}

export type Event<T> = (listener: (e: T) => unknown) => Disposable;

export interface Disposable {
  dispose(): void;
}

export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(e: T) => unknown>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export function envelope<T>(
  dir: Envelope['dir'],
  type: string,
  payload: T,
  id = ''
): Envelope<T> {
  return { v: 1, id, dir, type, payload, ts: Date.now() };
}

export type ChatPromptReq = {
  text: string;
  attachments?: Array<{ kind: 'file' | 'alert-paste'; uri?: string; text?: string }>;
  mode?: 'steer' | 'followUp';
};

export type ModelSetReq = {
  provider: string;
  model: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

export type PlaybookStartReq = { playbookId: string };
export type ApprovalRespondReq = { briefId: string; decision: 'approved' | 'rejected' };
export type SubagentAbortReq = { taskId: string };

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; steps: string[]; untrustedQuotes?: string[] }
  | { kind: 'tool'; id: string; call: ToolCallView }
  | { kind: 'subagents'; id: string; agents: SubagentCard[] }
  | { kind: 'evidence'; id: string; note: EvidenceNoteView }
  | { kind: 'approval'; id: string; briefId: string };

export type ToolCallView = {
  name: string;
  pluginId?: string;
  risk: 'read' | 'write' | 'exec';
  status: 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted';
  durationMs?: number;
  truncated?: boolean;
  preview?: string;
  artifactUri?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type SubagentCard = {
  taskId: string;
  role: 'investigator' | 'executor' | 'writer' | 'verifier';
  label: string;
  status: 'queued' | 'running' | 'ok' | 'degraded' | 'failed' | 'aborted';
  riskCeiling: 'read' | 'write' | 'exec';
  approvalBriefId?: string;
  toolCalls: { used: number; max: number };
  wallMs: { used: number; max: number };
  latest?: string;
};

export type EvidenceNoteView = {
  taskId: string;
  confidence: 'confirmed' | 'hypothesis' | 'pending';
  summary: string;
  refs: Array<{ kind: string; preview: string; artifactUri?: string }>;
};

export type ApprovalBriefView = {
  id: string;
  risk: 'write' | 'exec';
  targetLabel: string;
  elements: Record<string, string | unknown>;
  dualConfirmHint: boolean;
};

export type HydrateEvt = {
  sessionId: string;
  playbook?: { id: string; stage: string };
  items: TranscriptItem[];
  providers: unknown;
  pendingApproval?: ApprovalBriefView;
};

export type HostRequestType =
  | 'chat/prompt'
  | 'chat/abort'
  | 'model/set'
  | 'playbook/start'
  | 'approval/respond'
  | 'subagent/abort';

export type HostEventType =
  | 'hydrate'
  | 'transcript/append'
  | 'transcript/patch'
  | 'tool/start'
  | 'tool/update'
  | 'tool/end'
  | 'thinking/delta'
  | 'subagent/upsert'
  | 'timeline/upsert'
  | 'approval/request'
  | 'capabilities/snapshot'
  | 'playbook/stage';

export const OPS_ERROR = {
  SELECTION_FORBIDDEN: 'OPS_SELECTION_FORBIDDEN',
  RISK_CEILING: 'OPS_RISK_CEILING',
  APPROVAL_REQUIRED: 'OPS_APPROVAL_REQUIRED',
  APPROVAL_STALE: 'OPS_APPROVAL_STALE',
  PAYLOAD_CAP: 'OPS_PAYLOAD_CAP',
  PROVIDER_SKIPPED: 'OPS_PROVIDER_SKIPPED',
  DATABASE_OK_FALSE: 'OPS_DATABASE_OK_FALSE'
} as const;
