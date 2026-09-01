/**
 * chat store 的纯 TS 逻辑（无 Vue/DOM/pinia 依赖）：
 * prompt 上行 payload 组装与「事件脉络」时间线条目归一化。
 * 单独成文件是为了能在 node 环境直接单测（docs/09 §8 组件测降级路径）。
 */
import type {
  ChatPromptReq,
  SubagentCard,
  SubagentTranscriptItem,
  ToolCallView,
  TranscriptItem,
  UsageView
} from '../protocol/host-protocol';
import { normalizeConfidence, type ConfidenceLevel } from './confidence';

export type PromptAttachment = NonNullable<ChatPromptReq['attachments']>[number];

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : {};
}

/**
 * 追问判定：未在流式中，且最近一条 user/assistant 消息是「已完成的 assistant 回复」
 * ——即刚结束一轮对话。此时上行 mode: 'followUp'（host 当新 prompt 处理也 OK）。
 */
export function canFollowUpFrom(items: readonly TranscriptItem[], streaming: boolean): boolean {
  if (streaming) {
    return false;
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'assistant') {
      return item.streaming !== true;
    }
    if (item.kind === 'user') {
      return false;
    }
  }
  return false;
}

/** chat/prompt payload：流式中 ⇒ steer；刚结束一轮 ⇒ followUp；空文本 ⇒ null（不发）。 */
export function buildPromptPayload(
  text: string,
  state: { streaming: boolean; canFollowUp: boolean },
  attachments?: readonly PromptAttachment[]
): ChatPromptReq | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const payload: ChatPromptReq = { text: trimmed };
  if (attachments && attachments.length > 0) {
    payload.attachments = [...attachments];
  }
  if (state.streaming) {
    payload.mode = 'steer';
  } else if (state.canFollowUp) {
    payload.mode = 'followUp';
  }
  return payload;
}

/**
 * 思维链默折叠、用户可展开；untrustedQuotes 在 UI 中始终可见（折叠态也渲染警示块）。
 * 从 thinking 项提取非空外部引用原文；思考步骤正文由 ThinkingBlock 折叠区控制可见性。
 * 返回空数组 ⇒ 该 thinking 项没有引用块可渲染。
 */
export function visibleUntrustedQuotes(
  item: TranscriptItem | SubagentTranscriptItem | { kind: string; untrustedQuotes?: string[] }
): string[] {
  if (item.kind !== 'thinking' || !('untrustedQuotes' in item) || !Array.isArray(item.untrustedQuotes)) {
    return [];
  }
  return item.untrustedQuotes.filter((quote) => typeof quote === 'string' && quote !== '');
}

/** 结论模式（Focus）只留 assistant + evidence + notice，隐藏 tool/thinking 等。 */
export function isConclusionItem(item: TranscriptItem): boolean {
  return item.kind === 'assistant' || item.kind === 'evidence' || item.kind === 'notice';
}

export function filterTranscriptForView(
  items: readonly TranscriptItem[],
  opts: { conclusionMode: boolean }
): readonly TranscriptItem[] {
  if (!opts.conclusionMode) {
    return items;
  }
  return items.filter(isConclusionItem);
}

/**
 * 思考块是否渲染：配置 ui.showThinking 默认 true；
 * 结论模式（Focus）强制 false。CoT 正文默认折叠，用户可点击展开。
 */
export function thinkingMetaVisible(showThinking: boolean, conclusionMode: boolean): boolean {
  return showThinking === true && conclusionMode !== true;
}

/** 思考进行中 live badge：`3200` → `3.2s`（与 ThinkingBlock 折叠头 timer 一致）。 */
export function formatThinkingLiveLabel(elapsedMs: number): string {
  const sec = (elapsedMs / 1000).toFixed(1);
  return `${sec}s`;
}

/** durationMs → `850ms` / `1.2s`；非法或缺省返回 null（UI 走「思考中」）。 */
export function formatThinkingDurationMs(durationMs: number | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  const seconds = durationMs / 1000;
  const rounded = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
  return `${rounded}s`;
}

export interface ChatTimelineEvent {
  id: string;
  ts: number;
  title: string;
  severity: 'info' | 'warn' | 'crit';
}

export interface TimelineStripEntry {
  id: string;
  label: string;
  tone: ConfidenceLevel | 'info' | 'warn' | 'crit';
  pinned?: boolean;
}

function toSeverity(value: unknown): ChatTimelineEvent['severity'] {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'crit' || raw === 'critical' || raw === 'error' || raw === 'fatal') {
    return 'crit';
  }
  if (raw === 'warn' || raw === 'warning' || raw === 'degraded') {
    return 'warn';
  }
  return 'info';
}

