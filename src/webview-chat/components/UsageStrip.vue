<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import { formatCompactUsage, formatUsageTooltip, usagePercent } from '../store-helpers';

const store = useOpsStore();

const compactText = computed(() => formatCompactUsage(store.usage));
const tooltipText = computed(() => formatUsageTooltip(store.usage));
const contextPct = computed(() => usagePercent(store.usage));
const visible = computed(() => compactText.value !== null);
</script>

<template>
  <div v-if="visible" class="usage-strip" :title="tooltipText" :aria-label="t('usageStripAria')">
    <div
      v-if="contextPct !== null"
      class="usage-strip__bar"
      role="progressbar"
      :aria-label="t('usageAria')"
      :aria-valuenow="contextPct"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span
        class="usage-strip__fill"
        :class="{
          'usage-strip__fill--warn': contextPct >= 80 && contextPct < 95,
          'usage-strip__fill--crit': contextPct >= 95
        }"
        :style="{ width: contextPct + '%' }"
      ></span>
    </div>
    <span class="usage-strip__text ops-muted">{{ compactText }}</span>
  </div>
</template>

<style scoped>
.usage-strip {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: var(--ops-space-1) var(--ops-space-3) 0;
  min-width: 0;
}

.usage-strip__bar {
  flex: 0 0 48px;
  height: 4px;
  border-radius: 2px;
  background: var(--ops-hover-bg);
  overflow: hidden;
}

.usage-strip__fill {
  display: block;
  height: 100%;
  background: var(--ops-accent);
  border-radius: 2px;
  transition: width 200ms ease, background 200ms ease;
}

.usage-strip__fill--warn {
  background: var(--ops-warn);
}

.usage-strip__fill--crit {
  background: var(--ops-crit);
}

.usage-strip__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ops-font-xs);
}
</style>
