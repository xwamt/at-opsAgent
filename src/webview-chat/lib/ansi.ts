/**
 * 日志行 ANSI 剥离 + 关键词切 span（Plan 10 / P1-6）。
 * CSI 只剥 `ESC [ ... m`；关键词必须词界匹配，避免 `error_rate` 误伤。
 */

const CSI_SGR = /\x1B\[[0-9;]*m/g;
const LOG_KEYWORD = /\bERROR\b|\bFATAL\b|\bException\b|\bpanic\b|\bWARN(?:ING)?\b/g;

export type LogTone = 'error' | 'warn';

export type LogSegment = { text: string; tone?: LogTone };

export function stripAnsi(s: string): string {
  return s.replace(CSI_SGR, '');
}

function toneOf(token: string): LogTone {
  return /^WARN/.test(token) ? 'warn' : 'error';
}

export function annotateLogLine(s: string): LogSegment[] {
  const stripped = stripAnsi(s);
  const re = new RegExp(LOG_KEYWORD.source, 'g');
  const segs: LogSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    if (match.index > last) {
      segs.push({ text: stripped.slice(last, match.index) });
    }
    segs.push({ text: match[0], tone: toneOf(match[0]) });
    last = match.index + match[0].length;
  }
  if (last < stripped.length) {
    segs.push({ text: stripped.slice(last) });
  }
  if (segs.length === 0) {
    segs.push({ text: stripped });
  }
  return segs;
}
