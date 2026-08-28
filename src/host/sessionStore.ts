/**
 * host 侧内存真源：会话列表、当前 transcript、playbook 阶段、待批简报、看板时间线。
 * Webview 无真源（docs/05 §4）——hydrate 时从这里取全量快照。
 */
import { randomUUID } from 'node:crypto';
import {
  Emitter,
  type ApprovalBriefView,
  type Event,
  type HydrateEvt,
  type SubagentCard,
  type TranscriptItem
} from '../protocol';

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: number;
}

export interface PlaybookState {
  id: string;
  stage: string;
}

export interface TimelineEventView {
  id: string;
  ts: number;
  [key: string]: unknown;
}

/** 每会话的内存包：switchSession 保存/恢复 transcript 等全部会话态。 */
interface SessionBag {
  items: TranscriptItem[];
  playbook: PlaybookState | undefined;
  pendingBriefs: ApprovalBriefView[];
  subagents: Map<string, SubagentCard>;
  timeline: TimelineEventView[];
}

export class SessionStore {
  private readonly sessionsEmitter = new Emitter<void>();
  private readonly approvalsEmitter = new Emitter<void>();
  private readonly timelineEmitter = new Emitter<TimelineEventView>();

  readonly onDidChangeSessions: Event<void> = this.sessionsEmitter.event;
  readonly onDidChangeApprovals: Event<void> = this.approvalsEmitter.event;
  readonly onDidAppendTimeline: Event<TimelineEventView> = this.timelineEmitter.event;

  private readonly _sessions: SessionInfo[] = [];
  private readonly _bags = new Map<string, SessionBag>();
  private _activeSessionId = '';
  private _items: TranscriptItem[] = [];
  private _playbook: PlaybookState | undefined;
  private _pendingBriefs: ApprovalBriefView[] = [];
  private _subagents = new Map<string, SubagentCard>();
  private _timeline: TimelineEventView[] = [];

  constructor() {
    this.newSession();
  }

  // ── 会话 ───────────────────────────────────────────────────────────────

  get sessions(): readonly SessionInfo[] {
    return this._sessions;
  }

  get activeSessionId(): string {
    return this._activeSessionId;
  }

  newSession(title?: string): SessionInfo {
    this.saveActiveBag();
    const session: SessionInfo = {
      id: randomUUID(),
      title: title ?? `会话 ${this._sessions.length + 1}`,
      createdAt: Date.now()
    };
    this._sessions.push(session);
    this._activeSessionId = session.id;
    this._items = [];
    this._playbook = undefined;
    this._pendingBriefs = [];
    this._subagents = new Map();
    this._timeline = [];
    this.sessionsEmitter.fire();
    this.approvalsEmitter.fire();
    return session;
  }

  /**
   * 切换会话：先把当前会话态存回内存包，再整体载入目标会话包
   * （transcript / playbook / 简报 / 子代理卡片 / 时间线）。
   * 目标不存在返回 false；切到当前会话是 no-op（返回 true）。
   */
  switchSession(id: string): boolean {
    if (!this._sessions.some((s) => s.id === id)) return false;
    if (id === this._activeSessionId) return true;
    this.saveActiveBag();
    const bag = this._bags.get(id);
    this._activeSessionId = id;
    this._items = bag?.items ?? [];
    this._playbook = bag?.playbook;
    this._pendingBriefs = bag?.pendingBriefs ?? [];
    this._subagents = bag?.subagents ?? new Map();
    this._timeline = bag?.timeline ?? [];
    this.sessionsEmitter.fire();
    this.approvalsEmitter.fire();
    return true;
  }

  /** 当前会话态存回 _bags（live 引用直接入包；载回时同一引用继续生效）。 */
  private saveActiveBag(): void {
    if (this._activeSessionId.length === 0) return;
    this._bags.set(this._activeSessionId, {
      items: this._items,
      playbook: this._playbook,
      pendingBriefs: this._pendingBriefs,
      subagents: this._subagents,
      timeline: this._timeline
    });
  }