/** timeline/upsert payload（或 hydrate.timeline 条目）→ 最小归一化；无 id 丢弃。 */
export function normalizeTimelineEvent(payload: unknown): ChatTimelineEvent | null {
  const outer = asRecord(payload);
  const rec = outer.event ? asRecord(outer.event) : outer;
  const id = rec.id ?? rec.eventId;
  if (id === undefined || id === null || id === '') {
    return null;
  }
  return {
    id: String(id),
    ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : Date.now(),
    title: String(rec.title ?? rec.summary ?? rec.text ?? '（无标题）'),
    severity: toSeverity(rec.severity ?? rec.level)
  };
}

// ── 历史会话 / 欢迎页（Cline 式 History 侧滑 + 空态建议卡）─────────────────

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
}

/** hydrate.sessions → 归一化：无 id 丢弃；title 缺省回退 id 前缀；createdAt 缺省 0。 */
export function normalizeSessions(raw: unknown): SessionMeta[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const id = rec.id ?? rec.sessionId;
    if (id === undefined || id === null || id === '') {
      continue;
    }
    out.push({
      id: String(id),
      title: String(rec.title ?? rec.label ?? String(id).slice(0, 12)),
      createdAt:
        typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : 0
    });
  }
  return out;
}

/**
 * 历史侧滑列表：新→旧排序；host 尚未下发 sessions 时退化为
 * 「仅当前会话」一条（session/switch 未接线也能展示当前上下文）。
 */
export function buildHistoryList(
  sessions: readonly SessionMeta[],
  currentSessionId: string,
  fallbackTitle = ''
): SessionMeta[] {
  if (sessions.length > 0) {
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  }
  if (currentSessionId) {
    return [
      {
        id: currentSessionId,
        title: fallbackTitle || currentSessionId.slice(0, 12),
        createdAt: 0
      }
    ];
  }
  return [];
}

/** 欢迎页建议卡：取前 cap 条 playbook；cap 收敛到 4–8（Cline 空态卡片量级）。 */
export function buildWelcomeSuggestions<T>(playbooks: readonly T[], cap = 6): T[] {
  return playbooks.slice(0, Math.min(8, Math.max(4, cap)));
}

export interface ChatModelOption {
  provider: string;
  model: string;
  label: string;
}

/** hydrate / capabilities 的 models[]：空数组表示「未配置」，不是解析失败。 */
export function normalizeChatModels(raw: unknown): ChatModelOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatModelOption[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const model = String(rec.model ?? rec.id ?? '').trim();
    if (model.length === 0) continue;
    const provider = String(rec.provider ?? 'custom').trim() || 'custom';
    const label = String(rec.label ?? rec.name ?? model).trim() || model;
    out.push({ provider, model, label });
  }
  return out;
}

export interface ChatModelState {
  modelOptions: ChatModelOption[];
  modelLabel: string;
  modelProvider: string;
}

/** 从 capabilities / providers 记录吸收模型字段；models 是数组（含空）就整体覆盖。 */
export function absorbChatModelFields(state: ChatModelState, rec: Record<string, unknown>): ChatModelState {
  const next: ChatModelState = { ...state, modelOptions: [...state.modelOptions] };
  if (typeof rec.model === 'string') next.modelLabel = rec.model;
  if (typeof rec.modelProvider === 'string') next.modelProvider = rec.modelProvider;
  if (Array.isArray(rec.models)) next.modelOptions = normalizeChatModels(rec.models);
  return next;
}

/**
 * hydrate 吸收顺序：先 providers 快照（旧 host 兼容），再顶层
 * models/model/modelProvider（新 host 字段胜出）。
 */
export function absorbHydrateModels(
  state: ChatModelState,
  snapshot: {
    providers?: unknown;
    models?: unknown;
    model?: unknown;
    modelProvider?: unknown;
  }
): ChatModelState {
  const fromProviders = absorbChatModelFields(state, asRecord(snapshot.providers));
  return absorbChatModelFields(fromProviders, {
    models: snapshot.models,
    model: snapshot.model,
    modelProvider: snapshot.modelProvider
  });
}

// ── transcript 渲染列表：连续只读工具聚合（Cline groupLowStakesTools 同构）──

export type ToolTranscriptItem = Extract<TranscriptItem, { kind: 'tool' }>;

export type TranscriptRenderEntry =
  | { kind: 'item'; id: string; item: TranscriptItem }
  | { kind: 'toolGroup'; id: string; items: ToolTranscriptItem[] };

/** 可聚合：只读工具且已结束、非失败（error/running 保持单卡可见）。 */
function groupableReadTool(item: TranscriptItem): item is ToolTranscriptItem {
  return (
    item.kind === 'tool' &&
    item.call.risk === 'read' &&
    item.call.status !== 'error' &&
    item.call.status !== 'running'
  );
}

