/**
 * Typed envelope between extension host and webviews / runtime.
 * Shared by packages/protocol. Do not import vscode here.
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

export type SessionSummary = { id: string; title: string; createdAt: number };
export type SessionSwitchReq = { id: string };
/** Only known atOpsAgent.* keys are accepted (host-side allowlist). */
export type SettingsPatchConfigReq = { key: string; value: unknown };
/** mcp/save: full mcp.json text; '***' placeholder values are restored from the existing file. */
export type McpSaveReq = { text: string };
export type SettingsOpenJsonReq = { kind: 'models' | 'mcp' | 'auth' | 'vscode' };

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; ts?: number }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; ts?: number }
  | { kind: 'thinking'; id: string; steps: string[]; untrustedQuotes?: string[]; ts?: number }
  | { kind: 'tool'; id: string; call: ToolCallView; ts?: number }
  | { kind: 'subagents'; id: string; agents: SubagentCard[]; ts?: number }
  | { kind: 'evidence'; id: string; note: EvidenceNoteView; ts?: number }
  | {
      kind: 'approval';
      id: string;
      briefId: string;
      decision?: 'approved' | 'rejected' | 'timeout' | 'pending';
      ts?: number;
    };

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
  playbooks?: unknown;
  /** Session list (history drawer / settings Sessions tab). */
  sessions?: SessionSummary[];
  models?: Array<{ provider: string; model: string; label: string }>;
  model?: string;
  modelProvider?: string;
  hasApiKey?: boolean;
};

/** settings/hydrate capabilities 载荷（与发现层 listProviders 同形；缺字段旧 UI 仍渲染）。 */
export type SettingsCapabilitiesView = {
  hostApp?: string;
  providers: Array<{
    pluginId: string;
    displayName: string;
    healthy: boolean;
    bridgeCount: number;
    toolNames: string[];
    toolCount?: number;
    liveToolCount?: number;
    connectedTargets?: number;
    tools?: Array<{ name: string; risk: 'read' | 'write' | 'exec'; live?: boolean }>;
  }>;
  catalogLiveToolCount?: number;
  hint?: string;
};

export type HostRequestType =
  | 'chat/prompt'
  | 'chat/abort'
  | 'model/set'
  | 'playbook/start'
  | 'approval/respond'
  | 'subagent/abort'
  | 'session/list'
  | 'session/switch'
  | 'session/new'
  | 'settings/hydrate'
  | 'settings/patchConfig'
  | 'mcp/get'
  | 'mcp/save'
  | 'settings/openJson'
  | 'history/toggle'
  | 'models/state'
  | 'models/save'
  | 'models/oauth'
  | 'models/openFile'
  | 'models/openAuth'
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
  | 'capabilities/snapshot'
  | 'playbook/stage'
  /** Titlebar History button → chat webview toggles the history drawer. */
  | 'history/toggle'
  /** Settings panel: host asks the webview to switch to a tab. */
  | 'settings/tab';
