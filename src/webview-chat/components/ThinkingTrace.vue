<script setup lang="ts">
import { ref } from 'vue';
import { t } from '../i18n';

const props = defineProps<{
  steps: string[];
  untrustedQuotes?: string[];
}>();

const expanded = ref(false);

function toggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <section class="thinking">
    <button
      type="button"
      class="thinking__toggle"
      :aria-expanded="expanded"
      @click="toggle"
    >
      <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      思考过程（{{ props.steps.length }} 步）
    </button>
    <div v-if="expanded" class="thinking__body">
      <ol class="thinking__steps">
        <li v-for="(step, i) in props.steps" :key="i">{{ step }}</li>
      </ol>
      <!-- 不可信数据：全边框 + 徽标 + 文字说明，不允许只靠颜色暗示 -->
      <div
        v-if="props.untrustedQuotes && props.untrustedQuotes.length"
        class="thinking__untrusted"
        role="note"
        :aria-label="t('untrustedData')"
      >
        <div class="thinking__untrusted-head">
          <span class="ops-badge thinking__untrusted-badge">⚠ {{ t('untrustedData') }}</span>
          <span class="thinking__untrusted-hint">{{ t('untrustedQuotesHint') }}</span>
        </div>
        <blockquote
          v-for="(quote, i) in props.untrustedQuotes"
          :key="i"
          class="thinking__quote ops-mono"
        >{{ quote }}</blockquote>
      </div>
    </div>
  </section>
</template>

<style scoped>
.thinking__toggle {
  background: transparent;
  border: none;
  color: var(--ops-muted);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  gap: var(--ops-density);
  align-items: center;
  font-size: calc(var(--ops-font-size) - 1px);
}

.thinking__toggle:hover {
  color: var(--ops-fg);
}

.thinking__toggle:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.thinking__body {
  border-left: 2px solid var(--ops-border);
  margin: var(--ops-density) 0 0 3px;
  padding-left: calc(var(--ops-density) * 2);
}

.thinking__steps {
  margin: 0;
  padding-left: calc(var(--ops-density) * 4);
  color: var(--ops-muted);
  font-size: calc(var(--ops-font-size) - 1px);
  line-height: 1.6;
  white-space: pre-wrap;
}

/* 不可信数据区：整块警示边框，与普通思考步骤视觉强隔离 */
.thinking__untrusted {
  margin-top: var(--ops-density);
  border: 1px solid var(--ops-warn);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
}

.thinking__untrusted-head {
  display: flex;
  align-items: baseline;
  gap: calc(var(--ops-density) * 1.5);
  flex-wrap: wrap;
}

.thinking__untrusted-badge {
  color: var(--ops-warn);
  font-weight: 600;
}

.thinking__untrusted-hint {
  color: var(--ops-warn);
  font-size: calc(var(--ops-font-size) - 2px);
}

.thinking__quote {
  margin: var(--ops-density) 0 0;
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
  border-left: 2px solid var(--ops-warn);
  background: var(--ops-code-bg);
  color: var(--ops-muted);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