/**
 * transcript → 渲染条目：连续 ≥minGroup 个可聚合只读工具折叠成一个组
 * （组 id 取首条工具的 id，保证虚拟化 key 稳定）；其余项原样透传。
 */
export function buildRenderList(
  items: readonly TranscriptItem[],
  minGroup = 3
): TranscriptRenderEntry[] {
  const out: TranscriptRenderEntry[] = [];
  let run: ToolTranscriptItem[] = [];

  const flush = (): void => {
    if (run.length >= minGroup) {
      out.push({ kind: 'toolGroup', id: `toolgroup-${run[0].id}`, items: run });
    } else {
      for (const item of run) {
        out.push({ kind: 'item', id: item.id, item });
      }
    }
    run = [];
  };

  for (const item of items) {
    if (groupableReadTool(item)) {
      run.push(item);
      continue;
    }
    flush();
    out.push({ kind: 'item', id: item.id, item });
  }
  flush();
  return out;
}

// ── 工具卡标题 / 空 assistant 渲染（docs/14 P1-ui）────────────────────────

/** 命令首词 → 中文意图（巡检常见命令族；工具名 list_ssh_servers 也走此表）。 */
const COMMAND_INTENT_ZH: Record<string, string> = {
  df: '磁盘',
  free: '内存',
  uptime: '负载',
  w: '负载',
  top: '负载',
  ps: '进程',
  systemctl: '服务',
  docker: '容器',
  journalctl: '日志',
  hostname: '主机',
  list_ssh_servers: 'SSH 目标'
};

export function unwrapHubPayload(raw: unknown): {
  payload: unknown;
  envelopeOk?: boolean;
  attemptCount?: number;
  envelopeDurationMs?: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { payload: raw };
  }
  const rec = asRecord(raw);
  if (typeof rec.ok === 'boolean' && 'result' in rec) {
    return {
      payload: rec.result,
      envelopeOk: rec.ok,
      attemptCount: typeof rec.attemptCount === 'number' ? rec.attemptCount : undefined,
      envelopeDurationMs: typeof rec.durationMs === 'number' ? rec.durationMs : undefined
    };
  }
  return { payload: raw };
}

const PURPOSE_LINE = /^\s*#\s*Purpose\s*[:：]\s*(.+?)\s*$/i;

export function parseCommandPurpose(command: string): { purpose?: string; body: string } {
  const lines = command.split('\n');
  let purpose: string | undefined;
  const body: string[] = [];
  for (const line of lines) {
    const m = line.match(PURPOSE_LINE);
    if (m) {
      if (!purpose) purpose = m[1].trim();
      continue;
    }
    body.push(line);
  }
  return { purpose, body: body.join('\n').trim() };
}

