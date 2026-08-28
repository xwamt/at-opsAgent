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
  attachments?: Array<{
    kind: 'file' | 'alert-paste' | 'log' | 'terminal' | 'evidence';
    uri?: string;
    text?: string;
    label?: string;
  }>;
  mode?: 'steer' | 'followUp';
  /** 失败消息「重试」时带上被重发的 assistant item id。 */
  retryOf?: string;
};

export type ChatAbortReq = { mode?: 'cancel' | 'stop' };

export type ModelsTestReq = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  provider?: string;
};

export type ModelsTestRes = {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  httpStatus?: number;
};

export type ModelsFetchReq = { baseUrl: string; apiKey?: string; provider?: string };
export type ModelsFetchRes = { ok: boolean; models?: string[]; error?: string };

export type AssetPickReq = { query?: string };
export type AssetPickRes = {
  items: Array<{ kind: 'log' | 'terminal' | 'evidence' | 'file'; label: string; text: string; uri?: string }>;
};

export type UsageView = {
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number;
  contextWindow?: number;
  costUsd?: number;
};

export type NoticeAction = { id: string; label: string; command?: string; request?: string };

export type ModelSetReq = {
  provider: string;
  model: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

export type PlaybookStartReq = { playbookId: string };
export type ApprovalRespondReq = { briefId: string; decision: 'approved' | 'rejected' };
export type SubagentAbortReq = { taskId: string };

export type SessionSummary = { id: string; title: string; createdAt: number };
export type SessionSwitchReq = { id: string };
/** 只允许 atOpsAgent.* 已知键（host 侧白名单校验）。 */
export type SettingsPatchConfigReq = { key: string; value: unknown };
/** mcp/save：完整 mcp.json 文本；'***' 占位值由 host 从现有文件回填。 */
export type McpSaveReq = { text: string };
export type SettingsOpenJsonReq = { kind: 'models' | 'mcp' | 'auth' | 'vscode' };

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; error?: boolean; retryable?: boolean }
  | { kind: 'thinking'; id: string; steps: string[]; untrustedQuotes?: string[] }
  | { kind: 'tool'; id: string; call: ToolCallView }
  | { kind: 'subagents'; id: string; agents: SubagentCard[] }
  | { kind: 'evidence'; id: string; note: EvidenceNoteView }
  | { kind: 'approval'; id: string; briefId: string }
  | {
      kind: 'notice';
      id: string;
      variant: 'error' | 'info' | 'success';
      text: string;
      actions?: NoticeAction[];
    }
  | { kind: 'system'; id: string; text: string };

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
  /** 派单目标（一句话），卡片主标题用。 */
  goal?: string;
  /** 可见工具名（子会话实际注入的业务工具）。 */
  visibleTools?: string[];
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
  /** playbook 元数据列表（已缓存时随快照下发；缺省 webview 用兜底清单）。 */
  playbooks?: unknown;
  /** 会话列表（历史抽屉 / 设置页 Sessions 页签消费）。 */
  sessions?: SessionSummary[];
  /** models.json 解析出的聊天模型清单（不含凭证）。缺省 = 未配置。 */
  models?: Array<{ provider: string; model: string; label: string }>;
  /** 当前选中的模型 id。 */
  model?: string;
  modelProvider?: string;
  hasApiKey?: boolean;
  /** vscode.env.language，webview i18n 用。 */
  locale?: string;
  usage?: UsageView;
  onboarded?: boolean;
};

export type HostRequestType =
  | 'chat/prompt'
  | 'chat/abort'
  | 'chat/retry'
  | 'chat/export'
  | 'hydrate'
  | 'model/set'
  | 'playbook/start'
  | 'playbook/advance'
  | 'playbook/close'
  | 'approval/respond'
  | 'subagent/abort'
  | 'session/list'
  | 'session/switch'
  | 'session/new'
  | 'settings/hydrate'
  | 'settings/patchConfig'
  | 'settings/open'
  | 'mcp/get'
  | 'mcp/save'
  | 'settings/openJson'
  | 'history/toggle'
  | 'models/state'
  | 'models/save'
  | 'models/test'
  | 'models/fetch'
  | 'models/oauth'
  | 'models/openFile'
  | 'models/openAuth'
  | 'asset/pick'
  | 'capabilities/refresh'
  | 'diagnose'
  | 'skill/open';

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
  | 'approval/resolve'
  | 'capabilities/snapshot'
  | 'playbook/stage'
  | 'usage'
  | 'compaction'
  | 'turn/end'
  /** 标题栏 History 按钮 → chat webview 开关历史抽屉。 */
  | 'history/toggle'
  /** 设置面板：host 要求切换到指定页签。 */
  | 'settings/tab';

export const OPS_ERROR = {
  SELECTION_FORBIDDEN: 'OPS_SELECTION_FORBIDDEN',
  RISK_CEILING: 'OPS_RISK_CEILING',
  APPROVAL_REQUIRED: 'OPS_APPROVAL_REQUIRED',
  APPROVAL_STALE: 'OPS_APPROVAL_STALE',
  PAYLOAD_CAP: 'OPS_PAYLOAD_CAP',
  PROVIDER_SKIPPED: 'OPS_PROVIDER_SKIPPED',
  DATABASE_OK_FALSE: 'OPS_DATABASE_OK_FALSE'
} as const;
