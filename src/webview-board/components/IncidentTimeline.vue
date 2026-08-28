<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import HostSessionChip from '../../webview-chat/components/HostSessionChip.vue';
import PipelineStatus from '../../webview-chat/components/PipelineStatus.vue';
import { confidenceClass, confidenceLabel } from '../../webview-chat/confidence';
import { t } from '../../webview-chat/i18n';
import { bt, dayLabel, formatAbsolute, formatTimeCell } from '../i18n';
import { useBoardStore, type TimelineEventView } from '../store';

const store = useBoardStore();

const SEVERITY_META: Record<TimelineEventView['severity'], { icon: string; label: string; cls: string }> = {
  info: { icon: '○', label: 'info', cls: 'tl__sev--info' },
  warn: { icon: '△', label: 'warn', cls: 'tl__sev--warn' },
  crit: { icon: '✗', label: 'crit', cls: 'tl__sev--crit' }
};

/** 相对时间的「现在」：30s 一跳，避免时间列停在挂载瞬间。 */
const now = ref(Date.now());
let timer: number | undefined;

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (timer !== undefined) {
    window.clearInterval(timer);
  }
});
</script>

<template>
  <div class="tl" role="log" :aria-label="bt('timelineAria')">
    <div v-if="store.events.length === 0" class="tl__empty ops-muted">{{ t('boardEmpty') }}</div>
    <div v-else-if="store.filtered.length === 0" class="tl__empty">
      <p class="ops-muted tl__empty-text">{{ bt('noMatch') }}</p>
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.clearFilters()">
        {{ bt('clearFilters') }}
      </button>
    </div>
    <template v-else>
      <section v-for="group in store.groups" :key="group.key" class="tl__group">
        <h3 class="tl__day ops-muted">{{ dayLabel(group.key, now) }}</h3>
        <ol class="tl__list">
          <li v-for="event in group.events" :key="event.id" class="tl__row">
            <time
              class="tl__time ops-mono ops-muted"
              :datetime="new Date(event.ts).toISOString()"
              :title="formatAbsolute(event.ts)"
            >{{ formatTimeCell(event.ts, now) }}</time>
            <span class="tl__sev" :class="SEVERITY_META[event.severity].cls">
              <span aria-hidden="true">{{ SEVERITY_META[event.severity].icon }}</span>
              {{ SEVERITY_META[event.severity].label }}
            </span>
            <div class="tl__main">
              <div class="tl__title">
                {{ event.title }}
                <span v-if="event.status" class="ops-badge ops-muted tl__status">{{ event.status }}</span>
                <span
                  v-if="event.confidence"
                  class="ops-badge tl__confidence"
                  :class="confidenceClass(event.confidence)"
                >{{ confidenceLabel(event.confidence) }}</span>
              </div>
              <div class="tl__meta ops-muted ops-mono">
                <span v-if="event.incidentId">{{ event.incidentId }}</span>
                <span v-if="event.kind">{{ event.kind }}</span>
              </div>
              <PipelineStatus
                v-if="event.pipeline"
                class="tl__pipeline"
                :job="event.pipeline.job"
                :build="event.pipeline.build"
                :result="event.pipeline.result"
              />
              <div v-if="event.host" class="tl__host">
                <HostSessionChip
                  :plugin-id="event.host.pluginId"
                  :label="event.host.label"
                  :connected="event.host.connected"
                />
              </div>
              <pre v-if="event.detail" class="ops-codeblock tl__detail">{{ event.detail.slice(0, 4096) }}</pre>
            </div>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>

<style scoped>
.tl {
  height: 100%;
  overflow-y: auto;
}

.tl__empty {
  padding: calc(var(--ops-density) * 6) 0;
  text-align: center;
}

.tl__empty-text {
  margin: 0 0 calc(var(--ops-density) * 2);
}

.tl__day {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0;
  padding: calc(var(--ops-density) - 2px) calc(var(--ops-density) * 2);
  background: var(--ops-bg);
  border-bottom: 1px solid var(--ops-border);
  font-size: calc(var(--ops-font-size) - 2px);
  font-weight: 600;
  letter-spacing: 0.4px;
}

.tl__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tl__row {
  display: flex;
  gap: calc(var(--ops-density) * 2);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-bottom: 1px solid var(--ops-border);
  align-items: baseline;
}

.tl__row:hover {
  background: var(--ops-hover-bg);
}

.tl__time {
  flex: 0 0 84px;
  font-size: calc(var(--ops-font-size) - 2px);
  white-space: nowrap;
  cursor: default;
}

.tl__sev {
  flex: 0 0 42px;
  display: inline-flex;
  gap: 3px;
  align-items: center;
  font-size: calc(var(--ops-font-size) - 2px);
  white-space: nowrap;
}

.tl__sev--info {
  color: var(--ops-pending);
}

.tl__sev--warn {
  color: var(--ops-warn);
}

.tl__sev--crit {
  color: var(--ops-crit);
}

.tl__main {
  flex: 1;
  min-width: 0;
}

.tl__title {
  line-height: 1.4;
  word-break: break-word;
}

.tl__status {
  margin-left: var(--ops-density);
  font-size: calc(var(--ops-font-size) - 3px);
}

.tl__meta {
  display: flex;
  gap: calc(var(--ops-density) * 2);
  font-size: calc(var(--ops-font-size) - 3px);
}

.tl__confidence {
  margin-left: var(--ops-density);
  font-size: calc(var(--ops-font-size) - 3px);
}

.tl__pipeline {
  margin-top: var(--ops-density);
}

.tl__host {
  margin-top: var(--ops-density);
}

.tl__detail {
  margin-top: var(--ops-density);
  max-height: 120px;
}
</style>
