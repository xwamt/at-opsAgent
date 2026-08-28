<script setup lang="ts">
import { t } from '../i18n';

const props = defineProps<{
  quotes: string[];
}>();
</script>

<template>
  <!-- 不可信数据：全边框 + 徽标 + 文字说明，不允许只靠颜色暗示。
       仅渲染外部引用原文；思考步骤（CoT）永不进入本组件（pi hideThinkingBlock 恒开）。 -->
  <div class="untrusted" role="note" :aria-label="t('untrustedData')">
    <div class="untrusted__head">
      <span class="ops-badge untrusted__badge">⚠ {{ t('untrustedData') }}</span>
      <span class="untrusted__hint">{{ t('untrustedQuotesHint') }}</span>
    </div>
    <blockquote
      v-for="(quote, i) in props.quotes"
      :key="i"
      class="untrusted__quote ops-mono"
    >{{ quote }}</blockquote>
  </div>
</template>

<style scoped>
.untrusted {
  border: 1px solid var(--ops-warn);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
}

.untrusted__head {
  display: flex;
  align-items: baseline;
  gap: calc(var(--ops-density) * 1.5);
  flex-wrap: wrap;
}

.untrusted__badge {
  color: var(--ops-warn);
  font-weight: 600;
}

.untrusted__hint {
  color: var(--ops-warn);
  font-size: calc(var(--ops-font-size) - 2px);
}

.untrusted__quote {
  margin: var(--ops-density) 0 0;
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
  border-left: 2px solid var(--ops-warn);
  background: var(--ops-code-bg);
  color: var(--ops-muted);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
