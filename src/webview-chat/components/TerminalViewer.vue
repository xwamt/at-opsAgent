<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { t, tf } from '../i18n';
import { useCopiedFlag } from '../lib/clipboard';
import { parseAnsiToLines, type AnsiLine } from '../lib/ansi';
import { postEnvelope } from '../vscode-api';

const props = withDefaults(
  defineProps<{
    text?: string;
    isRunning?: boolean;
    exitCode?: number;
    uri?: string;
    truncated?: boolean;
    title?: string;
    maxHeight?: string;
  }>(),
  {
    text: '',
    isRunning: false,
    maxHeight: '260px'
  }
);

const scrollContainer = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

const raw = computed(() => props.text ?? '');

const lines = computed<AnsiLine[]>(() => parseAnsiToLines(raw.value));

const lineCountText = computed(() => tf('terminalLines', { count: lines.value.length }));

const { copied, copy } = useCopiedFlag();

async function copyOutput(): Promise<void> {
  await copy(raw.value);
}

function openInEditor(): void {
  if (props.uri) {
    postEnvelope('log/open', { uri: props.uri });
  }
}

function scrollToBottom(): void {
  if (scrollContainer.value && autoScroll.value) {
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
  }
}

watch(
  () => [raw.value, props.isRunning],
  () => {
    if (autoScroll.value) {
      void nextTick(scrollToBottom);
    }
  },
  { immediate: true }
);

function toggleAutoScroll(): void {
  autoScroll.value = !autoScroll.value;
  if (autoScroll.value) {
    void nextTick(scrollToBottom);
  }
}
</script>

<template>
  <div class="terminal-win">
    <!-- 终端窗口顶栏 -->
    <div class="terminal-win__header">
      <div class="terminal-win__title-group">
        <span class="codicon codicon-terminal terminal-win__icon" aria-hidden="true"></span>
        <span class="terminal-win__title ops-mono">{{ props.title || t('terminalTitle') }}</span>
        <span v-if="lines.length" class="terminal-win__count ops-mono ops-muted">{{ lineCountText }}</span>
        <span v-if="props.isRunning" class="terminal-win__live-tag ops-mono">
          <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
          <span>{{ t('terminalRunning') }}</span>
        </span>
      </div>

      <div class="terminal-win__actions">
        <!-- 退出码徽标 -->
        <span
          v-if="props.exitCode !== undefined"
          class="terminal-win__exit-badge ops-mono"
          :class="props.exitCode === 0 ? 'terminal-win__exit-badge--ok' : 'terminal-win__exit-badge--err'"
        >
          exit: {{ props.exitCode }}
        </span>

        <!-- 自动贴底滚动切换 -->
        <button
          type="button"
          class="terminal-win__btn"
          :class="{ 'terminal-win__btn--active': autoScroll }"
          :title="t('terminalAutoScroll')"
          :aria-label="t('terminalAutoScroll')"
          @click="toggleAutoScroll"
        >
          <span class="codicon codicon-arrow-down" aria-hidden="true"></span>
        </button>

        <!-- 一键复制输出 -->
        <button
          type="button"
          class="terminal-win__btn ops-copy-btn"
          :class="{ 'ops-copy-btn--copied': copied }"
          :title="copied ? t('terminalCopiedOutput') : t('terminalCopyOutput')"
          :aria-label="copied ? t('terminalCopiedOutput') : t('terminalCopyOutput')"
          @click="copyOutput"
        >
          <span class="codicon" :class="copied ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
          <span v-if="copied">{{ t('copied') }}</span>
        </button>
      </div>
    </div>

    <!-- 终端内容视口 -->
    <div
      ref="scrollContainer"
      class="terminal-win__body ops-mono"
      :style="{ maxHeight: props.maxHeight }"
      role="region"
      :aria-label="t('terminalTitle')"
    >
      <div v-if="lines.length" class="terminal-win__screen">
        <div
          v-for="line in lines"
          :key="line.n"
          class="terminal-win__line"
          :class="line.level ? 'terminal-win__line--' + line.level : ''"
        >
          <span class="terminal-win__num" aria-hidden="true">{{ line.n }}</span>
          <span class="terminal-win__content">
            <template v-for="(span, i) in line.spans" :key="i">
              <span
                class="terminal-win__span"
                :class="[
                  span.color,
                  span.bg,
                  {
                    'ansi-bold': span.bold,
                    'ansi-dim': span.dim,
                    'ansi-italic': span.italic,
                    'ansi-underline': span.underline,
                    'terminal-win__kw--error': span.tone === 'error',
                    'terminal-win__kw--warn': span.tone === 'warn'
                  }
                ]"
              >{{ span.text }}</span>
            </template>
          </span>
        </div>

        <!-- 运行中终端末行呼吸光标 -->
        <div v-if="props.isRunning" class="terminal-win__cursor-row">
          <span class="terminal-win__cursor" aria-hidden="true"></span>
        </div>
      </div>

      <!-- 空输出状态 -->
      <div v-else-if="!props.isRunning" class="terminal-win__empty ops-muted">
        {{ t('terminalNoOutput') }}
      </div>
      <div v-else class="terminal-win__empty ops-muted">
        <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
        <span>{{ t('terminalRunning') }}</span>
      </div>
    </div>

    <!-- 截断提示与在编辑器中打开入口 -->
    <div v-if="props.truncated || props.uri" class="terminal-win__footer">
      <button
        v-if="props.uri"
        type="button"
        class="ops-btn ops-btn--secondary terminal-win__open-btn"
        @click="openInEditor"
      >
        <span class="codicon codicon-go-to-file" aria-hidden="true"></span>
        {{ t('truncatedOpenEditor') }}
      </button>
      <span v-if="props.truncated" class="ops-muted ops-mono terminal-win__trunc-label">
        {{ t('truncated') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.terminal-win {
  display: flex;
  flex-direction: column;
  border-radius: var(--ops-radius, 6px);
  border: 1px solid var(--vscode-terminal-border, rgba(128, 128, 128, 0.3));
  background: var(--vscode-terminal-background, #18181b);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

/* 终端顶栏 */
.terminal-win__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-space-2);
  padding: 4px 8px;
  background: color-mix(in srgb, var(--ops-bg) 60%, black 40%);
  border-bottom: 1px solid color-mix(in srgb, var(--ops-border) 70%, black 30%);
  font-size: var(--ops-font-xs);
  user-select: none;
}

.terminal-win__title-group {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-width: 0;
}

.terminal-win__icon {
  font-size: 13px;
  color: var(--ops-accent);
}

.terminal-win__title {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--ops-fg);
}

.terminal-win__count {
  font-size: 11px;
  opacity: 0.75;
}

.terminal-win__live-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ops-accent);
  font-size: 11px;
}

