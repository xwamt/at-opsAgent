<script setup lang="ts">
/**
 * Markdown 渲染（P0-E）：markdown-it，html:false ⇒ 原始 HTML 一律按文本转义，
 * 不需要额外消毒库；linkify 开启方便贴 URL。样式在 ops-tokens.css 的 .ops-md
 * 命名空间（v-html 内容不吃 scoped 样式）。代码块底色 --vscode-textCodeBlock-background。
 */
import MarkdownIt from 'markdown-it';
import { computed } from 'vue';

const props = defineProps<{ source: string }>();

const md = new MarkdownIt({
  html: false, // 禁 raw html：LLM 输出中的 <script> 等按文本渲染
  linkify: true,
  breaks: false
});

// 链接加 title（悬浮可见完整 URL）；webview 内点击由 VS Code 接管外开
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

const html = computed(() => md.render(props.source ?? ''));
</script>

<template>
  <div class="ops-md" v-html="html"></div>
</template>