function pickStr(rec: AnyRecord, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function pickNum(rec: AnyRecord, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function fieldsFromPayload(payload: unknown): Partial<ParsedToolPreview> {
  if (typeof payload === 'string') {
    return { stdout: payload };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const rec = asRecord(payload);
  const command = pickStr(rec, ['command', 'script', 'query', 'cmd']);
  const stdout =
    typeof rec.stdout === 'string'
      ? rec.stdout
      : typeof rec.output === 'string'
        ? rec.output
        : typeof rec.result === 'string'
          ? rec.result
          : undefined;
  const stderr = typeof rec.stderr === 'string' ? rec.stderr : undefined;
  return {
    command,
    hostLabel: pickStr(rec, ['serverLabel', 'serverName', 'label', 'server']),
    hostAddr: pickStr(rec, ['host', 'ip', 'target']),
    exitCode: pickNum(rec, ['exitCode', 'code']),
    stdout,
    stderr
  };
}

function parseJsonBlob(raw: string): unknown | undefined {
  const t = raw.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export interface ParsedToolPreview {
  command?: string;
  commandBody?: string;
  purpose?: string;
  hostLabel?: string;
  hostAddr?: string;
  /** @deprecated 等于 hostLabel，兼容旧调用 */
  serverName?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  rawText: string;
  payload?: unknown;
  envelopeOk?: boolean;
  attemptCount?: number;
}

export function parseToolOutputPreview(
  preview: string | undefined | null,
  inputPreview?: string | undefined | null
): ParsedToolPreview {
  const raw = String(preview ?? '').trim();
  const inputRaw = String(inputPreview ?? '').trim();
  const outJson = parseJsonBlob(raw);
  const inJson = parseJsonBlob(inputRaw);

  const outUnwrapped = outJson !== undefined ? unwrapHubPayload(outJson) : undefined;
  const inUnwrapped = inJson !== undefined ? unwrapHubPayload(inJson) : undefined;

  const fromInput = inUnwrapped ? fieldsFromPayload(inUnwrapped.payload) : {};
  const fromOutput = outUnwrapped ? fieldsFromPayload(outUnwrapped.payload) : {};

  const streamingStdout = outJson === undefined && raw ? raw : undefined;

  const command = fromOutput.command ?? fromInput.command;
  const purposeSource = [fromInput.command, fromOutput.command]
    .filter((s): s is string => Boolean(s))
    .join('\n');
  const parsedPurpose = purposeSource ? parseCommandPurpose(purposeSource) : undefined;
  const hostLabel = fromOutput.hostLabel ?? fromInput.hostLabel;
  const hostAddr = fromOutput.hostAddr ?? fromInput.hostAddr;
  const stdout = fromOutput.stdout ?? streamingStdout;
  const stderr = fromOutput.stderr ?? fromInput.stderr;
  const exitCode = fromOutput.exitCode ?? fromInput.exitCode;

  // command is JSON/input fields only — plaintext first-line is extractPreviewCommand.
  const commandForPurpose = command ?? '';
  const { purpose } = parsedPurpose ?? parseCommandPurpose(commandForPurpose);
  // Output body wins for display (executed command); input is fallback.
  // Do not join/unique the two: that duplicates `df -h` and Task 2 must not
  // "simplify" this back to a single parseCommandPurpose(purposeSource).
  const body =
    (fromOutput.command ? parseCommandPurpose(fromOutput.command).body : '') ||
    (fromInput.command ? parseCommandPurpose(fromInput.command).body : '') ||
    parseCommandPurpose(commandForPurpose).body;

  const payload = outUnwrapped?.payload ?? inUnwrapped?.payload;

  return {
    command,
    commandBody: body || undefined,
    purpose,
    hostLabel,
    hostAddr,
    serverName: hostLabel,
    exitCode,
    stdout,
    stderr,
    rawText: raw,
    payload,
    envelopeOk: outUnwrapped?.envelopeOk,
    attemptCount: outUnwrapped?.attemptCount
  };
}

function extractPreviewCommand(preview: string | undefined | null): string {
  const p = parseToolOutputPreview(preview);
  if (p.commandBody || p.command) {
    return p.commandBody || p.command || '';
  }
  const raw = String(preview ?? '').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      JSON.parse(raw);
      return '';
    } catch {
      // invalid JSON: headline uses first line (legacy)
    }
  }
  return raw.split('\n')[0].trim();
}

/** 命令首词（跳过 sudo / 环境变量赋值，剥路径前缀），用于意图映射。 */
function leadingCommandWord(command: string): string {
  for (const token of command.split(/\s+/)) {
    if (!token || token === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return token.split('/').pop() ?? token;
  }
  return '';
}

/**
 * 工具卡标题（docs/14 P1-ui）：「主机 · Purpose/意图」。
 * 命令正文不再进标题（第二行后续任务展示）。无主机则只显示 purpose/intent；
 * 两者都没有才回退 call.name。纯文本 preview 无 command 字段时，用首行命令映射意图。
 */
export function toolCallHeadline(
  call: Pick<ToolCallView, 'name' | 'preview'> & { inputPreview?: string }
): string {
  const parsed = parseToolOutputPreview(call.preview, call.inputPreview);
  const command =
    parsed.commandBody || parsed.command || extractPreviewCommand(call.preview);
  const lead = leadingCommandWord(command) || call.name;
  const intent = COMMAND_INTENT_ZH[lead] ?? COMMAND_INTENT_ZH[call.name];
  const purposeOrIntent = parsed.purpose || intent;
  const host = parsed.hostLabel || parsed.hostAddr || '';
  if (host && purposeOrIntent) return `${host} · ${purposeOrIntent}`;
  if (host) return `${host} · ${call.name}`;
  if (purposeOrIntent) return purposeOrIntent;
  return call.name;
}

export function isCommandToolCall(call: Pick<ToolCallView, 'name' | 'preview'>): boolean {
  const name = call.name || '';
  if (
    name === 'run_remote_command' ||
    name === 'terminal_run_command' ||
    name === 'jumpserver_run_terminal_command' ||
    name === 'terminal_run_script' ||
    name === 'bash' ||
    name.includes('exec_command') ||
    name.includes('terminal_command')
  ) {
    return true;
  }
  if (name === 'ops_dispatch_subagent' || name === 'ops_check_subagent') {
    return false;
  }
  const parsed = parseToolOutputPreview(call.preview);
  return Boolean(parsed.command && parsed.command.trim());
}

export function isSubagentToolCall(call: Pick<ToolCallView, 'name'>): boolean {
  return call.name === 'ops_dispatch_subagent' || call.name === 'ops_check_subagent';
}

export type ToolServerRow = {
  id?: string;
  label: string;
  host: string;
  port?: number;
  username?: string;
  connected: boolean;
  trust?: string;
  autoApprove?: boolean;
};

export type ToolDataView =
  | { kind: 'servers'; servers: ToolServerRow[] }
  | { kind: 'table'; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: 'kv'; entries: { key: string; value: unknown }[] }
  | { kind: 'json'; text: string };

function asServerRow(raw: unknown): ToolServerRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = asRecord(raw);
  const label = pickStr(rec, ['label', 'serverLabel', 'name']) ?? '';
  const host = pickStr(rec, ['host', 'ip']) ?? '';
  if (!label && !host) return undefined;
  return {
    id: pickStr(rec, ['id']),
    label: label || host,
    host: host || label,
    port: pickNum(rec, ['port']),
    username: pickStr(rec, ['username', 'user']),
    connected: rec.connected === true,
    trust: pickStr(rec, ['agentCommandTrust', 'trust']),
    autoApprove: rec.agentCommandAutoApprove === true
  };
}

export function classifyToolDataView(payload: unknown): ToolDataView {
  if (
    Array.isArray(payload) &&
    payload.length &&
    payload.every((x) => x && typeof x === 'object' && !Array.isArray(x))
  ) {
    const rows = payload.map((x) => asRecord(x));
    const colSet = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) colSet.add(k);
    }
    const columns = [...colSet].filter((c) => !/^id$|^uuid$/i.test(c));
    return { kind: 'table', columns, rows };
  }
  if (payload && typeof payload === 'object') {
    const rec = asRecord(payload);
    if (Array.isArray(rec.servers)) {
      const servers = rec.servers.map(asServerRow).filter((s): s is ToolServerRow => Boolean(s));
      if (servers.length) return { kind: 'servers', servers };
    }
    return { kind: 'kv', entries: Object.keys(rec).map((key) => ({ key, value: rec[key] })) };
  }
  try {
    return { kind: 'json', text: JSON.stringify(payload, null, 2) ?? '' };
  } catch {
    return { kind: 'json', text: String(payload) };
  }
}

