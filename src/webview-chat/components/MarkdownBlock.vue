<script setup lang="ts">
/**
 * Markdown 渲染（P0-E / Plan 10）：markdown-it 单例 html:false ⇒ 原始 HTML
 * 一律按文本转义；linkify 开启方便贴 URL。样式在 ops-tokens.css 的 .ops-md
 * 命名空间（v-html 内容不吃 scoped 样式）。代码块底色 --vscode-textCodeBlock-background。
 *
 * streaming===true 时只做 md 排版、不跑 highlight.js（finalize 后才上 hljs-*）。
 *
 * 代码块 hover 复制：不把 Vue 事件写进 v-html。fence 仍由 markdown-it 输出 pre，
 * mounted/updated 时清旧 .ops-copy-btn 再插入按钮，复制 pre.innerText（不是 HTML）。
 */
import { computed, onMounted, onUpdated, ref } from 'vue';
import { t } from '../i18n';
import { COPIED_FEEDBACK_MS, copyText } from '../lib/clipboard';
import { renderMarkdown } from '../lib/markdown';

const props = defineProps<{ source: string; streaming?: boolean }>();

const html = computed(() => renderMarkdown(props.source ?? '', !!props.streaming));
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

/* highlight.js：贴近 VS Code token，避免 github-dark 与 --vscode-editor-background 打架 */
.ops-md .hljs-keyword,
.ops-md .hljs-selector-tag,
.ops-md .hljs-literal {
  color: var(--vscode-symbolIcon-keywordForeground, #569cd6);
}
.ops-md .hljs-string,
.ops-md .hljs-attr {
  color: var(--vscode-symbolIcon-stringForeground, #ce9178);
}
.ops-md .hljs-number {
  color: var(--vscode-symbolIcon-numberForeground, #b5cea8);
}
.ops-md .hljs-comment,
.ops-md .hljs-quote {
  color: var(--vscode-editorLineNumber-foreground, #6a9955);
}
.ops-md .hljs-title,
.ops-md .hljs-function {
  color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
}
.ops-md .hljs-built_in,
.ops-md .hljs-type,
.ops-md .hljs-class {
  color: var(--vscode-symbolIcon-classForeground, #4ec9b0);
}
.ops-md .hljs-section {
  color: var(--vscode-symbolIcon-classForeground, #4ec9b0);
  font-weight: 600;
}
.ops-md .hljs-addition {
  color: var(--vscode-gitDecoration-addedResourceForeground, var(--ops-healthy, #3fb950));
}
.ops-md .hljs-deletion {
  color: var(--vscode-gitDecoration-deletedResourceForeground, var(--ops-crit, #f85149));
}
.ops-md .hljs-variable,
.ops-md .hljs-template-variable {
  color: var(--vscode-symbolIcon-variableForeground, #9cdcfe);
}
</style>
