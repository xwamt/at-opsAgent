<script setup lang="ts">
import { computed } from 'vue';
import LogViewer from './LogViewer.vue';

const props = defineProps<{
  job: string;
  build?: number | string;
  result: string;
  durationMs?: number;
  logTail?: string;
  logUri?: string;
  logTruncated?: boolean;
}>();

/** 结果三色 + 文字（不只靠颜色）。 */
const RESULT_META: Record<string, { icon: string; label: string; cls: string }> = {
  building: { icon: '●', label: '构建中', cls: 'pipe__result--building' },
  success: { icon: '✓', label: '成功', cls: 'pipe__result--success' },
  failure: { icon: '✗', label: '失败', cls: 'pipe__result--failure' },
  unstable: { icon: '△', label: '不稳定', cls: 'pipe__result--unstable' },
  aborted: { icon: '⊘', label: '已中止', cls: 'pipe__result--aborted' }
};

const result = computed(() => {
  const key = String(props.result ?? '').toLowerCase();
  return RESULT_META[key] ?? { icon: '?', label: props.result || '未知', cls: 'pipe__result--aborted' };
});

const duration = computed(() => {
  const ms = props.durationMs;
  if (ms === undefined || ms === null) {
    return '';
  }
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}min`;
});
</script>

<template>
  <section class="pipe">
    <div class="pipe__row">
      <span aria-hidden="true">⛓</span>
      <span class="pipe__job ops-mono" :title="props.job">{{ props.job }}</span>
      <span v-if="props.build !== undefined" class="pipe__build ops-mono">#{{ props.build }}</span>
      <span class="pipe__spacer"></span>
      <span class="pipe__result" :class="result.cls">
        <span aria-hidden="true">{{ result.icon }}</span>{{ result.label }}
      </span>
      <span v-if="duration" class="ops-muted ops-mono">{{ duration }}</span>
    </div>
    <LogViewer
      v-if="props.logTail || props.logUri"
      class="pipe__log"
      :text="props.logTail"
      :uri="props.logUri"
      :truncated="props.logTruncated"
    />
  </section>
</template>

<style scoped>
.pipe {
  min-width: 0;
}

.pipe__row {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 1.5);
  min-width: 0;
  font-size: calc(var(--ops-font-size) - 1px);
}

.pipe__job {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.pipe__build {
  color: var(--ops-muted);
}

.pipe__spacer {
  flex: 1;
}

.pipe__result {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
  font-size: calc(var(--ops-font-size) - 2px);
}

.pipe__result--building {
  color: var(--ops-accent);
}

.pipe__result--success {
  color: var(--ops-healthy);
}

.pipe__result--failure {
  color: var(--ops-crit);
}

.pipe__result--unstable {
  color: var(--ops-warn);
}

.pipe__result--aborted {
  color: var(--ops-pending);
}

.pipe__log {
  margin-top: var(--ops-density);
}
</style>
