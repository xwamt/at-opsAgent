<script setup lang="ts">
import { computed } from 'vue';
import type { EvidenceNoteView } from '../../protocol/host-protocol';
import { confidenceClass, confidenceLabel, normalizeConfidence } from '../confidence';
import { formatAbsoluteTime, formatRelativeTime } from '../store-helpers';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import HostSessionChip from './HostSessionChip.vue';
import LogViewer from './LogViewer.vue';
import MetricSnippet from './MetricSnippet.vue';
import PipelineStatus from './PipelineStatus.vue';

const props = defineProps<{ note: EvidenceNoteView; ts?: number }>();

const store = useOpsStore();

const REF_PREVIEW_CAP = 512;

const isPinned = computed(() => props.note.pinned === true);

function togglePin(): void {
  store.pinEvidence(props.note.taskId, !isPinned.value);
}

/** 结论三态：颜色 + 文字，不允许只靠颜色（helper 抽到 confidence.ts 供单测）。 */
const confidence = computed(() => ({
  level: normalizeConfidence(props.note.confidence),
  label: confidenceLabel(props.note.confidence),
  cls: confidenceClass(props.note.confidence)
}));

const timestampLabel = computed(() => {
  if (typeof props.ts !== 'number' || !Number.isFinite(props.ts)) {
    return null;
  }
  return {
    relative: formatRelativeTime(props.ts),
    absolute: formatAbsoluteTime(props.ts)
  };
});

interface PipelineRef {
  job: string;
  build?: string;
  result: string;
}

interface HostRef {
  pluginId: string;
  label: string;
  connected: boolean;
}

interface RefView {
  kind: string;
  preview: string;
  clipped: boolean;
  points: number[] | null;
  from?: string;
  to?: string;
  inferred: boolean;
  pipeline: PipelineRef | null;
  host: HostRef | null;
  artifactUri?: string;
}

function extractMetricData(ref: Record<string, unknown>): {
  points: number[] | null;
  from?: string;
  to?: string;
  inferred: boolean;
} {
  const from = typeof ref.from === 'string' ? ref.from : undefined;
  const to = typeof ref.to === 'string' ? ref.to : undefined;
  if (Array.isArray(ref.points) && ref.points.every((v) => typeof v === 'number') && ref.points.length >= 2) {
    return { points: ref.points as number[], from, to, inferred: false };
  }
  const matches = String(ref.preview ?? '').match(/-?\d+(?:\.\d+)?/g);
  if (matches && matches.length >= 3) {
    return { points: matches.slice(0, 60).map(Number), from, to, inferred: true };
  }
  return { points: null, from, to, inferred: false };
}