.terminal-win__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.terminal-win__exit-badge {
  padding: 1px 6px;
  border-radius: var(--ops-radius-ctl);
  font-size: 11px;
  font-weight: 600;
}

.terminal-win__exit-badge--ok {
  background: color-mix(in srgb, var(--ops-healthy) 15%, transparent);
  color: var(--ops-healthy);
  border: 1px solid color-mix(in srgb, var(--ops-healthy) 30%, transparent);
}

.terminal-win__exit-badge--err {
  background: color-mix(in srgb, var(--ops-crit) 15%, transparent);
  color: var(--ops-crit);
  border: 1px solid color-mix(in srgb, var(--ops-crit) 30%, transparent);
}

.terminal-win__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--ops-radius-ctl);
  color: var(--ops-muted);
  padding: 2px 5px;
  font-size: 12px;
  cursor: pointer;
  transition: all 120ms ease;
}

.terminal-win__btn:hover {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
}

.terminal-win__btn--active {
  color: var(--ops-accent);
  background: color-mix(in srgb, var(--ops-accent) 15%, transparent);
  border-color: color-mix(in srgb, var(--ops-accent) 30%, transparent);
}

/* 终端屏幕视口 */
.terminal-win__body {
  padding: 8px 10px;
  background: var(--vscode-terminal-background, #18181b);
  overflow-x: auto;
  overflow-y: auto;
  font-size: var(--ops-font-sm);
  line-height: 1.45;
  color: var(--vscode-terminal-foreground, var(--ops-fg));
}

.terminal-win__screen {
  display: flex;
  flex-direction: column;
  min-width: 100%;
}

.terminal-win__line {
  display: flex;
  gap: var(--ops-space-2);
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.terminal-win__num {
  flex: 0 0 auto;
  min-width: 3ch;
  text-align: right;
  color: var(--ops-muted);
  opacity: 0.5;
  user-select: none;
}

.terminal-win__content {
  flex: 1 1 auto;
  min-width: 0;
}

.terminal-win__span {
  font-family: inherit;
}

.terminal-win__line--error {
  border-left: 2px solid var(--ops-crit);
  padding-left: 4px;
}

.terminal-win__line--warn {
  border-left: 2px solid var(--ops-warn);
  padding-left: 4px;
}

.terminal-win__kw--error {
  color: var(--ops-crit);
  font-weight: 600;
}

.terminal-win__kw--warn {
  color: var(--ops-warn);
  font-weight: 600;
}

.terminal-win__cursor-row {
  display: flex;
  margin-top: 2px;
  padding-left: calc(3ch + var(--ops-space-2));
}

.terminal-win__cursor {
  display: inline-block;
  width: 8px;
  height: 14px;
  background: var(--vscode-terminal-cursorForeground, var(--ops-accent));
  animation: term-blink 1s step-end infinite;
}

@keyframes term-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.terminal-win__empty {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: var(--ops-space-2) 0;
  font-size: var(--ops-font-xs);
  font-style: italic;
}

/* 终端底部辅助栏 */
.terminal-win__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-space-2);
  padding: 4px var(--ops-space-2);
  background: color-mix(in srgb, var(--ops-bg) 80%, black 20%);
  border-top: 1px solid var(--ops-border);
}

.terminal-win__open-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-space-1);
  padding: 2px 8px;
  font-size: 11px;
}

.terminal-win__trunc-label {
  font-size: 11px;
}
</style>
