/**
 * host 侧 UI 会话真源：会话列表、当前 transcript、playbook 阶段、待批简报、
 * 看板时间线。Webview 无真源（docs/05 §4）——hydrate 时从这里取全量快照。
 *
 * P1-3 / P0-C：会话跨重载持久化到 `<agentDir>/ui-sessions.json`（默认
 * ~/.at-series/agent/ui-sessions.json，0600），构造时同步回载：
 * - 会话标题取首条用户消息（截 40 字）；
 * - 每会话记录 pi JSONL 的 sessionFile（runtime 续接的钥匙，P0-C）；
 * - 待批简报与子代理 live 卡不持久化（审批令牌只存 host 内存、跨重载作废；
 *   transcript 里的 approval/subagents 卡片条目仍随 items 保留）。
 * pi JSONL 仍是模型上下文的唯一真源；本文件只是 UI transcript 缓存。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  /** 该会话对应的 pi JSONL 路径（runtime 续接用；未跑过模型时缺省）。 */
  sessionFile?: string;
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

export interface SessionStoreOptions {
  /** 持久化目录，默认 ~/.at-series/agent；文件名固定 ui-sessions.json。 */
  agentDir?: string;
  /** 直接指定持久化文件路径（测试用，优先于 agentDir）。 */
  filePath?: string;
}

const PERSIST_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 400;
const TITLE_MAX_CHARS = 40;
/** 落盘会话数上限（旧会话按 createdAt 淘汰，防止文件无界增长）。 */
const MAX_PERSISTED_SESSIONS = 50;

/** 自动标题（「会话 N」）识别：首条用户消息到达时才允许覆盖。 */
const AUTO_TITLE_RE = /^会话 \d+$/;

interface PersistedBag {
  items?: TranscriptItem[];
  playbook?: PlaybookState | null;
  timeline?: TimelineEventView[];
}

interface PersistedFile {
  version?: number;
  activeSessionId?: string;
  sessions?: Array<Partial<SessionInfo>>;
  bags?: Record<string, PersistedBag>;
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