export function formatKvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatDataOutputPreview(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed);
      return JSON.stringify(obj, null, 2);
    } catch {
      // ignore
    }
  }
  return trimmed;
}

export type AssistantDisplay = 'skip' | 'progress' | 'content';

/**
 * 空 assistant 渲染判定（docs/14 P1-ui）：
 * - error ⇒ content（错误文案 + Retry 照常渲染）；
 * - 有正文 ⇒ content；
 * - 空正文 + 流式中 ⇒ progress（单行「正在巡检…」占位）；
 * - 空正文 + 已结束 ⇒ skip（不产出 DOM，不留空白气泡）。
 */
export function assistantDisplay(
  item: Pick<Extract<TranscriptItem, { kind: 'assistant' }>, 'text' | 'streaming' | 'error'>
): AssistantDisplay {
  if (item.error) {
    return 'content';
  }
  if ((item.text ?? '').trim() !== '') {
    return 'content';
  }
  return item.streaming ? 'progress' : 'skip';
}

// ── usage（P1-4 context 水位）─────────────────────────────────────────────

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** usage evt / hydrate.usage → UsageView；无任何数值字段返回 null。 */
export function normalizeUsage(raw: unknown): UsageView | null {
  const rec = asRecord(raw);
  const usage: UsageView = {
    inputTokens: asFiniteNumber(rec.inputTokens),
    outputTokens: asFiniteNumber(rec.outputTokens),
    contextUsed: asFiniteNumber(rec.contextUsed),
    contextWindow: asFiniteNumber(rec.contextWindow),
    costUsd: asFiniteNumber(rec.costUsd),
    totalInputTokens: asFiniteNumber(rec.totalInputTokens),
    totalOutputTokens: asFiniteNumber(rec.totalOutputTokens),
    totalCostUsd: asFiniteNumber(rec.totalCostUsd)
  };
  const hasAny = Object.values(usage).some((v) => v !== undefined);
  return hasAny ? usage : null;
}

/** context 占用百分比（0–100 取整）；缺 contextUsed/contextWindow 返回 null。 */
export function usagePercent(usage: UsageView | null | undefined): number | null {
  if (!usage || usage.contextUsed === undefined || !usage.contextWindow) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((usage.contextUsed / usage.contextWindow) * 100)));
}

function formatCompactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(tokens);
}

