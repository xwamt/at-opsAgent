<script setup lang="ts">
/**
 * Markdown 渲染（P0-E）：markdown-it，html:false ⇒ 原始 HTML 一律按文本转义，
 * 不需要额外消毒库；linkify 开启方便贴 URL。样式在 ops-tokens.css 的 .ops-md
 * 命名空间（v-html 内容不吃 scoped 样式）。代码块底色 --vscode-textCodeBlock-background。
 *
 * 代码块 hover 复制：不把 Vue 事件写进 v-html。fence 仍由 markdown-it 输出 pre，
 * mounted/updated 时清旧 .ops-copy-btn 再插入按钮，复制 pre.innerText（不是 HTML）。
 */
import MarkdownIt from 'markdown-it';
import { computed, onMounted, onUpdated, ref } from 'vue';
import { t } from '../i18n';
import { COPIED_FEEDBACK_MS, copyText } from '../lib/clipboard';

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
const root = ref<HTMLElement | null>(null);

function ensureFence(pre: HTMLElement): HTMLElement {
  const parent = pre.parentElement;
  if (parent?.classList.contains('ops-md-fence')) {
    return parent;
  }
  const wrap = document.createElement('div');
  wrap.className = 'ops-md-fence';
  parent?.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  return wrap;
}

function bindCopyButtons(): void {
  const host = root.value;
  if (!host) {
    return;
  }
  host.querySelectorAll('.ops-copy-btn').forEach((btn) => btn.remove());
  host.querySelectorAll('pre.ops-codeblock, .ops-md pre, pre').forEach((node) => {
    const pre = node as HTMLElement;
    const fence = ensureFence(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ops-copy-btn';
    btn.setAttribute('aria-label', t('copyAria'));
    btn.title = t('copy');
    const icon = document.createElement('span');
    icon.className = 'codicon codicon-copy';
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      void onCopyClick(btn, icon, pre);
    });
    fence.appendChild(btn);
  });
}

async function onCopyClick(btn: HTMLButtonElement, icon: HTMLElement, pre: HTMLElement): Promise<void> {
  await copyText(pre.innerText);
  icon.className = 'codicon codicon-check';
  btn.classList.add('ops-copy-btn--copied');
  btn.setAttribute('aria-label', t('copied'));
  let label = btn.querySelector('.ops-copy-btn__label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'ops-copy-btn__label';
    btn.appendChild(label);
  }
  label.textContent = t('copied');
  const prev = (btn as HTMLButtonElement & { _opsCopyTimer?: ReturnType<typeof setTimeout> })._opsCopyTimer;
  if (prev !== undefined) {
    clearTimeout(prev);
  }
  (btn as HTMLButtonElement & { _opsCopyTimer?: ReturnType<typeof setTimeout> })._opsCopyTimer = setTimeout(() => {
    icon.className = 'codicon codicon-copy';
    btn.classList.remove('ops-copy-btn--copied');
    btn.setAttribute('aria-label', t('copyAria'));
    label?.remove();
  }, COPIED_FEEDBACK_MS);
}

onMounted(bindCopyButtons);
onUpdated(bindCopyButtons);
</script>

<template>
  <div ref="root" class="ops-md" v-html="html"></div>
</template>

<style>
/* v-html 内容不吃 scoped：fence 包装与复制钮必须非 scoped */
.ops-md-fence {
  position: relative;
}

.ops-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--ops-radius, 4px);
  background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 80%, transparent);
  color: var(--ops-muted, inherit);
  cursor: pointer;
  opacity: 0;
  flex: 0 0 auto;
  font-size: calc(var(--ops-font-size, 13px) - 2px);
  line-height: 1;
  white-space: nowrap;
}

.ops-md-fence > .ops-copy-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
}

.ops-copy-btn:hover {
  color: var(--ops-fg, inherit);
  background: var(--ops-toolbar-hover-bg, rgba(127, 127, 127, 0.2));
}

.ops-copy-btn:focus-visible,
.ops-md-fence:hover > .ops-copy-btn,
.ops-copy-btn--copied {
  opacity: 1;
}

.ops-copy-btn:focus-visible {
  outline: 1px solid var(--ops-accent, #3794ff);
  outline-offset: 1px;
}

.ops-copy-btn--copied {
  width: auto;
  padding: 0 6px;
}
</style>
