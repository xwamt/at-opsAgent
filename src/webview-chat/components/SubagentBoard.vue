<script setup lang="ts">
import { computed, reactive } from 'vue';
import type { SubagentCard } from '../../protocol/host-protocol';
import { t } from '../i18n';
import { useOpsStore } from '../store';

const props = defineProps<{ agents: SubagentCard[] }>();
const store = useOpsStore();

/** 展开态：卡片级「详情」开关，展开后 latest 全文显示（docs/05 §3.3 展开）。 */
const detailsOpen = reactive(new Set<string>());

function toggleDetails(taskId: string): void {
  if (detailsOpen.has(taskId)) {
    detailsOpen.delete(taskId);
  } else {
    detailsOpen.add(taskId);
  }
}

const ROLE_ICON: Record<SubagentCard['role'], string> = {
  investigator: 'codicon-search',
  executor: 'codicon-tools',
  writer: 'codicon-edit',
  verifier: 'codicon-verified'
};

type StatusKey = 'saQueued' | 'saRunning' | 'saOk' | 'saDegraded' | 'saFailed' | 'saAborted';

const STATUS_META: Record<SubagentCard['status'], { icon: string; key: StatusKey; cls: string }> = {
  queued: { icon: 'codicon-circle-outline', key: 'saQueued', cls: 'sa__status--pending' },
  running: { icon: 'codicon-loading codicon-modifier-spin', key: 'saRunning', cls: 'sa__status--running' },
  ok: { icon: 'codicon-check', key: 'saOk', cls: 'sa__status--ok' },
  degraded: { icon: 'codicon-warning', key: 'saDegraded', cls: 'sa__status--warn' },
  failed: { icon: 'codicon-error', key: 'saFailed', cls: 'sa__status--crit' },
  aborted: { icon: 'codicon-circle-slash', key: 'saAborted', cls: 'sa__status--pending' }
};

const RISK_META: Record<SubagentCard['riskCeiling'], { key: 'riskRead' | 'riskWrite' | 'riskExec'; cls: string }> = {
  read: { key: 'riskRead', cls: 'ops-risk-read' },
  write: { key: 'riskWrite', cls: 'ops-risk-write' },
  exec: { key: 'riskExec', cls: 'ops-risk-exec' }
};

const active = computed(() =>
  props.agents.filter((agent) => agent.status === 'running' || agent.status === 'queued').length
);

function abortable(agent: SubagentCard): boolean {
  return agent.status === 'queued' || agent.status === 'running';
}

function statusOf(agent: SubagentCard) {
  return STATUS_META[agent.status] ?? STATUS_META.queued;
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
</script>

<template>
  <section class="sa" :aria-label="t('subagentBoardAria')">
    <header class="sa__head ops-muted">
      {{ t('subagentCount') }}（{{ props.agents.length }}）
      <span v-if="active > 0">· {{ active }} {{ t('subagentActive') }}</span>
    </header>
    <div class="sa__cards">
      <article
        v-for="agent in props.agents"
        :key="agent.taskId"
        class="sa__card"
        :class="'sa__card--' + agent.status"
        :title="agent.taskId"
      >
        <div class="sa__row">
          <span class="codicon sa__role" :class="ROLE_ICON[agent.role] ?? 'codicon-hubot'" aria-hidden="true"></span>
          <span class="sa__label">{{ agent.label }}</span>
          <span class="sa__status" :class="statusOf(agent).cls">
            <span class="codicon" :class="statusOf(agent).icon" aria-hidden="true"></span>{{ t(statusOf(agent).key) }}
          </span>
          <span class="sa__spacer"></span>
          <span class="ops-badge" :class="RISK_META[agent.riskCeiling].cls">
            {{ t(RISK_META[agent.riskCeiling].key) }}<template v-if="agent.approvalBriefId"> · {{ agent.approvalBriefId }}</template>
          </span>
          <button
            v-if="abortable(agent)"
            type="button"
            class="ops-btn ops-btn--danger sa__abort"
            :aria-label="t('subagentAbortAria') + ' ' + agent.label"
            @click="store.abortSubagent(agent.taskId)"
          >
            {{ t('subagentAbort') }}
          </button>
        </div>
        <div class="sa__meta ops-muted ops-mono">
          <span>tools {{ agent.toolCalls.used }}/{{ agent.toolCalls.max }}</span>
          <span>wall {{ secs(agent.wallMs.used) }}/{{ secs(agent.wallMs.max) }}</span>
          <button
            v-if="agent.latest"
            type="button"
            class="sa__details"
            :aria-expanded="detailsOpen.has(agent.taskId)"
            :aria-label="t('subagentDetails') + ' ' + agent.label"
            @click="toggleDetails(agent.taskId)"
          >
            <span
              class="codicon"
              :class="detailsOpen.has(agent.taskId) ? 'codicon-chevron-down' : 'codicon-chevron-right'"
              aria-hidden="true"
            ></span>
            {{ t('subagentDetails') }}
          </button>
        </div>
        <div
          v-if="agent.latest"
          class="sa__latest"
          :class="{ 'sa__latest--full': detailsOpen.has(agent.taskId) }"
        >{{ agent.latest }}</div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.sa {
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
}

.sa__head {
  font-size: calc(var(--ops-font-size) - 2px);
  margin-bottom: var(--ops-density);
}

.sa__cards {
  display: flex;
  flex-direction: column;
  gap: var(--ops-density);
}

.sa__card {
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
}

.sa__card--aborted,
.sa__card--failed {
  opacity: 0.85;
}

.sa__row {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 1.5);
  min-width: 0;
}

.sa__label {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa__spacer {
  flex: 1;
}

.sa__role {
  color: var(--ops-muted);
  font-size: var(--ops-font-sm);
  flex: 0 0 auto;
}

.sa__status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: calc(var(--ops-font-size) - 2px);
  white-space: nowrap;
}

.sa__status .codicon,
.sa__details .codicon {
  font-size: var(--ops-font-xs);
}

.sa__status--pending {
  color: var(--ops-pending);
}

.sa__status--running {
  color: var(--ops-accent);
}

.sa__status--ok {
  color: var(--ops-healthy);
}

.sa__status--warn {
  color: var(--ops-warn);
}

.sa__status--crit {
  color: var(--ops-crit);
}

.sa__abort {
  padding: 0 calc(var(--ops-density) * 1.5);
  font-size: calc(var(--ops-font-size) - 2px);
  line-height: 1.6;
}

.sa__meta {
  display: flex;
  gap: calc(var(--ops-density) * 3);
  font-size: calc(var(--ops-font-size) - 2px);
  margin-top: 2px;
  flex-wrap: wrap;
}

.sa__details {
  background: transparent;
  border: none;
  color: var(--ops-muted);
  cursor: pointer;
  padding: 0;
  font-size: calc(var(--ops-font-size) - 2px);
  font-family: inherit;
}

.sa__details:hover {
  color: var(--ops-fg);
}

.sa__details:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.sa__latest {
  margin-top: 2px;
  font-size: calc(var(--ops-font-size) - 1px);
  color: var(--ops-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 详情展开：latest 全文，不再截为单行 */
.sa__latest--full {
  white-space: pre-wrap;
  word-break: break-word;
  text-overflow: clip;
  color: var(--ops-fg);
  border-left: 2px solid var(--ops-border);
  padding-left: calc(var(--ops-density) * 1.5);
}
</style>
