/**
 * 看板本地文案层：chat 的 i18n.ts 归 B-chat 所有，board 新增键放这里。
 * 语言跟随 chat i18n 的 locale ref（getLocale() 读响应式 ref，模板中自动更新）。
 */
import { getLocale, type OpsLocale } from '../webview-chat/i18n';

const zhCN = {
  filterAll: '全部',
  filterToolbarAria: '时间线筛选',
  severityFilterAria: '按严重级过滤',
  searchPlaceholder: '搜索标题 / 事故 / 详情…',
  searchAria: '搜索时间线事件',
  timelineAria: '事故时间线',
  noMatch: '没有匹配当前筛选的事件',
  clearFilters: '清除筛选',
  dayToday: '今天',
  dayYesterday: '昨天',
  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  mockBadgeTitle: '未检测到 acquireVsCodeApi，使用本地 mock host'
} as const;

export type BoardMessageKey = keyof typeof zhCN;

const en: Record<BoardMessageKey, string> = {
  filterAll: 'All',
  filterToolbarAria: 'Timeline filters',
  severityFilterAria: 'Filter by severity',
  searchPlaceholder: 'Search title / incident / detail…',
  searchAria: 'Search timeline events',
  timelineAria: 'Incident timeline',
  noMatch: 'No events match the current filters',
  clearFilters: 'Clear filters',
  dayToday: 'Today',
  dayYesterday: 'Yesterday',
  justNow: 'just now',
  minutesAgo: '{n}m ago',
  hoursAgo: '{n}h ago',
  mockBadgeTitle: 'acquireVsCodeApi not found; using local mock host'
};

const MESSAGES: Record<OpsLocale, Record<BoardMessageKey, string>> = { 'zh-CN': zhCN, en };

/** 看板取词（板内新增键；chat 既有键继续用 chat 的 t()）。 */
export function bt(key: BoardMessageKey): string {
  return MESSAGES[getLocale()][key] ?? zhCN[key];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 完整绝对时间（行 hover title 与无障碍用）。 */
export function formatAbsolute(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 本地日历日 key（日期分组用），形如 2026-08-28。 */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 分组头标签：今天 / 昨天 / YYYY-MM-DD。 */
export function dayLabel(key: string, now: number): string {
  if (key === dayKeyOf(now)) {
    return bt('dayToday');
  }
  if (key === dayKeyOf(now - 86_400_000)) {
    return bt('dayYesterday');
  }
  return key;
}

/**
 * 时间列单元格：当天事件用相对时间（刚刚 / N 分钟前 / N 小时前），
 * 更早的行只显示 HH:mm:ss（日期已在 sticky 分组头）。hover 一律看绝对时间。
 */
export function formatTimeCell(ts: number, now: number): string {
  if (dayKeyOf(ts) !== dayKeyOf(now)) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) {
    return bt('justNow');
  }
  if (diff < 3_600_000) {
    return bt('minutesAgo').replace('{n}', String(Math.floor(diff / 60_000)));
  }
  return bt('hoursAgo').replace('{n}', String(Math.floor(diff / 3_600_000)));
}