/** pipeline ref：优先结构化字段，否则从 preview 文本猜 job/#build/result。 */
function extractPipeline(ref: Record<string, unknown>, preview: string): PipelineRef {
  if (typeof ref.job === 'string' && ref.job) {
    return {
      job: ref.job,
      build: ref.build !== undefined ? String(ref.build) : undefined,
      result: String(ref.result ?? 'building')
    };
  }
  const build = preview.match(/#(\d+)/)?.[1];
  const result =
    preview.match(/\b(SUCCESS|FAILURE|BUILDING|UNSTABLE|ABORTED)\b/i)?.[1]?.toLowerCase() ??
    'building';
  const job = (build ? preview.slice(0, preview.indexOf('#')) : preview).trim() || preview;
  return { job, build, result };
}

function extractHost(ref: Record<string, unknown>, preview: string): HostRef {
  return {
    pluginId: String(ref.pluginId ?? 'at.terminal'),
    label: String(ref.label ?? preview),
    connected: ref.connected !== false
  };
}

const refs = computed<RefView[]>(() =>
  (props.note.refs ?? []).map((ref) => {
    const raw = String(ref.preview ?? '');
    const rec = ref as unknown as Record<string, unknown>;
    const preview = raw.slice(0, REF_PREVIEW_CAP);
    const metric =
      ref.kind === 'metric'
        ? extractMetricData(rec)
        : { points: null as number[] | null, inferred: false };
    return {
      kind: ref.kind,
      preview,
      clipped: raw.length > REF_PREVIEW_CAP,
      points: metric.points,
      from: metric.from,
      to: metric.to,
      inferred: metric.inferred,
      pipeline: ref.kind === 'pipeline' ? extractPipeline(rec, preview) : null,
      host: ref.kind === 'host' ? extractHost(rec, preview) : null,
      artifactUri: ref.artifactUri
    };
  })
);
</script>

<template>
  <section
    class="evidence"
    :class="['evidence--' + confidence.level, { 'evidence--pinned': isPinned }]"
    :title="props.note.taskId"
  >
    <header class="evidence__head">
      <button
        type="button"
        class="evidence__pin"
        :class="{ 'evidence__pin--active': isPinned }"
        :aria-label="isPinned ? t('evidenceUnpinAria') : t('evidencePinAria')"
        :aria-pressed="isPinned"
        :title="isPinned ? t('evidenceUnpinAria') : t('evidencePinAria')"
        @click="togglePin"
      >
        <span
          class="codicon"
          :class="isPinned ? 'codicon-pinned' : 'codicon-pin'"
          aria-hidden="true"
        ></span>
      </button>
      <span class="evidence__summary">{{ props.note.summary }}</span>
      <span
        v-if="timestampLabel"
        class="ops-muted ops-mono evidence__ts"
        :title="timestampLabel.absolute"
      >{{ timestampLabel.relative }}</span>
      <span class="ops-badge evidence__badge" :class="confidence.cls">{{ confidence.label }}</span>
    </header>
    <div v-if="refs.length" class="evidence__refs">
      <div v-for="(ref, i) in refs" :key="i" class="evidence__ref">
        <template v-if="ref.kind === 'metric'">
          <MetricSnippet
            :title="ref.preview"
            :points="ref.points ?? undefined"
            :from="ref.from"
            :to="ref.to"
            :inferred="ref.inferred"
          />
        </template>
        <template v-else-if="ref.pipeline">
          <PipelineStatus
            class="evidence__wide"
            :job="ref.pipeline.job"
            :build="ref.pipeline.build"
            :result="ref.pipeline.result"
          />
        </template>
        <template v-else-if="ref.kind === 'log'">
          <LogViewer
            class="evidence__wide"
            :text="ref.preview"
            :uri="ref.artifactUri"
            :truncated="ref.clipped"
          />
        </template>
        <template v-else-if="ref.host">
          <HostSessionChip
            :plugin-id="ref.host.pluginId"
            :label="ref.host.label"
            :connected="ref.host.connected"
          />
        </template>
        <template v-else>
          <span class="ops-badge evidence__kind ops-muted">{{ ref.kind }}</span>
          <span class="evidence__preview ops-mono">{{ ref.preview }}<span v-if="ref.clipped" class="ops-muted">（{{ t('truncated') }}）</span></span>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.evidence {
  border: 1px solid var(--ops-border);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-2);
}

.evidence--confirmed {
  border-left-color: var(--ops-healthy);
}

.evidence--hypothesis {
  border-left-color: var(--ops-warn);
}

.evidence--pending {
  border-left-color: var(--ops-pending);
}

.evidence--pinned {
  border-color: color-mix(in srgb, var(--ops-accent) 35%, var(--ops-border));
  background: color-mix(in srgb, var(--ops-accent) 6%, transparent);
}

.evidence__head {
  display: flex;
  align-items: baseline;
  gap: var(--ops-space-2);
  min-width: 0;
}

.evidence__pin {
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  color: var(--ops-muted);
  cursor: pointer;
  font-size: var(--ops-font-sm);
  flex: 0 0 auto;
  line-height: 1;
  padding: 0 1px;
}

.evidence__pin:hover {
  color: var(--ops-fg);
  background: var(--ops-toolbar-hover-bg);
}

.evidence__pin:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.evidence__pin--active {
  color: var(--ops-accent);
}

.evidence__summary {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
  font-size: calc(var(--ops-font-size) - 1px);
  word-break: break-word;
}

.evidence__ts {
  flex: 0 0 auto;
  font-size: var(--ops-font-xs);
  white-space: nowrap;
}

.evidence__badge {
  flex: 0 0 auto;
}

.evidence__refs {
  margin-top: var(--ops-space-2);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.evidence__ref {
  display: flex;
  gap: var(--ops-space-2);
  align-items: baseline;
  min-width: 0;
}

.evidence__ref > .metric {
  flex: 1;
}

.evidence__wide {
  flex: 1;
  min-width: 0;
}

.evidence__kind {
  flex: 0 0 auto;
}

.evidence__preview {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ops-muted);
}
</style>
