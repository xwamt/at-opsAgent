<script setup lang="ts">
import { computed } from 'vue';
import type { SubagentCard } from '../../protocol/host-protocol';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import { subagentTitle } from '../store-helpers';

const props = defineProps<{ agents: SubagentCard[] }>();
const store = useOpsStore();

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

/** 打开的是 ChatApp 顶层的 SubagentInspector（Teleport 到 body，本组件只写 store）。 */
function openInspector(taskId: string): void {
  store.inspectSubagent(taskId);
}

/** 卡片键盘激活：只认卡片自身（内部 abort 按钮的 Enter/Space 不冒泡成打开）。 */
function onCardKey(event: KeyboardEvent, taskId: string): void {
  if (event.target !== event.currentTarget) {
    return;
  }
  event.preventDefault();
  openInspector(taskId);
}
</script>

<template>
  <section class="sa" :aria-label="t('subagentBoardAria')">
    <header class="sa__head ops-muted">
      {{ t('subagentCount') }}（{{ props.agents.length }}）
      <span v-if="active > 0">· {{ active }} {{ t('subagentActive') }}</span>
    </header>
    <div class="sa__cards">
      <!-- Kilo Sub-Agent Viewer 式：整卡即按钮，点开只读 inspector（latest 空也可点） -->
      <article
        v-for="agent in props.agents"
        :key="agent.taskId"
        class="sa__card"
        :class="'sa__card--' + agent.status"
        role="button"
        tabindex="0"
        :aria-label="t('subagentOpenAria') + ' ' + subagentTitle(agent)"
        :title="agent.taskId"
        @click="openInspector(agent.taskId)"
        @keydown.enter="onCardKey($event, agent.taskId)"
        @keydown.space="onCardKey($event, agent.taskId)"
      >
        <div class="sa__row">
          <span class="codicon sa__role" :class="ROLE_ICON[agent.role] ?? 'codicon-hubot'" aria-hidden="true"></span>
          <span class="sa__label">{{ subagentTitle(agent) }}</span>
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
            :aria-label="t('subagentAbortAria') + ' ' + subagentTitle(agent)"
            @click.stop="store.abortSubagent(agent.taskId)"
            @keydown.stop
          >
            {{ t('subagentAbort') }}
          </button>
          <span class="codicon codicon-chevron-right sa__open" aria-hidden="true"></span>
        </div>
        <div class="sa__meta ops-muted ops-mono">
          <span>tools {{ agent.toolCalls.used }}/{{ agent.toolCalls.max }}</span>
          <span>wall {{ secs(agent.wallMs.used) }}/{{ secs(agent.wallMs.max) }}</span>
        </div>
        <div v-if="agent.status === 'running' && agent.currentActivity" class="sa__latest sa__latest--running ops-accent">
          <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
          {{ agent.currentActivity }}
        </div>
        <div v-else-if="agent.latest" class="sa__latest">{{ agent.latest }}</div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.sa {
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-2);
}

.sa__head {
  font-size: var(--ops-font-xs);
  margin-bottom: var(--ops-space-1);
}

.sa__cards {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-1);
}

.sa__card {
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
  cursor: pointer;
}

.sa__card:hover {
  background: var(--ops-hover-bg);
}

.sa__card:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.sa__card--aborted,
.sa__card--failed {
  opacity: 0.85;
}

.sa__row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
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

.sa__open {
  color: var(--ops-muted);
  font-size: var(--ops-font-xs);
  flex: 0 0 auto;
}

.sa__card:hover .sa__open {
  color: var(--ops-fg);
}

.sa__status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--ops-font-xs);
  white-space: nowrap;
}

.sa__status .codicon {
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
  padding: 0 var(--ops-space-2);
  font-size: var(--ops-font-xs);
  line-height: 1.6;
}

.sa__meta {
  display: flex;
  gap: var(--ops-space-3);
  font-size: var(--ops-font-xs);
  margin-top: 2px;
  flex-wrap: wrap;
}

/* 卡内 latest 只留单行预览；全文进 inspector（SubagentInspector.vue，ChatApp 顶层） */
.sa__latest {
  margin-top: 2px;
  font-size: var(--ops-font-sm);
  color: var(--ops-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
