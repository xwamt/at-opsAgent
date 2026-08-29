import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { annotateLogLine, stripAnsi } from '../src/webview-chat/lib/ansi';

describe('stripAnsi', () => {
  it('剥 CSI SGR，保留正文', () => {
    expect(stripAnsi('\x1b[31mERROR\x1b[0m boom')).toBe('ERROR boom');
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('annotateLogLine', () => {
  it('error_rate=1 无 error span（词界，不整词 ERROR）', () => {
    const segs = annotateLogLine('error_rate=1');
    expect(segs.some((s) => s.tone === 'error')).toBe(false);
    expect(segs.map((s) => s.text).join('')).toBe('error_rate=1');
  });

  it('ERROR boom 有 error span', () => {
    const segs = annotateLogLine('ERROR boom');
    expect(segs.some((s) => s.tone === 'error' && s.text === 'ERROR')).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe('ERROR boom');
  });

  it('ANSI 红 ERROR strip 后仍有 error span，文本无 ESC', () => {
    const segs = annotateLogLine('\x1b[31mERROR\x1b[0m boom');
    expect(segs.map((s) => s.text).join('')).toBe('ERROR boom');
    expect(segs.some((s) => s.tone === 'error' && s.text === 'ERROR')).toBe(true);
    expect(segs.every((s) => !s.text.includes('\x1b') && !s.text.includes('\x1B'))).toBe(true);
  });

  it('WARN / WARNING 为 warn；FATAL / Exception / panic 为 error', () => {
    expect(annotateLogLine('WARN disk').some((s) => s.tone === 'warn' && s.text === 'WARN')).toBe(
      true
    );
    expect(annotateLogLine('WARNING late').some((s) => s.tone === 'warn')).toBe(true);
    expect(annotateLogLine('FATAL oom').some((s) => s.tone === 'error' && s.text === 'FATAL')).toBe(
      true
    );
    expect(annotateLogLine('java.lang.Exception at').some((s) => s.text === 'Exception')).toBe(
      true
    );
    expect(annotateLogLine('panic: nil').some((s) => s.tone === 'error' && s.text === 'panic')).toBe(
      true
    );
  });
});

describe('LogViewer.vue 模板', () => {
  it('关键词走 logv__kw span；行 class 可保留作边框', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/webview-chat/components/LogViewer.vue'),
      'utf8'
    );
    expect(src).toContain("seg.tone ? 'logv__kw logv__kw--' + seg.tone");
    expect(src).toContain('annotateLogLine');
    expect(src).not.toContain('logv__line--error .logv__text');
  });
});