/** 紧凑单行 usage 指标，如「43% 上下文 · 17k tokens · $0.02」；无任何可用字段返回 null。 */
export function formatCompactUsage(usage: UsageView | null | undefined): string | null {
  if (!usage) {
    return null;
  }
  const parts: string[] = [];
  const pct = usagePercent(usage);
  if (pct !== null) {
    parts.push(`${pct}%`);
  }
  const inTok = usage.totalInputTokens ?? usage.inputTokens;
  const outTok = usage.totalOutputTokens ?? usage.outputTokens;
  if (inTok !== undefined || outTok !== undefined) {
    const sum = (inTok ?? 0) + (outTok ?? 0);
    parts.push(`${formatCompactTokenCount(sum)} tokens`);
  }
  const cost = usage.totalCostUsd ?? usage.costUsd;
  if (cost !== undefined && cost > 0) {
    parts.push(`$${cost.toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** 详细 Tooltip 文本：悬停展示当轮与累计消耗明细 */
export function formatUsageTooltip(usage: UsageView | null | undefined): string {
  if (!usage) return '';
  const lines: string[] = [];
  if (usage.contextUsed !== undefined && usage.contextWindow !== undefined) {
    const pct = usagePercent(usage);
    lines.push(`上下文水位: ${usage.contextUsed.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${pct}%)`);
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    lines.push(`当轮消耗: Prompt ${usage.inputTokens?.toLocaleString() ?? 0} · Completion ${usage.outputTokens?.toLocaleString() ?? 0}`);
  }
  if (usage.totalInputTokens !== undefined || usage.totalOutputTokens !== undefined) {
    lines.push(`会话累计: Prompt ${usage.totalInputTokens?.toLocaleString() ?? 0} · Completion ${usage.totalOutputTokens?.toLocaleString() ?? 0}`);
  }
  const cost = usage.totalCostUsd ?? usage.costUsd;
  if (cost !== undefined && cost > 0) {
    lines.push(`费用预估: $${cost.toFixed(4)}`);
  }
  return lines.join('\n');
}

// ── hydrate 元数据（hasApiKey / usage）───────────────────────────────────

export interface HydrateMeta {
  hasApiKey: boolean | null;
  usage: UsageView | null;
}

/**
 * hydrate 快照吸收 hasApiKey / usage：字段缺省保持旧值（旧 host 兼容），
 * hasApiKey 只认布尔（null = host 未表态，UI 不据此拦截）。
 */
export function absorbHydrateMeta(
  previous: HydrateMeta,
  snapshot: { hasApiKey?: unknown; usage?: unknown }
): HydrateMeta {
  return {
    hasApiKey:
      typeof snapshot.hasApiKey === 'boolean' ? snapshot.hasApiKey : previous.hasApiKey,
    usage: snapshot.usage !== undefined ? normalizeUsage(snapshot.usage) : previous.usage
  };
}

/**
 * 「可发送」判定（P0-B composer 拦截 / 欢迎页 CTA 共用）：
 * 无模型清单 ⇒ 未配置；hasApiKey === false ⇒ 未配置；
 * hasApiKey === null（host 未下发）不拦截，避免旧 host 下误伤。
 */
export function modelsConfigured(
  modelOptions: readonly unknown[],
  hasApiKey: boolean | null
): boolean {
  return modelOptions.length > 0 && hasApiKey !== false;
}

// ── 子代理 inspector（docs/12 §3：整卡可点 + 顶栏运行条）──────────────────

/** transcript 内全部子代理卡平铺（出现顺序；同 taskId 后到覆盖先到）。 */
export function collectSubagentCards(items: readonly TranscriptItem[]): SubagentCard[] {
  const byId = new Map<string, SubagentCard>();
  for (const item of items) {
    if (item.kind !== 'subagents') {
      continue;
    }
    for (const agent of item.agents) {
      byId.set(agent.taskId, agent);
    }
  }
  return [...byId.values()];
}

/** 进行中的子代理（queued / running）：顶栏运行条数据源。 */
export function activeSubagentCards(cards: readonly SubagentCard[]): SubagentCard[] {
  return cards.filter((card) => card.status === 'queued' || card.status === 'running');
}

/**
 * ChatApp 顶层 inspector 的选中卡：id 为空或在 transcript 里找不到时视同关闭。
 * 抽成纯函数以便 node tsc（无 DOM lib）单测，避免测试 import Vue store。
 */
export function resolveInspectedSubagent(
  items: readonly TranscriptItem[],
  inspectorId: string | null
): SubagentCard | null {
  if (!inspectorId) {
    return null;
  }
  return collectSubagentCards(items).find((card) => card.taskId === inspectorId) ?? null;
}

/**
 * Inspector 内上一个/下一个子代理导航：
 * cards 中环状查找相邻卡片；无卡或只有 1 张返回 null。
 */
export function findAdjacentSubagent(
  cards: readonly SubagentCard[],
  currentTaskId: string,
  direction: 'prev' | 'next'
): string | null {
  if (cards.length <= 1) {
    return null;
  }
  const idx = cards.findIndex((card) => card.taskId === currentTaskId);
  if (idx < 0) {
    return null;
  }
  const targetIdx =
    direction === 'next'
      ? (idx + 1) % cards.length
      : (idx - 1 + cards.length) % cards.length;
  return cards[targetIdx].taskId;
}

/** 卡片主标题：goal 首行优先，缺省回退 label（标题不倒 latest 全文）。 */
export function subagentTitle(card: Pick<SubagentCard, 'goal' | 'label'>): string {
  const goal = (card.goal ?? '').split('\n')[0].trim();
  return goal || card.label;
}

/**
 * 紧凑「事件脉络」条：host 下发的 timeline 事件在前，transcript 中的
 * evidence 便签（confidence 三态）在后；host 不发 timeline 时仅证据也能撑起条带。
 */
export function buildTimelineStrip(
  timeline: readonly ChatTimelineEvent[],
  items: readonly TranscriptItem[],
  cap = 12
): TimelineStripEntry[] {
  const entries: TimelineStripEntry[] = timeline.map((event) => ({
    id: `tl-${event.id}`,
    label: event.title,
    tone: event.severity
  }));
  const evidenceEntries: TimelineStripEntry[] = [];
  for (const item of items) {
    if (item.kind === 'evidence') {
      evidenceEntries.push({
        id: `ev-${item.id}`,
        label: item.note.summary,
        tone: normalizeConfidence(item.note.confidence),
        ...(item.note.pinned ? { pinned: true } : {})
      });
    }
  }
  evidenceEntries.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  entries.push(...evidenceEntries);
  return entries.slice(-cap);
}

// ── transcript 粘底滚动（BUG-1：patch/appendText 不增 items.length）────────

const STICKY_TAIL_COUNT = 5;

function stickyTailItemPart(item: TranscriptItem | SubagentTranscriptItem): string {
  switch (item.kind) {
    case 'assistant':
      return `a:${item.id}:${(item.text ?? '').length}:${item.streaming ? 1 : 0}`;
    case 'thinking': {
      const steps = item.steps ?? [];
      const stepsLen = steps.reduce((sum, step) => sum + step.length, 0);
      return `t:${item.id}:${steps.length}:${stepsLen}:${item.durationMs ?? ''}`;
    }
    case 'tool':
      return `tool:${item.id}:${item.call.status}:${(item.call.preview ?? '').length}`;
    case 'subagents':
      return `sub:${item.id}:${item.agents.length}`;
    default:
      return `${(item as { kind: string; id: string }).kind}:${(item as { kind: string; id: string }).id}`;
  }
}

/** 末几条 transcript 项的轻量签名；appendText / tool preview 增量会改变签名。 */
export function stickyTailSignature(items: readonly (TranscriptItem | SubagentTranscriptItem)[]): string {
  return items.slice(-STICKY_TAIL_COUNT).map(stickyTailItemPart).join('|');
}

export function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** scrollHeight - scrollTop - clientHeight ≤ threshold 视为粘底；默认 4px。 */
export function isPinnedToBottom(el: HTMLElement, threshold = 4): boolean {
  return distanceFromBottom(el) <= threshold;
}

/** 流式占位 / live timer 用：`3200` → `3.2s`（与 formatThinkingLiveLabel 同形）。 */
export function formatElapsedSeconds(ms: number): string {
  return formatThinkingLiveLabel(ms);
}

// ── 时间戳（OPT-6）────────────────────────────────────────────────────────

/** 墙钟 → 相对时间（工具卡头 xs 标签；now 可注入便于单测）。 */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return '';
  }
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}小时前`;
  }
  return `${Math.floor(diff / 86_400_000)}天前`;
}

/** hover 用绝对时间（本地 HH:mm:ss 或完整日期）。 */
export function formatAbsoluteTime(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return '';
  }
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// ── 审批 audit 留痕（OPT-5）────────────────────────────────────────────────

type ApprovalAuditItem = Extract<
  TranscriptItem,
  { kind: 'approval' }
>;

/** briefId 尾 4 字符（不足 4 则全量）。 */
export function briefIdTail(briefId: string): string {
  const id = String(briefId ?? '').trim();
  return id.length <= 4 ? id : id.slice(-4);
}

/** transcript 审批行：`审批 #尾4位`（不裸渲完整 briefId）。 */
export function formatApprovalRefLabel(
  item: Pick<ApprovalAuditItem, 'briefId'> & Partial<ApprovalAuditItem>
): string {
  return `审批 #${briefIdTail(item.briefId)}`;
}

const APPROVAL_DECISION_LABEL: Record<
  NonNullable<ApprovalAuditItem['decision']>,
  { icon: string; label: string }
> = {
  approved: { icon: '✔', label: '已批准' },
  rejected: { icon: '✘', label: '已拒绝' },
  timeout: { icon: '⏱', label: '已超时' },
  pending: { icon: '…', label: '待审批' }
};

const APPROVAL_RISK_LABEL: Record<'write' | 'exec', string> = {
  write: 'write',
  exec: 'exec'
};

/**
 * 审批决议 audit 行（host system 行 / 结论模式留痕）：
 * `✔ 已批准 exec · rollback api-gateway · 10:32:15 · brief …尾4位`
 */
export function formatApprovalAuditLine(
  item: Pick<ApprovalAuditItem, 'briefId'> & Partial<ApprovalAuditItem>
): string {
  const decision = item.decision ?? 'pending';
  const meta = APPROVAL_DECISION_LABEL[decision] ?? APPROVAL_DECISION_LABEL.pending;
  const parts: string[] = [`${meta.icon} ${meta.label}`];
  if (item.risk === 'write' || item.risk === 'exec') {
    parts.push(APPROVAL_RISK_LABEL[item.risk]);
  }
  const target = String(item.targetLabel ?? '').trim();
  if (target) {
    parts.push(target);
  }
  if (typeof item.ts === 'number' && Number.isFinite(item.ts)) {
    parts.push(
      new Date(item.ts).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      })
    );
  }
  parts.push(`brief …${briefIdTail(item.briefId)}`);
  return parts.join(' · ');
}

