<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { annotateLogLine, type LogSegment } from '../lib/ansi';
import { postEnvelope } from '../vscode-api';

const props = defineProps<{
  text?: string;
  uri?: string;
  truncated?: boolean;
  title?: string;
}>();

/** 显示上限 64KB / 500 行；完整内容永远走「在编辑器打开」，禁止 256KB dump。 */
const BYTE_CAP = 64 * 1024;
const LINE_CAP = 500;

const raw = computed(() => props.text ?? '');

const clipped = computed(
  () =>
    Boolean(props.truncated) ||
    raw.value.length > BYTE_CAP ||
    raw.value.split('\n').length > LINE_CAP
);

interface LogLine {
  n: number;
  segs: LogSegment[];
  level: 'error' | 'warn' | null;
}

function levelOf(segs: LogSegment[]): LogLine['level'] {
  if (segs.some((s) => s.tone === 'error')) {
    return 'error';
  }
  if (segs.some((s) => s.tone === 'warn')) {
    return 'warn';
  }
  return null;
}

const lines = computed<LogLine[]>(() =>
  raw.value
    .slice(0, BYTE_CAP)
    .split('\n')
    .slice(0, LINE_CAP)
    .map((text, i) => {
      const segs = annotateLogLine(text);
      return { n: i + 1, segs, level: levelOf(segs) };
    })
);

function openInEditor(): void {
  postEnvelope('log/open', { uri: props.uri });
}
</script>

<template>
  <section class="logv">
    <header v-if="props.title" class="logv__title ops-muted ops-mono">{{ props.title }}</header>
    <div v-if="lines.length" class="logv__block" role="log" :aria-label="t('logAria')">
      <div
        v-for="line in lines"
        :key="line.n"
        class="logv__line"
        :class="line.level ? 'logv__line--' + line.level : ''"
      >
        <span class="logv__num" aria-hidden="true">{{ line.n }}</span>
        <span class="logv__text">
          <span
            v-for="(seg, i) in line.segs"
            :key="i"
            :class="seg.tone ? 'logv__kw logv__kw--' + seg.tone : undefined"
            >{{ seg.text }}</span
          >
        </span>
      </div>
    </div>
    <div v-else class="logv__empty ops-muted">{{ t('logEmpty') }}</div>
    <div v-if="clipped" class="logv__truncated">
      <button
        v-if="props.uri"
        type="button"
        class="ops-btn ops-btn--secondary logv__open"
        @click="openInEditor"
      >
        {{ t('truncatedOpenEditor') }}
      </button>
      <template v-else>
        <span class="logv__flag">{{ t('truncated') }}</span>
        <span class="ops-muted">{{ t('truncatedNotSent') }}</span>
      </template>
    </div>
  </section>
</template>

<style scoped>
.logv {
  min-width: 0;
}

.logv__title {
  font-size: calc(var(--ops-font-size) - 2px);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logv__block {
  font-family: var(--ops-mono);
  font-size: calc(var(--ops-font-size) - 1px);
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, var(--ops-fg));
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: calc(var(--ops-density) * 1.5);
  max-height: 220px;
  overflow: auto;
  line-height: 1.45;
}

.logv__line {
  display: flex;
  gap: calc(var(--ops-density) * 2);
  min-width: 0;
}

.logv__num {
  flex: 0 0 auto;
  min-width: 3ch;
  text-align: right;
  color: var(--ops-muted);
  user-select: none;
  opacity: 0.7;
}

.logv__text {
  white-space: pre-wrap;
  word-break: break-all;
  min-width: 0;
}

/* 行 class 只做左边框，关键词高亮走 span（避免整行前景色误伤 error_rate） */
.logv__line--error {
  border-left: 2px solid var(--ops-crit);
  padding-left: 4px;
}

.logv__line--warn {
  border-left: 2px solid var(--ops-warn);
  padding-left: 4px;
}

.logv__kw--error {
  color: var(--ops-crit);
}

.logv__kw--warn {
  color: var(--ops-warn);
}

.logv__empty {
  font-size: calc(var(--ops-font-size) - 1px);
}

.logv__truncated {
  margin-top: var(--ops-density);
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 2);
  font-size: calc(var(--ops-font-size) - 2px);
}

.logv__flag {
  color: var(--ops-warn);
  border: 1px solid var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
}

.logv__open {
  padding: 0 calc(var(--ops-density) * 1.5);
  font-size: calc(var(--ops-font-size) - 2px);
  line-height: 1.7;
}
</style>
