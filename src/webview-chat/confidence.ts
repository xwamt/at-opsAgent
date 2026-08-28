/**
 * 证据结论三态（confirmed / hypothesis / pending）的纯 TS helper：
 * EvidenceNote 与看板 IncidentTimeline 共用，并可脱离 Vue 单测（docs/09 §8）。
 * 三态永远是「颜色 + 文字」双通道，不允许只靠颜色（docs/05 §6）。
 */
import { getLocale, type OpsLocale } from './i18n';

export type ConfidenceLevel = 'confirmed' | 'hypothesis' | 'pending';

/** 未知/缺失一律归 pending（未检查 ≠ 正常）。 */
export function normalizeConfidence(value: unknown): ConfidenceLevel {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'confirmed' || raw === 'hypothesis' ? raw : 'pending';
}

/** ops-tokens.css 中的三态色 class。 */
export function confidenceClass(value: unknown): string {
  return `ops-confidence-${normalizeConfidence(value)}`;
}

const LABELS: Record<OpsLocale, Record<ConfidenceLevel, string>> = {
  'zh-CN': {
    confirmed: '已确证 confirmed',
    hypothesis: '假设 hypothesis',
    pending: '待定 pending'
  },
  en: {
    confirmed: 'confirmed',
    hypothesis: 'hypothesis',
    pending: 'pending'
  }
};

export function confidenceLabel(value: unknown, locale?: OpsLocale): string {
  return LABELS[locale ?? getLocale()][normalizeConfidence(value)];
}
