import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/webview-chat/lib/markdown';

describe('renderMarkdown', () => {
  it('source # hi → html 含 h1', () => {
    expect(renderMarkdown('# hi')).toMatch(/<h1[^>]*>hi<\/h1>/);
  });

  it('流式仍渲染 markdown，但无 hljs', () => {
    const src = '**粗体**\n\n```javascript\nconst x = 1;\n```\n';
    const streaming = renderMarkdown(src, true);
    expect(streaming).toContain('<strong>');
    expect(streaming).not.toContain('hljs');
  });

  it('finalize 的 js fence 有 hljs-keyword', () => {
    const html = renderMarkdown('```javascript\nconst x = 1;\n```\n', false);
    expect(html).toContain('hljs-keyword');
  });

  it('html:false：原始 HTML 按文本转义', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('MarkdownBlock.vue 约束', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'src/webview-chat/components/MarkdownBlock.vue'),
    'utf8'
  );

  it('streaming 可选 prop；copy 按钮逻辑仍在 mounted/updated', () => {
    expect(src).toContain('streaming?: boolean');
    expect(src).toContain('onMounted(bindCopyButtons)');
    expect(src).toContain('onUpdated(bindCopyButtons)');
    expect(src).toContain('ops-copy-btn');
  });

  it('高亮走 core+白名单，不是 highlight.js 全量包', () => {
    const lib = readFileSync(path.join(process.cwd(), 'src/webview-chat/lib/markdown.ts'), 'utf8');
    expect(lib).toContain("highlight.js/lib/core");
    expect(lib).not.toMatch(/from 'highlight\.js'/);
    expect(lib).toContain("highlight.js/lib/languages/javascript");
    expect(lib).toContain("highlight.js/lib/languages/json");
    expect(lib).toContain("highlight.js/lib/languages/bash");
    expect(lib).toContain("highlight.js/lib/languages/yaml");
    expect(lib).toContain("highlight.js/lib/languages/python");
    expect(lib).toContain("highlight.js/lib/languages/sql");
    expect(lib).toContain("highlight.js/lib/languages/diff");
    expect(lib).toContain("highlight.js/lib/languages/dockerfile");
    expect(lib).toContain("highlight.js/lib/languages/ini");
    expect(lib).toContain("highlight.js/lib/languages/nginx");
  });

  it('支持 SQL / Diff / Shell 别名的高亮渲染', () => {
    const sqlHtml = renderMarkdown('```sql\nSELECT * FROM users;\n```', false);
    expect(sqlHtml).toContain('hljs-keyword');
    expect(sqlHtml).toContain('SELECT');

    const diffHtml = renderMarkdown('```diff\n- old\n+ new\n```', false);
    expect(diffHtml).toContain('hljs-addition');

    const shHtml = renderMarkdown('```sh\necho 1\n```', false);
    expect(shHtml).toContain('hljs-built_in');
  });
});