  // ── transcript ─────────────────────────────────────────────────────────

  get items(): readonly TranscriptItem[] {
    return this._items;
  }

  appendItem(item: TranscriptItem): void {
    this._items.push(item);
  }

  findItem(itemId: string): TranscriptItem | undefined {
    return this._items.find((i) => i.id === itemId);
  }

  appendAssistantText(itemId: string, text: string): void {
    const item = this.findItem(itemId);
    if (item?.kind === 'assistant') item.text += text;
  }

  finalizeAssistant(itemId: string, finalText?: string): void {
    const item = this.findItem(itemId);
    if (item?.kind === 'assistant') {
      if (typeof finalText === 'string') item.text = finalText;
      item.streaming = false;
    }
  }

  appendThinkingText(itemId: string, text: string): void {
    const item = this.findItem(itemId);
    if (item?.kind === 'thinking') {
      if (item.steps.length === 0) item.steps.push('');
      item.steps[item.steps.length - 1] += text;
    }
  }

  // ── playbook ───────────────────────────────────────────────────────────

  get playbook(): PlaybookState | undefined {
    return this._playbook;
  }

  setPlaybook(state: PlaybookState | undefined): void {
    this._playbook = state;
  }

  // ── 审批 ───────────────────────────────────────────────────────────────

  get pendingBriefs(): readonly ApprovalBriefView[] {
    return this._pendingBriefs;
  }

  addBrief(brief: ApprovalBriefView): void {
    if (!this._pendingBriefs.some((b) => b.id === brief.id)) {
      this._pendingBriefs.push(brief);
      this.approvalsEmitter.fire();
    }
  }

  resolveBrief(briefId: string): ApprovalBriefView | undefined {
    const idx = this._pendingBriefs.findIndex((b) => b.id === briefId);
    if (idx < 0) return undefined;
    const [brief] = this._pendingBriefs.splice(idx, 1);
    this.approvalsEmitter.fire();
    return brief;
  }

  replaceBriefs(briefs: ApprovalBriefView[]): void {
    this._pendingBriefs = [...briefs];
    this.approvalsEmitter.fire();
  }

  // ── 子代理 ─────────────────────────────────────────────────────────────

  getSubagent(taskId: string): SubagentCard | undefined {
    return this._subagents.get(taskId);
  }

  upsertSubagent(card: SubagentCard): void {
    this._subagents.set(card.taskId, card);
    const existing = this._items.find((i) => i.kind === 'subagents');
    const agents = [...this._subagents.values()];
    if (existing?.kind === 'subagents') {
      existing.agents = agents;
    } else {
      this._items.push({ kind: 'subagents', id: randomUUID(), agents });
    }
  }

  // ── 看板时间线 ─────────────────────────────────────────────────────────

  get timeline(): readonly TimelineEventView[] {
    return this._timeline;
  }

  appendTimeline(event: Record<string, unknown>): TimelineEventView {
    const view: TimelineEventView = {
      id: typeof event.id === 'string' ? event.id : randomUUID(),
      ts: typeof event.ts === 'number' ? event.ts : Date.now(),
      ...event
    };
    const idx = this._timeline.findIndex((e) => e.id === view.id);
    if (idx >= 0) this._timeline[idx] = view;
    else this._timeline.push(view);
    this.timelineEmitter.fire(view);
    return view;
  }

  // ── 快照 ───────────────────────────────────────────────────────────────

  snapshot(providers: unknown, extra?: Partial<HydrateEvt>): HydrateEvt {
    return {
      sessionId: this._activeSessionId,
      playbook: this._playbook ? { ...this._playbook } : undefined,
      items: [...this._items],
      providers,
      pendingApproval: this._pendingBriefs[0],
      sessions: this._sessions.map((s) => ({ ...s })),
      ...(extra ?? {})
    };
  }

  dispose(): void {
    this.sessionsEmitter.dispose();
    this.approvalsEmitter.dispose();
    this.timelineEmitter.dispose();
  }
}
