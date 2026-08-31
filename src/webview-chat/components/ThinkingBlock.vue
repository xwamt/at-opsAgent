<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { TranscriptItem } from '../../protocol/host-protocol';
import { t, tf } from '../i18n';
import { useCopiedFlag } from '../lib/clipboard';
import { formatThinkingDurationMs, visibleUntrustedQuotes } from '../store-helpers';
import MarkdownBlock from './MarkdownBlock.vue';
import UntrustedQuotes from './UntrustedQuotes.vue';

const props = defineProps<{
  item: Extract<TranscriptItem, { kind: 'thinking' }>;
}>();

const isThinking = computed(() => props.item.durationMs == null);

// 默认折叠，防止大模型巨幅长思维链刷屏，用户可点击标题展开
const expanded = ref(false);

const elapsedMs = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer() {
  stopTimer();
  const start = Date.now();
  elapsedMs.value = 0;
  timer = setInterval(() => {
    elapsedMs.value = Date.now() - start;
  }, 100);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => isThinking.value,
  (thinking) => {
    if (thinking) {
      startTimer();
    } else {
      stopTimer();
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  stopTimer();
});

const { copied, copy } = useCopiedFlag();

const thinkingText = computed(() => {
  if (!props.item.steps || props.item.steps.length === 0) {
    return '';
  }
  return props.item.steps.join('\n\n').trim();
});

const durationText = computed(() => {
  if (isThinking.value) {
    const sec = (elapsedMs.value / 1000).toFixed(1);
    return `${sec}s`;
  }
  const duration = formatThinkingDurationMs(props.item.durationMs);
  return duration ? tf('thinkingDuration', { duration }) : t('thinkingInProgress');
});

const untrustedQuotes = computed(() => visibleUntrustedQuotes(props.item));

async function copyThought(): Promise<void> {
  if (thinkingText.value) {
    await copy(thinkingText.value);
  }
}

function toggleExpand(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="thinking-card" :class="{ 'thinking-card--active': isThinking, 'thinking-card--expanded': expanded }">
    <div
      class="thinking-card__head"
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      :aria-label="t('thinkingToggleAria')"
      @click="toggleExpand"
      @keydown.enter.prevent="toggleExpand"
      @keydown.space.prevent="toggleExpand"
    >
      <span
        class="codicon thinking-card__chevron"
        :class="expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"
        aria-hidden="true"
      ></span>
      <span
        class="codicon thinking-card__icon"
        :class="isThinking ? 'codicon-loading codicon-modifier-spin' : 'codicon-light-bulb'"
        aria-hidden="true"
      ></span>
      <span class="thinking-card__title">{{ isThinking ? t('thinkingInProgress') : t('thinkingTitle') }}</span>
      <span v-if="props.item.durationMs != null" class="thinking-card__badge ops-mono">
        {{ durationText }}
      </span>
      <span class="thinking-card__spacer"></span>
      <button
        v-if="thinkingText"
        type="button"
        class="ops-copy-btn thinking-card__copy"
        :class="{ 'ops-copy-btn--copied': copied }"
        :aria-label="copied ? t('copied') : t('copyAria')"
        :title="copied ? t('copied') : t('copy')"
        @click.stop="copyThought"
      >
        <span class="codicon" :class="copied ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
        <span v-if="copied">{{ t('copied') }}</span>
      </button>
    </div>

    <!-- 折叠展开区：思考中或展开时渲染推理 Markdown 步骤 -->
    <div v-if="expanded" class="thinking-card__body">
      <div v-if="thinkingText" class="thinking-card__content">
        <MarkdownBlock :source="thinkingText" :streaming="isThinking" />
        <span v-if="isThinking" class="thinking-card__caret" :aria-label="t('generating')">▍</span>
      </div>
      <p v-else-if="isThinking" class="thinking-card__empty ops-muted">
        <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
        {{ t('thinkingInProgress') }}
      </p>
      <UntrustedQuotes v-if="untrustedQuotes.length > 0" :quotes="untrustedQuotes" />
    </div>
  </div>
</template>

<style scoped>
.thinking-card {
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ops-border);
  border-left: 3px solid var(--ops-muted);
  border-radius: var(--ops-radius);
  background: color-mix(in srgb, var(--ops-bg) 95%, var(--ops-fg) 5%);
  margin: var(--ops-space-1) 0;
  transition: border-color 180ms ease, background 180ms ease;
  overflow: hidden;
}

.thinking-card--active {
  border-left-color: var(--ops-accent);
  background: color-mix(in srgb, var(--ops-bg) 90%, var(--ops-accent) 10%);
}

.thinking-card__head {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: 6px var(--ops-space-2);
  cursor: pointer;
  user-select: none;
  font-size: var(--ops-font-xs);
  color: var(--ops-muted);
}

.thinking-card__head:hover {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
}

.thinking-card__head:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.thinking-card__chevron {
  font-size: 11px;
  flex: 0 0 auto;
}

.thinking-card__icon {
  font-size: 12px;
  flex: 0 0 auto;
}

.thinking-card--active .thinking-card__icon {
  color: var(--ops-accent);
}

.thinking-card__title {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.thinking-card__badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ops-fg) 10%, transparent);
  color: var(--ops-muted);
}

.thinking-card__spacer {
  flex: 1;
}

.thinking-card__copy {
  opacity: 0;
  padding: 2px 4px;
}

.thinking-card:hover .thinking-card__copy,
.thinking-card__copy:focus-visible,
.thinking-card__copy.ops-copy-btn--copied {
  opacity: 1;
}

.thinking-card__body {
  padding: var(--ops-space-2) var(--ops-space-3);
  border-top: 1px dashed var(--ops-border);
  font-size: var(--ops-font-sm);
  color: var(--ops-fg);
  line-height: 1.6;
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.thinking-card__content {
  font-style: normal;
  opacity: 0.92;
}

.thinking-card__content :deep(p) {
  margin: 0.4em 0;
}

.thinking-card__caret {
  display: inline-block;
  color: var(--ops-accent);
  animation: thinking-blink 800ms infinite;
  margin-left: 2px;
}

@keyframes thinking-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.thinking-card__empty {
  margin: 4px 0;
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}
</style>
