/**
 * Markdown 渲染单例（Plan 10）：html:false；highlight.js 只注册
 * javascript / json / bash / yaml / python / promql。流式时不高亮（未闭合 fence
 * 仍走 markdown-it 默认 code）。不要 mermaid / shiki / KaTeX。
 *
 * highlight.js 只处理 fence 的代码文本（markdown-it 已抽出），返回的
 * span HTML 是高亮器转义后的，不是 LLM 原文 HTML。
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import nginx from 'highlight.js/lib/languages/nginx';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('nginx', nginx);

hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['docker'], { languageName: 'dockerfile' });
hljs.registerAliases(['js', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

/** PromQL：函数、duration 字面量、label matcher（OPT-9，~30 行自定义 language）。 */
hljs.registerLanguage('promql', (hljs) => {
  const DURATION = /\d+(?:ms|s|m|h|d|w|y)/;
  return {
    name: 'PromQL',
    aliases: ['prometheus'],
    case_insensitive: true,
    keywords: {
      keyword:
        'rate irate increase delta histogram_quantile histogram_avg sum avg min max count count_values ' +
        'stddev stdvar topk bottomk quantile label_replace label_join predict_linear absent absent_over_time ' +
        'clamp clamp_min clamp_max changes resets deriv holt_winters',
      literal: 'true false'
    },
    contains: [
      hljs.COMMENT('#', '$'),
      {
        className: 'string',
        begin: /"/,
        end: /"/,
        contains: [hljs.BACKSLASH_ESCAPE]
      },
      {
        className: 'number',
        begin: DURATION,
        relevance: 2
      },
      {
        className: 'attr',
        begin: /\{/,
        end: /\}/,
        contains: [
          { className: 'attr', begin: /[a-zA-Z_][\w]*/ },
          { className: 'string', begin: /"/, end: /"/ },
          { className: 'operator', begin: /[=~!]=?/ }
        ]
      },
      hljs.NUMBER_MODE
    ]
  };
});

function highlightCode(str: string, lang: string): string {
  const name = lang.trim();
  if (!name || !hljs.getLanguage(name)) {
    return '';
  }
  try {
    return hljs.highlight(str, { language: name }).value;
  } catch {
    return '';
  }
}

function attachLinkTitles(md: MarkdownIt): void {
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href');
    if (href && !tokens[idx].attrGet('title')) {
      tokens[idx].attrSet('title', href);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
}

function createMarkdown(highlight: boolean): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    ...(highlight
      ? {
          highlight(str: string, lang: string): string {
            return highlightCode(str, lang);
          }
        }
      : {})
  });
  attachLinkTitles(md);
  return md;
}

/** finalize 后启用 highlight；流式共用解析器但不高亮。 */
const mdFinal = createMarkdown(true);
const mdStreaming = createMarkdown(false);

export function renderMarkdown(source: string, streaming = false): string {
  return (streaming ? mdStreaming : mdFinal).render(source ?? '');
}
