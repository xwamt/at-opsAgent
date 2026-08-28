import { defineStore } from 'pinia';
import type { Envelope } from '../protocol/host-protocol';
import { setLocale } from '../webview-chat/i18n';
import { getVsCodeApi, isMockHost } from '../webview-chat/vscode-api';

export interface TimelinePipelineView {
  job: string;
  build?: string;
  result: string;
}

export interface TimelineHostView {
  pluginId: string;
  label: string;
  connected: boolean;
}

export interface TimelineEventView {
  id: string;
  ts: number;
  title: string;
  detail?: string;
  severity: 'info' | 'warn' | 'crit';
  incidentId?: string;
  kind?: string;
  status?: string;
  /** 证据三态（存在才渲染，颜色+文字双通道）。 */
  confidence?: 'confirmed' | 'hypothesis' | 'pending';
  /** kind=pipeline 事件的构建点。 */
  pipeline?: TimelinePipelineView;
  /** 目标主机/终端（数据存在才渲染）。 */
  host?: TimelineHostView;
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : {};
}

function toSeverity(value: unknown): TimelineEventView['severity'] {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'crit' || raw === 'critical' || raw === 'error' || raw === 'fatal') {
    return 'crit';
  }
  if (raw === 'warn' || raw === 'warning' || raw === 'degraded') {
    return 'warn';
  }
  return 'info';
}

function toTimestamp(rec: AnyRecord): number {
  for (const key of ['ts', 'at', 'time', 'timestamp']) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return Date.now();
}

function toConfidence(value: unknown): TimelineEventView['confidence'] {
  const raw = String(value ?? '').toLowerCase();
  return raw === 'confirmed' || raw === 'hypothesis' || raw === 'pending' ? raw : undefined;
}

/** pipeline 点：优先结构化字段，kind=pipeline 时兜底从标题猜 #build / result。 */
function toPipeline(rec: AnyRecord, title: string): TimelinePipelineView | undefined {
  const raw = asRecord(rec.pipeline);
  if (typeof raw.job === 'string' && raw.job) {
    return {
      job: raw.job,
      build: raw.build !== undefined ? String(raw.build) : undefined,
      result: String(raw.result ?? 'building')
    };
  }
  if (String(rec.kind ?? '') !== 'pipeline') {
    return undefined;
  }
  const build = title.match(/#(\d+)/)?.[1];
  const result =
    title.match(/\b(SUCCESS|FAILURE|BUILDING|UNSTABLE|ABORTED)\b/i)?.[1]?.toLowerCase() ??
    'building';
  return { job: (build ? title.slice(0, title.indexOf('#')) : title).trim() || title, build, result };
}

function toHost(rec: AnyRecord): TimelineHostView | undefined {
  const raw = asRecord(rec.host);
  const label = raw.label ?? raw.assetName ?? raw.serverId;
  if (label === undefined && raw.pluginId === undefined) {
    return undefined;
  }
  return {
    pluginId: String(raw.pluginId ?? 'at.terminal'),
    label: String(label ?? ''),
    connected: raw.connected !== false
  };
}

function normalizeEvent(payload: unknown): TimelineEventView | null {
  const outer = asRecord(payload);
  const rec = outer.event ? asRecord(outer.event) : outer;
  const id = rec.id ?? rec.eventId;
  if (id === undefined || id === null || id === '') {
    return null;
  }
  const title = String(rec.title ?? rec.summary ?? rec.text ?? '（无标题）');
  return {
    id: String(id),
    ts: toTimestamp(rec),
    title,
    detail: typeof rec.detail === 'string' ? rec.detail : undefined,
    severity: toSeverity(rec.severity ?? rec.level),
    incidentId: rec.incidentId !== undefined ? String(rec.incidentId) : undefined,
    kind: rec.kind !== undefined ? String(rec.kind) : undefined,
    status: rec.status !== undefined ? String(rec.status) : undefined,
    confidence: toConfidence(rec.confidence),
    pipeline: toPipeline(rec, title),
    host: toHost(rec)
  };
}

let reqSeq = 0;

export const useBoardStore = defineStore('ops-board', {
  state: () => ({
    events: [] as TimelineEventView[],
    mock: false
  }),

  getters: {
    sorted(state): TimelineEventView[] {
      return [...state.events].sort((a, b) => b.ts - a.ts);
    }
  },

  actions: {
    post(type: string, payload: unknown = {}): void {
      reqSeq += 1;
      const envelope: Envelope = {
        v: 1,
        id: `board-${Date.now().toString(36)}-${reqSeq}`,
        dir: 'req',
        type,
        payload,
        ts: Date.now()
      };
      getVsCodeApi().postMessage(envelope);
    },

    attach(): void {
      this.mock = isMockHost();
      window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as Partial<Envelope> | undefined;
        if (!data || data.v !== 1 || data.dir !== 'evt' || typeof data.type !== 'string') {
          return;
        }
        if (data.type === 'timeline/upsert') {
          this.upsert(data.payload);
        } else if (data.type === 'hydrate') {
          const rec = asRecord(data.payload);
          setLocale(rec.locale);
          const list = rec.timeline ?? rec.events ?? rec.items;
          if (Array.isArray(list)) {
            this.events = [];
            for (const entry of list) {
              this.upsert(entry);
            }
          }
        }
      });
    },

    upsert(payload: unknown): void {
      const event = normalizeEvent(payload);
      if (!event) {
        return;
      }
      const idx = this.events.findIndex((existing) => existing.id === event.id);
      if (idx >= 0) {
        this.events.splice(idx, 1, { ...this.events[idx], ...event });
      } else {
        this.events.push(event);
      }
    }
  }
});