/**
 * 从 SubagentCard 提炼 Board 单行摘要文本：
 * 1. 若 card.latest 有值，优先使用（截断至一行或首段）；
 * 2. 否则从 card.transcript 反向查找：
 *    - 最近 assistant 文本
 *    - 最近 tool: `[${call.name}] ${call.preview ?? ''}`
 *    - 最近 thinking 步骤
 * 3. 否则回退 card.currentActivity
 */
export function deriveSubagentBoardPreview(card: SubagentCard, maxChars = 80): string {
  if (card.latest && card.latest.trim()) {
    const clean = card.latest.replace(/\r?\n/g, ' ').trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
  }
  if (Array.isArray(card.transcript) && card.transcript.length > 0) {
    for (let i = card.transcript.length - 1; i >= 0; i--) {
      const item = card.transcript[i];
      if (item.kind === 'assistant' && item.text.trim()) {
        const clean = item.text.replace(/\r?\n/g, ' ').trim();
        return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
      }
      if (item.kind === 'tool') {
        const preview = item.call.preview ? item.call.preview.replace(/\r?\n/g, ' ').trim() : '';
        const raw = preview ? `[${item.call.name}] ${preview}` : `[${item.call.name}]`;
        return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
      }
      if (item.kind === 'thinking' && item.steps.length > 0) {
        const lastStep = item.steps[item.steps.length - 1].replace(/\r?\n/g, ' ').trim();
        if (lastStep) {
          return lastStep.length > maxChars ? `${lastStep.slice(0, maxChars)}…` : lastStep;
        }
      }
    }
  }
  if (card.currentActivity && card.currentActivity.trim()) {
    const clean = card.currentActivity.replace(/\r?\n/g, ' ').trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
  }
  return '';
}