  private readonly persistPath: string;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options?: SessionStoreOptions) {
    this.persistPath =
      options?.filePath ??
      path.join(options?.agentDir ?? path.join(os.homedir(), '.at-series', 'agent'), 'ui-sessions.json');
    if (!this.loadFromDisk()) {
      this.newSession();
    }
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
    this.schedulePersist();
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
    this.schedulePersist();
    return true;
  }

  /** 记录会话对应的 pi JSONL 路径（runtime 创建/续接后回填）。 */
  setSessionFile(id: string, sessionFile: string): void {
    const session = this._sessions.find((s) => s.id === id);
    if (!session || session.sessionFile === sessionFile) return;
    session.sessionFile = sessionFile;
    this.schedulePersist();
  }

  sessionFileOf(id: string): string | undefined {
    return this._sessions.find((s) => s.id === id)?.sessionFile;
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
    if (item.kind === 'user') this.maybeAdoptTitle(item.text);
    this.schedulePersist();
  }

  /** 首条用户消息 → 会话标题（仅覆盖自动标题「会话 N」）。 */
  private maybeAdoptTitle(text: string): void {
    const session = this._sessions.find((s) => s.id === this._activeSessionId);
    if (!session) return;
    if (session.title.length > 0 && !AUTO_TITLE_RE.test(session.title)) return;
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return;
    session.title = compact.length > TITLE_MAX_CHARS ? `${compact.slice(0, TITLE_MAX_CHARS)}…` : compact;
    this.sessionsEmitter.fire();
  }

  findItem(itemId: string): TranscriptItem | undefined {
    return this._items.find((i) => i.id === itemId);
  }

  appendAssistantText(itemId: string, text: string): void {
    const item = this.findItem(itemId);
    if (item?.kind === 'assistant') item.text += text;
    this.schedulePersist();
  }

  finalizeAssistant(itemId: string, finalText?: string): void {
    const item = this.findItem(itemId);
    if (item?.kind === 'assistant') {
      if (typeof finalText === 'string') item.text = finalText;
      item.streaming = false;
    }
    this.schedulePersist();
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
    this.schedulePersist();
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
    this.schedulePersist();
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
    this.schedulePersist();
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
      sessions: this._sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
      ...(extra ?? {})
    };
  }

  // ── 持久化 ─────────────────────────────────────────────────────────────

  /** 立即落盘（dispose / 测试用；常规路径走 schedulePersist 去抖）。 */
  persistNow(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.saveActiveBag();
    const keep = [...this._sessions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PERSISTED_SESSIONS);
    const keepIds = new Set(keep.map((s) => s.id));
    const bags: Record<string, PersistedBag> = {};
    for (const [id, bag] of this._bags) {
      if (!keepIds.has(id)) continue;
      bags[id] = {
        items: bag.items,
        playbook: bag.playbook ?? null,
        timeline: bag.timeline
      };
    }
    const payload: PersistedFile = {
      version: PERSIST_VERSION,
      activeSessionId: this._activeSessionId,
      // 落盘顺序保持创建序（keep 只用于淘汰判定）。
      sessions: this._sessions.filter((s) => keepIds.has(s.id)),
      bags
    };
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, `${JSON.stringify(payload)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch {
      // 落盘失败不致命：会话仍在内存，下一次变更重试。
    }
  }

  private schedulePersist(): void {
    if (this.disposed || this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
    // 不阻止进程退出（VS Code 扩展宿主 dispose 时另有 persistNow）。
    this.persistTimer.unref?.();
  }

  /** 构造期同步回载；成功恢复至少一个会话返回 true。 */
  private loadFromDisk(): boolean {
    let parsed: PersistedFile;
    try {
      parsed = JSON.parse(readFileSync(this.persistPath, 'utf8')) as PersistedFile;
    } catch {
      return false;
    }
    if (!parsed || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return false;
    for (const raw of parsed.sessions) {
      if (typeof raw?.id !== 'string' || raw.id.length === 0) continue;
      this._sessions.push({
        id: raw.id,
        title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : '会话',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        ...(typeof raw.sessionFile === 'string' && raw.sessionFile.length > 0
          ? { sessionFile: raw.sessionFile }
          : {})
      });
    }
    if (this._sessions.length === 0) return false;
    const bags = parsed.bags ?? {};
    for (const session of this._sessions) {
      const bag = bags[session.id];
      this._bags.set(session.id, {
        items: Array.isArray(bag?.items) ? sanitizeItems(bag.items) : [],
        playbook:
          bag?.playbook && typeof bag.playbook === 'object' && typeof bag.playbook.id === 'string'
            ? { id: bag.playbook.id, stage: String(bag.playbook.stage ?? 'triage') }
            : undefined,
        // 审批令牌 / 子代理 live 态跨重载一律作废。
        pendingBriefs: [],
        subagents: new Map(),
        timeline: Array.isArray(bag?.timeline) ? bag.timeline : []
      });
    }
    const active =
      typeof parsed.activeSessionId === 'string' &&
      this._sessions.some((s) => s.id === parsed.activeSessionId)
        ? parsed.activeSessionId
        : this._sessions[this._sessions.length - 1].id;
    const bag = this._bags.get(active);
    this._activeSessionId = active;
    this._items = bag?.items ?? [];
    this._playbook = bag?.playbook;
    this._pendingBriefs = [];
    this._subagents = new Map();
    this._timeline = bag?.timeline ?? [];
    return true;
  }

  dispose(): void {
    this.persistNow();
    this.disposed = true;
    this.sessionsEmitter.dispose();
    this.approvalsEmitter.dispose();
    this.timelineEmitter.dispose();
  }
}

/** 重载后 transcript 清洗：流式中断的 assistant 收尾、running 工具标记 interrupted。 */
function sanitizeItems(items: TranscriptItem[]): TranscriptItem[] {
  return items
    .filter((item): item is TranscriptItem => !!item && typeof item === 'object' && typeof (item as { kind?: unknown }).kind === 'string')
    .map((item) => {
      if (item.kind === 'assistant' && item.streaming) {
        return { ...item, streaming: false };
      }
      if (item.kind === 'tool' && item.call?.status === 'running') {
        return { ...item, call: { ...item.call, status: 'interrupted' as const } };
      }
      return item;
    });
}
