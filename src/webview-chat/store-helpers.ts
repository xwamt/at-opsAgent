/**
 * chat store 的纯 TS 逻辑（无 Vue/DOM/pinia 依赖）：
 * prompt 上行 payload 组装与「事件脉络」时间线条目归一化。
 * 单独成文件是为了能在 node 环境直接单测（docs/09 §8 组件测降级路径）。
 */
import type {
  ChatPromptReq,
  SubagentCard,
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
 * CoT 隐藏（对齐 pi-coding-agent hideThinkingBlock，且恒为折叠、无 expander）：
 * thinking 项的推理步骤永不进入可见渲染；唯一可见的是 security-triage 等
 * 链路附带的 untrustedQuotes 警示块（只含外部引用原文，不含任何思考步骤）。
 * 返回空数组 ⇒ 该 thinking 项没有引用块可渲染。
 */
export function visibleUntrustedQuotes(item: TranscriptItem): string[] {
  if (item.kind !== 'thinking' || !Array.isArray(item.untrustedQuotes)) {
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
 * 思考时长指示是否可见：配置 ui.showThinking 默认 true；
 * 结论模式（Focus）强制 false。CoT 正文始终折叠。
 */
export function thinkingMetaVisible(showThinking: boolean, conclusionMode: boolean): boolean {
  return showThinking === true && conclusionMode !== true;
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

const HEADLINE_COMMAND_CAP = 48;

/**
 * preview → 命令文本：JSON 带 .command 用其首行；JSON 无 command 视为
 * 结构化输出（提不出命令）；非 JSON 纯文本取首行。
 */
function extractPreviewCommand(preview: string | undefined | null): string {
  const raw = String(preview ?? '').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const rec = asRecord(JSON.parse(raw));
      const command = typeof rec.command === 'string' ? rec.command : '';
      return command.split('\n')[0].trim();
    } catch {
      // 非合法 JSON：按纯文本首行处理
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
 * 工具卡标题（docs/14 P1-ui）：runtime 里几乎只有 run_remote_command 一个
 * 工具名，光看名字不知道在干什么。从 preview 提取命令 → 首词映射中文意图，
 * 标题为「意图 · 短命令」；提不出命令回退「意图 · name」；意图未知回退 name
 * （有命令时仍带短命令）。
 */
export function toolCallHeadline(call: Pick<ToolCallView, 'name' | 'preview'>): string {
  const command = extractPreviewCommand(call.preview);
  const lead = leadingCommandWord(command) || call.name;
  const intent = COMMAND_INTENT_ZH[lead] ?? COMMAND_INTENT_ZH[call.name];
  const shortCommand =
    command.length > HEADLINE_COMMAND_CAP
      ? `${command.slice(0, HEADLINE_COMMAND_CAP)}…`
      : command;
  if (!intent) {
    return shortCommand ? `${call.name} · ${shortCommand}` : call.name;
  }
  return `${intent} · ${shortCommand || call.name}`;
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
    costUsd: asFiniteNumber(rec.costUsd)
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
  for (const item of items) {
    if (item.kind === 'evidence') {
      entries.push({
        id: `ev-${item.id}`,
        label: item.note.summary,
        tone: normalizeConfidence(item.note.confidence)
      });
    }
  }
  return entries.slice(-cap);
}
