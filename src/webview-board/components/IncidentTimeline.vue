<script setup lang="ts">
import HostSessionChip from '../../webview-chat/components/HostSessionChip.vue';
import PipelineStatus from '../../webview-chat/components/PipelineStatus.vue';
import { useBoardStore, type TimelineEventView } from '../store';

const store = useBoardStore();

const SEVERITY_META: Record<TimelineEventView['severity'], { icon: string; label: string; cls: string }> = {
  info: { icon: '○', label: 'info', cls: 'tl__sev--info' },
  warn: { icon: '△', label: 'warn', cls: 'tl__sev--warn' },
  crit: { icon: '✗', label: 'crit', cls: 'tl__sev--crit' }
};

/** 证据三态：颜色 + 文字（不只靠颜色）。 */
const CONFIDENCE_META: Record<
  NonNullable<TimelineEventView['confidence']>,
  { label: string; cls: string }
> = {
  confirmed: { label: '已确证 confirmed', cls: 'ops-confidence-confirmed' },
  hypothesis: { label: '假设 hypothesis', cls: 'ops-confidence-hypothesis' },
  pending: { label: '待定 pending', cls: 'ops-confidence-pending' }
};

function fmtTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
</script>

<template>
  <div class="tl" role="log" aria-label="事故时间线">
    <div v-if="store.sorted.length === 0" class="tl__empty ops-muted">尚无事故</div>
    <ol v-else class="tl__list">
      <li v-for="event in store.sorted" :key="event.id" class="tl__row">
        <span class="tl__time ops-mono ops-muted">{{ fmtTime(event.ts) }}</span>
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
              :class="CONFIDENCE_META[event.confidence].cls"
            >{{ CONFIDENCE_META[event.confidence].label }}</span>
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

.tl__time {
  flex: 0 0 auto;
  font-size: calc(var(--ops-font-size) - 2px);
  white-space: nowrap;
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
