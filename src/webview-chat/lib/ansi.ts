/**
 * 终端与日志行 ANSI 解析与关键词标注引擎。
 * 支持 ANSI SGR 16 基础色与 Bright 色、样式解析，同时兼容 ERROR/WARN 关键词提取。
 */

const CSI_SGR = /\x1B\[[0-9;]*m/g;
const LOG_KEYWORD = /\bERROR\b|\bFATAL\b|\bException\b|\bpanic\b|\bWARN(?:ING)?\b/g;

export type LogTone = 'error' | 'warn';

export type LogSegment = { text: string; tone?: LogTone };

export interface AnsiSpan {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  tone?: LogTone;
}

export interface AnsiLine {
  n: number;
  spans: AnsiSpan[];
  level: 'error' | 'warn' | null;
}

const FG_MAP: Record<number, string> = {
  30: 'ansi-black',
  31: 'ansi-red',
  32: 'ansi-green',
  33: 'ansi-yellow',
  34: 'ansi-blue',
  35: 'ansi-magenta',
  36: 'ansi-cyan',
  37: 'ansi-white',
  90: 'ansi-bright-black',
  91: 'ansi-bright-red',
  92: 'ansi-bright-green',
  93: 'ansi-bright-yellow',
  94: 'ansi-bright-blue',
  95: 'ansi-bright-magenta',
  96: 'ansi-bright-cyan',
  97: 'ansi-bright-white'
};

const BG_MAP: Record<number, string> = {
  40: 'ansi-bg-black',
  41: 'ansi-bg-red',
  42: 'ansi-bg-green',
  43: 'ansi-bg-yellow',
  44: 'ansi-bg-blue',
  45: 'ansi-bg-magenta',
  46: 'ansi-bg-cyan',
  47: 'ansi-bg-white',
  100: 'ansi-bg-bright-black',
  101: 'ansi-bg-bright-red',
  102: 'ansi-bg-bright-green',
  103: 'ansi-bg-bright-yellow',
  104: 'ansi-bg-bright-blue',
  105: 'ansi-bg-bright-magenta',
  106: 'ansi-bg-bright-cyan',
  107: 'ansi-bg-bright-white'
};

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

/**
 * 将可能包含 ANSI CSI SGR 转义序列的多行文本解析为带格式的 AnsiLine 数组。
 */
export function parseAnsiToLines(raw: string): AnsiLine[] {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const result: AnsiLine[] = [];

  let currentColor: string | undefined;
  let currentBg: string | undefined;
  let currentBold: boolean | undefined;
  let currentDim: boolean | undefined;
  let currentItalic: boolean | undefined;
  let currentUnderline: boolean | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const spans: AnsiSpan[] = [];
    let hasError = false;
    let hasWarn = false;

    let lastIndex = 0;
    const re = /\x1B\[([0-9;]*)m/g;
    let match: RegExpExecArray | null;

    const pushChunk = (text: string) => {
      if (!text) return;
      // 拆分关键词（如 ERROR / WARN）
      const kwRe = new RegExp(LOG_KEYWORD.source, 'g');
      let subLast = 0;
      let kwMatch: RegExpExecArray | null;
      while ((kwMatch = kwRe.exec(text)) !== null) {
        if (kwMatch.index > subLast) {
          const chunkText = text.slice(subLast, kwMatch.index);
          const span: AnsiSpan = { text: chunkText };
          if (currentColor) span.color = currentColor;
          if (currentBg) span.bg = currentBg;
          if (currentBold) span.bold = true;
          if (currentDim) span.dim = true;
          if (currentItalic) span.italic = true;
          if (currentUnderline) span.underline = true;
          if (span.color === 'ansi-red' || span.color === 'ansi-bright-red') {
            span.tone = 'error';
            hasError = true;
          } else if (span.color === 'ansi-yellow' || span.color === 'ansi-bright-yellow') {
            span.tone = 'warn';
            hasWarn = true;
          }
          spans.push(span);
        }
        const kwText = kwMatch[0];
        const tone = toneOf(kwText);
        if (tone === 'error') hasError = true;
        if (tone === 'warn') hasWarn = true;
        const kwSpan: AnsiSpan = { text: kwText, tone };
        if (currentColor) kwSpan.color = currentColor;
        if (currentBg) kwSpan.bg = currentBg;
        if (currentBold) kwSpan.bold = true;
        if (currentDim) kwSpan.dim = true;
        if (currentItalic) kwSpan.italic = true;
        if (currentUnderline) kwSpan.underline = true;
        spans.push(kwSpan);
        subLast = kwMatch.index + kwText.length;
      }
      if (subLast < text.length) {
        const chunkText = text.slice(subLast);
        const span: AnsiSpan = { text: chunkText };
        if (currentColor) span.color = currentColor;
        if (currentBg) span.bg = currentBg;
        if (currentBold) span.bold = true;
        if (currentDim) span.dim = true;
        if (currentItalic) span.italic = true;
        if (currentUnderline) span.underline = true;
        if (span.color === 'ansi-red' || span.color === 'ansi-bright-red') {
          span.tone = 'error';
          hasError = true;
        } else if (span.color === 'ansi-yellow' || span.color === 'ansi-bright-yellow') {
          span.tone = 'warn';
          hasWarn = true;
        }
        spans.push(span);
      }
    };

    while ((match = re.exec(rawLine)) !== null) {
      if (match.index > lastIndex) {
        pushChunk(rawLine.slice(lastIndex, match.index));
      }
      const codes = match[1]
        ? match[1].split(';').map((c) => parseInt(c, 10)).filter((n) => !isNaN(n))
        : [0];
      if (codes.length === 0) codes.push(0);

      for (const code of codes) {
        if (code === 0) {
          currentColor = undefined;
          currentBg = undefined;
          currentBold = undefined;
          currentDim = undefined;
          currentItalic = undefined;
          currentUnderline = undefined;
        } else if (code === 1) {
          currentBold = true;
        } else if (code === 2) {
          currentDim = true;
        } else if (code === 3) {
          currentItalic = true;
        } else if (code === 4) {
          currentUnderline = true;
        } else if (code === 22) {
          currentBold = undefined;
          currentDim = undefined;
        } else if (code === 23) {
          currentItalic = undefined;
        } else if (code === 24) {
          currentUnderline = undefined;
        } else if (code === 39) {
          currentColor = undefined;
        } else if (code === 49) {
          currentBg = undefined;
        } else if (FG_MAP[code]) {
          currentColor = FG_MAP[code];
        } else if (BG_MAP[code]) {
          currentBg = BG_MAP[code];
        }
      }
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < rawLine.length) {
      pushChunk(rawLine.slice(lastIndex));
    }

    if (spans.length === 0) {
      spans.push({ text: '' });
    }

    const level = hasError ? 'error' : hasWarn ? 'warn' : null;
    result.push({
      n: lineIndex + 1,
      spans,
      level
    });
  }

  return result;
}