const FENCED_BLOCK_RE = /```[a-zA-Z]*[ \t]*\n?([\s\S]*?)```/g;

/** 剥离 markdown 或纯文本中的 evidence-note / exec-report / verify-report 契约 JSON 块。 */
export function stripContractJson(text: string): string {
  if (!text || typeof text !== 'string') return '';
  let result = text.replace(FENCED_BLOCK_RE, (match, inner) => {
    try {
      const obj = JSON.parse(inner.trim());
      if (obj && typeof obj === 'object' && (typeof obj.contract === 'string' || (obj.confidence && obj.summary))) {
        return '';
      }
    } catch {}
    return match;
  });

  if (result.includes('"contract"') || (result.includes('"confidence"') && result.includes('"summary"'))) {
    for (let i = 0; i < result.length; i++) {
      if (result[i] === '{') {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let j = i; j < result.length; j++) {
          const char = result[j];
          if (escape) {
            escape = false;
            continue;
          }
          if (char === '\\') {
            escape = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (char === '{') {
              depth++;
            } else if (char === '}') {
              depth--;
              if (depth === 0) {
                const slice = result.slice(i, j + 1);
                try {
                  const obj = JSON.parse(slice.trim());
                  if (obj && typeof obj === 'object' && (typeof obj.contract === 'string' || (obj.confidence && obj.summary))) {
                    result = (result.slice(0, i) + result.slice(j + 1)).trim();
                    i = -1;
                  }
                } catch {}
                break;
              }
            }
          }
        }
      }
    }
  }
  return result.trim();
}

