<script setup lang="ts">
import { computed } from 'vue';
import type { EvidenceNoteView } from '../../protocol/host-protocol';
import MetricSnippet from './MetricSnippet.vue';

const props = defineProps<{ note: EvidenceNoteView }>();

const REF_PREVIEW_CAP = 512;

/** 结论三态：颜色 + 文字，不允许只靠颜色。 */
const CONFIDENCE_META: Record<EvidenceNoteView['confidence'], { label: string; cls: string }> = {
  confirmed: { label: '已确证 confirmed', cls: 'ops-confidence-confirmed' },
  hypothesis: { label: '假设 hypothesis', cls: 'ops-confidence-hypothesis' },
  pending: { label: '待定 pending', cls: 'ops-confidence-pending' }
};

const confidence = computed(
  () => CONFIDENCE_META[props.note.confidence] ?? CONFIDENCE_META.pending
);

interface RefView {
  kind: string;
  preview: string;
  clipped: boolean;
  points: number[] | null;
  artifactUri?: string;
}

function extractPoints(ref: Record<string, unknown>): number[] | null {
  if (Array.isArray(ref.points) && ref.points.every((v) => typeof v === 'number')) {
    return ref.points as number[];
  }
  const matches = String(ref.preview ?? '').match(/-?\d+(?:\.\d+)?/g);
  if (matches && matches.length >= 3) {
    return matches.slice(0, 60).map(Number);
  }
  return null;
}

const refs = computed<RefView[]>(() =>
  (props.note.refs ?? []).map((ref) => {
    const raw = String(ref.preview ?? '');
    return {
      kind: ref.kind,
      preview: raw.slice(0, REF_PREVIEW_CAP),
      clipped: raw.length > REF_PREVIEW_CAP,
      points: ref.kind === 'metric' ? extractPoints(ref as unknown as Record<string, unknown>) : null,
      artifactUri: ref.artifactUri
    };
  })
);
</script>

<template>
  <section class="evidence" :class="'evidence--' + props.note.confidence">
    <header class="evidence__head">
      <span aria-hidden="true">📌</span>
      <span class="evidence__summary">{{ props.note.summary }}</span>
      <span class="ops-badge evidence__badge" :class="confidence.cls">{{ confidence.label }}</span>
    </header>
    <div v-if="refs.length" class="evidence__refs">
      <div v-for="(ref, i) in refs" :key="i" class="evidence__ref">
        <template v-if="ref.kind === 'metric'">
          <MetricSnippet :title="ref.preview" :points="ref.points ?? undefined" />
        </template>
        <template v-else>
          <span class="ops-badge evidence__kind ops-muted">{{ ref.kind }}</span>
          <span class="evidence__preview ops-mono">{{ ref.preview }}<span v-if="ref.clipped" class="ops-muted">（已截断）</span></span>
        </template>
      </div>
    </div>
    <div class="evidence__meta ops-muted ops-mono">{{ props.note.taskId }}</div>
  </section>
</template>

<style scoped>
.evidence {
  border: 1px solid var(--ops-border);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
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

.evidence__head {
  display: flex;
  align-items: baseline;
  gap: calc(var(--ops-density) * 1.5);
  min-width: 0;
}

.evidence__summary {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
  font-size: calc(var(--ops-font-size) - 1px);
  word-break: break-word;
}

.evidence__badge {
  flex: 0 0 auto;
}

.evidence__refs {
  margin-top: var(--ops-density);
  display: flex;
  flex-direction: column;
  gap: var(--ops-density);
}

.evidence__ref {
  display: flex;
  gap: calc(var(--ops-density) * 1.5);
  align-items: baseline;
  min-width: 0;
}

.evidence__ref > .metric {
  flex: 1;
}

.evidence__kind {
  flex: 0 0 auto;
}

.evidence__preview {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ops-muted);
}

.evidence__meta {
  margin-top: var(--ops-density);
  font-size: calc(var(--ops-font-size) - 3px);
}
</style>
