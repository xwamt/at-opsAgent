<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SubagentCard } from '../../protocol/host-protocol';
import { t } from '../i18n';
import { useCopiedFlag } from '../lib/clipboard';
import { useOpsStore } from '../store';
import { collectSubagentCards, findAdjacentSubagent, subagentTitle } from '../store-helpers';
import MarkdownBlock from './MarkdownBlock.vue';

const store = useOpsStore();

const ROLE_ICON: Record<SubagentCard['role'], string> = {
  investigator: 'codicon-search',
  executor: 'codicon-tools',
  writer: 'codicon-edit',
  verifier: 'codicon-verified'
};

type StatusKey = 'saQueued' | 'saRunning' | 'saOk' | 'saDegraded' | 'saFailed' | 'saAborted';

const STATUS_META: Record<SubagentCard['status'], { icon: string; key: StatusKey; cls: string }> = {
  queued: { icon: 'codicon-circle-outline', key: 'saQueued', cls: 'sa-inspector__status--pending' },
  running: { icon: 'codicon-loading codicon-modifier-spin', key: 'saRunning', cls: 'sa-inspector__status--running' },
  ok: { icon: 'codicon-check', key: 'saOk', cls: 'sa-inspector__status--ok' },
  degraded: { icon: 'codicon-warning', key: 'saDegraded', cls: 'sa-inspector__status--warn' },
  failed: { icon: 'codicon-error', key: 'saFailed', cls: 'sa-inspector__status--crit' },
  aborted: { icon: 'codicon-circle-slash', key: 'saAborted', cls: 'sa-inspector__status--pending' }
};

const RISK_META: Record<SubagentCard['riskCeiling'], { key: 'riskRead' | 'riskWrite' | 'riskExec'; cls: string }> = {
  read: { key: 'riskRead', cls: 'ops-risk-read' },
  write: { key: 'riskWrite', cls: 'ops-risk-write' },
  exec: { key: 'riskExec', cls: 'ops-risk-exec' }
};

const inspected = computed<SubagentCard | null>(() => store.inspectedSubagent);

const allCards = computed(() => collectSubagentCards(store.items));
const currentIndex = computed(() => allCards.value.findIndex((c) => c.taskId === inspected.value?.taskId));
const totalCount = computed(() => allCards.value.length);
const prevTaskId = computed(() => inspected.value ? findAdjacentSubagent(allCards.value, inspected.value.taskId, 'prev') : null);
const nextTaskId = computed(() => inspected.value ? findAdjacentSubagent(allCards.value, inspected.value.taskId, 'next') : null);

type InspectorTab = 'steps' | 'logs' | 'overview';
const activeTab = ref<InspectorTab>('steps');

const { copied, copy } = useCopiedFlag();

function abortable(agent: SubagentCard): boolean {
  return agent.status === 'queued' || agent.status === 'running';
}

function statusOf(agent: SubagentCard) {
  return STATUS_META[agent.status] ?? STATUS_META.queued;
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function close(): void {
  store.inspectSubagent(null);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && inspected.value) {
    close();
  }
}

async function copyAllLogs(): Promise<void> {
  if (!inspected.value) return;
  const content = [
    `=== Subagent [${inspected.value.taskId}] ${inspected.value.label} ===`,
    `Role: ${inspected.value.role} | Status: ${inspected.value.status}`,
    `\n--- Logs ---`,
    ...(inspected.value.logs ?? []),
    `\n--- Output ---`,
    inspected.value.latest ?? ''
  ].join('\n');
  await copy(content);
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div
    v-if="inspected"
    class="sa-inspector"
    role="dialog"
    aria-modal="true"
    :aria-label="t('subagentInspectorAria')"
  >
    <div class="sa-inspector__backdrop" aria-hidden="true" @click="close"></div>
    <section class="sa-inspector__panel">
      <!-- 头部：标题 + 状态指示 + 左右切换 + 关闭按钮 -->
      <header class="sa-inspector__head">
        <span
          class="codicon sa-inspector__role"
          :class="ROLE_ICON[inspected.role] ?? 'codicon-hubot'"
          aria-hidden="true"
        ></span>
        <div class="sa-inspector__heading">
          <div class="sa-inspector__title-row">
            <h2 class="sa-inspector__title">{{ subagentTitle(inspected) }}</h2>
            <span class="sa-inspector__status" :class="statusOf(inspected).cls">
              <span class="codicon" :class="statusOf(inspected).icon" aria-hidden="true"></span>
              {{ t(statusOf(inspected).key) }}
            </span>
          </div>
          <span class="sa-inspector__sub ops-muted ops-mono">{{ inspected.label }} · {{ inspected.taskId }}</span>
        </div>
        <div v-if="totalCount > 1" class="sa-inspector__nav">
          <button
            type="button"
            class="sa-inspector__nav-btn"
            :disabled="!prevTaskId"
            :aria-label="t('subagentPrevAria')"
            :title="t('subagentPrevAria')"
            @click="prevTaskId && store.inspectSubagent(prevTaskId)"
          >
            <span class="codicon codicon-chevron-left" aria-hidden="true"></span>
          </button>
          <span class="sa-inspector__nav-pos ops-mono ops-muted">{{ currentIndex + 1 }}/{{ totalCount }}</span>
          <button
            type="button"
            class="sa-inspector__nav-btn"
            :disabled="!nextTaskId"
            :aria-label="t('subagentNextAria')"
            :title="t('subagentNextAria')"
            @click="nextTaskId && store.inspectSubagent(nextTaskId)"
          >
            <span class="codicon codicon-chevron-right" aria-hidden="true"></span>
          </button>
        </div>
        <button
          type="button"
          class="sa-inspector__close"
          :aria-label="t('subagentInspectorCloseAria')"
          @click="close"
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </header>

      <!-- 实时动作条（运行中时高亮展示当前正在做的事） -->
      <div v-if="inspected.currentActivity" class="sa-inspector__activity">
        <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
        <span class="sa-inspector__activity-text">{{ inspected.currentActivity }}</span>
      </div>

      <!-- 选项卡导航 -->
      <nav class="sa-inspector__tabs" role="tablist">
        <button
          type="button"
          class="sa-inspector__tab"
          :class="{ 'sa-inspector__tab--active': activeTab === 'steps' }"
          @click="activeTab = 'steps'"
        >
          <span class="codicon codicon-list-tree" aria-hidden="true"></span>
          {{ t('subagentSteps') }}
          <span v-if="inspected.steps && inspected.steps.length > 0" class="sa-inspector__tab-count">
            {{ inspected.steps.length }}
          </span>
        </button>
        <button
          type="button"
          class="sa-inspector__tab"
          :class="{ 'sa-inspector__tab--active': activeTab === 'logs' }"
          @click="activeTab = 'logs'"
        >
          <span class="codicon codicon-terminal" aria-hidden="true"></span>
          {{ t('subagentLogs') }}
        </button>
        <button
          type="button"
          class="sa-inspector__tab"
          :class="{ 'sa-inspector__tab--active': activeTab === 'overview' }"
          @click="activeTab = 'overview'"
        >
          <span class="codicon codicon-info" aria-hidden="true"></span>
          {{ t('subagentOverview') }}
        </button>
        <span class="sa-inspector__tab-spacer"></span>
        <button
          type="button"
          class="ops-copy-btn sa-inspector__copy-all"
          :class="{ 'ops-copy-btn--copied': copied }"
          :aria-label="copied ? t('copied') : t('copyAria')"
          :title="copied ? t('copied') : t('copy')"
          @click="copyAllLogs"
        >
          <span class="codicon" :class="copied ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
          <span v-if="copied">{{ t('copied') }}</span>
        </button>
      </nav>

      <!-- 选项卡内容区 -->
      <div class="sa-inspector__body">
        <!-- 选项卡 1：分步执行轨迹 -->
        <div v-if="activeTab === 'steps'" class="sa-inspector__steps-panel">
          <div v-if="inspected.steps && inspected.steps.length > 0" class="sa-stepper">
            <div
              v-for="(step, idx) in inspected.steps"
              :key="step.id"
              class="sa-stepper__item"
              :class="'sa-stepper__item--' + step.status"
            >
              <div class="sa-stepper__indicator">
                <span
                  class="codicon sa-stepper__icon"
                  :class="{
                    'codicon-check': step.status === 'ok',
                    'codicon-loading codicon-modifier-spin': step.status === 'running',
                    'codicon-error': step.status === 'error'
                  }"
                  aria-hidden="true"
                ></span>
                <span v-if="idx < inspected.steps.length - 1" class="sa-stepper__line"></span>
              </div>
              <div class="sa-stepper__content">
                <div class="sa-stepper__head">
                  <span class="sa-stepper__title ops-mono">{{ step.title }}</span>
                  <span
                    class="sa-stepper__tag"
                    :class="'sa-stepper__tag--' + step.status"
                  >
                    {{ step.status === 'running' ? t('subagentStepRunning') : t('subagentStepDone') }}
                  </span>
                </div>
                <div v-if="step.detail" class="sa-stepper__detail ops-muted">{{ step.detail }}</div>
              </div>
            </div>
          </div>
          <div v-else class="sa-inspector__empty ops-muted">
            <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
            {{ t('subagentStepRunning') }}
          </div>
        </div>

        <!-- 选项卡 2：实时控制台日志与输出 -->
        <div v-else-if="activeTab === 'logs'" class="sa-inspector__logs-panel">
          <div v-if="inspected.logs && inspected.logs.length > 0" class="sa-inspector__console ops-mono">
            <div v-for="(log, i) in inspected.logs" :key="i" class="sa-inspector__log-line">{{ log }}</div>
          </div>
          <div v-if="inspected.latest" class="sa-inspector__latest-wrap">
            <span class="sa-inspector__section-label ops-muted">{{ t('subagentLatestLabel') }}</span>
            <div class="sa-inspector__latest-box">
              <MarkdownBlock :source="inspected.latest" />
            </div>
          </div>
          <p v-if="(!inspected.logs || inspected.logs.length === 0) && !inspected.latest" class="sa-inspector__empty ops-muted">
            {{ t('subagentNoOutput') }}
          </p>
        </div>

        <!-- 选项卡 3：任务元数据与权限 -->
        <div v-else-if="activeTab === 'overview'" class="sa-inspector__overview-panel">
          <dl class="sa-inspector__meta">
            <dt class="ops-muted">{{ t('subagentStatusLabel') }}</dt>
            <dd>
              <span class="sa-inspector__status" :class="statusOf(inspected).cls">
                <span class="codicon" :class="statusOf(inspected).icon" aria-hidden="true"></span>
                {{ t(statusOf(inspected).key) }}
              </span>
            </dd>
            <dt class="ops-muted">{{ t('subagentRiskLabel') }}</dt>
            <dd>
              <span class="ops-badge" :class="RISK_META[inspected.riskCeiling].cls">
                {{ t(RISK_META[inspected.riskCeiling].key) }}<template v-if="inspected.approvalBriefId"> · {{ inspected.approvalBriefId }}</template>
              </span>
            </dd>
            <dt class="ops-muted">{{ t('subagentToolCallsLabel') }}</dt>
            <dd class="ops-mono">{{ inspected.toolCalls.used }}/{{ inspected.toolCalls.max }}</dd>
            <dt class="ops-muted">{{ t('subagentWallLabel') }}</dt>
            <dd class="ops-mono">{{ secs(inspected.wallMs.used) }}/{{ secs(inspected.wallMs.max) }}</dd>
          </dl>

          <div v-if="inspected.visibleTools && inspected.visibleTools.length > 0" class="sa-inspector__section">
            <span class="sa-inspector__label ops-muted">{{ t('subagentVisibleTools') }}</span>
            <div class="sa-inspector__chips">
              <span
                v-for="tool in inspected.visibleTools"
                :key="tool"
                class="sa-inspector__chip ops-mono"
              >{{ tool }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部中止操作栏 -->
      <footer v-if="abortable(inspected)" class="sa-inspector__foot">
        <button
          type="button"
          class="ops-btn ops-btn--danger"
          :aria-label="t('subagentAbortAria') + ' ' + subagentTitle(inspected)"
          @click="store.abortSubagent(inspected.taskId)"
        >
          <span class="codicon codicon-circle-slash" aria-hidden="true"></span>
          {{ t('subagentAbort') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.sa-inspector {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ops-space-4);
}

.sa-inspector__backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--vscode-widget-shadow, #000) 45%, transparent);
  backdrop-filter: blur(2px);
}

.sa-inspector__panel {
  position: relative;
  width: min(640px, 100%);
  max-height: min(84vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--vscode-editorWidget-background, var(--ops-bg));
  border: 1px solid var(--vscode-editorWidget-border, var(--ops-border));
  border-radius: var(--ops-radius);
  box-shadow: 0 8px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.45));
  overflow: hidden;
}

.sa-inspector__head {
  display: flex;
  align-items: flex-start;
  gap: var(--ops-space-2);
  padding: var(--ops-space-3);
  border-bottom: 1px solid var(--ops-border);
}

.sa-inspector__role {
  color: var(--ops-accent);
  margin-top: 2px;
  font-size: 16px;
  flex: 0 0 auto;
}

.sa-inspector__heading {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sa-inspector__title-row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.sa-inspector__title {
  margin: 0;
  font-size: var(--ops-font-md);
  font-weight: 600;
  line-height: 1.35;
}

.sa-inspector__sub {
  font-size: var(--ops-font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa-inspector__nav {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: var(--ops-space-1);
}

.sa-inspector__nav-btn {
  background: transparent;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 2px 4px;
  line-height: 1;
}

.sa-inspector__nav-btn:hover:not(:disabled) {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
}

.sa-inspector__nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.sa-inspector__nav-pos {
  font-size: var(--ops-font-xs);
  padding: 0 4px;
  user-select: none;
}

.sa-inspector__close {
  background: transparent;
  border: none;
  border-radius: var(--ops-radius-ctl);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 4px 6px;
  line-height: 1;
}

.sa-inspector__close:hover {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
}

.sa-inspector__activity {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: 6px var(--ops-space-3);
  background: color-mix(in srgb, var(--ops-bg) 85%, var(--ops-accent) 15%);
  border-bottom: 1px solid color-mix(in srgb, var(--ops-border) 70%, var(--ops-accent) 30%);
  font-size: var(--ops-font-xs);
  color: var(--ops-accent);
}

.sa-inspector__activity-text {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa-inspector__tabs {
  display: flex;
  align-items: center;
  padding: 0 var(--ops-space-3);
  border-bottom: 1px solid var(--ops-border);
  background: color-mix(in srgb, var(--ops-bg) 95%, var(--ops-fg) 5%);
}

.sa-inspector__tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--ops-muted);
  cursor: pointer;
  font-size: var(--ops-font-xs);
  font-weight: 500;
  transition: all 120ms ease;
}

.sa-inspector__tab:hover {
  color: var(--ops-fg);
}

.sa-inspector__tab--active {
  color: var(--ops-accent);
  border-bottom-color: var(--ops-accent);
}

.sa-inspector__tab-count {
  padding: 1px 5px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ops-fg) 12%, transparent);
  font-size: 10px;
}

.sa-inspector__tab-spacer {
  flex: 1;
}

.sa-inspector__copy-all {
  padding: 2px 6px;
}

.sa-inspector__body {
  flex: 1 1 auto;
  min-height: 200px;
  max-height: 480px;
  overflow-y: auto;
  padding: var(--ops-space-3);
}

/* Stepper 步骤树 */
.sa-stepper {
  display: flex;
  flex-direction: column;
}

.sa-stepper__item {
  display: flex;
  gap: var(--ops-space-3);
  position: relative;
}

.sa-stepper__indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 20px;
  flex: 0 0 auto;
}

.sa-stepper__icon {
  font-size: 14px;
  margin-top: 2px;
  color: var(--ops-muted);
}

.sa-stepper__item--ok .sa-stepper__icon {
  color: var(--ops-healthy);
}

.sa-stepper__item--running .sa-stepper__icon {
  color: var(--ops-accent);
}

.sa-stepper__item--error .sa-stepper__icon {
  color: var(--ops-crit);
}

.sa-stepper__line {
  flex: 1 1 auto;
  width: 2px;
  background: var(--ops-border);
  margin: 4px 0;
  min-height: 20px;
}

.sa-stepper__content {
  flex: 1 1 auto;
  min-width: 0;
  padding-bottom: var(--ops-space-3);
}

.sa-stepper__head {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.sa-stepper__title {
  font-weight: 500;
  font-size: var(--ops-font-sm);
}

.sa-stepper__tag {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid currentColor;
}

.sa-stepper__tag--ok {
  color: var(--ops-healthy);
}

.sa-stepper__tag--running {
  color: var(--ops-accent);
}

.sa-stepper__tag--error {
  color: var(--ops-crit);
}

.sa-stepper__detail {
  font-size: var(--ops-font-xs);
  margin-top: 2px;
}

/* 控制台日志 */
.sa-inspector__console {
  background: #141416;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
  padding: var(--ops-space-2);
  font-size: var(--ops-font-xs);
  color: #e4e4e7;
  max-height: 220px;
  overflow-y: auto;
}

.sa-inspector__log-line {
  padding: 1px 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.sa-inspector__latest-wrap {
  margin-top: var(--ops-space-3);
}

.sa-inspector__section-label {
  display: block;
  font-size: var(--ops-font-xs);
  margin-bottom: var(--ops-space-1);
}

.sa-inspector__latest-box {
  background: color-mix(in srgb, var(--ops-bg) 92%, var(--ops-fg) 8%);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
  padding: var(--ops-space-2) var(--ops-space-3);
  font-size: var(--ops-font-sm);
}

/* 任务元数据 */
.sa-inspector__meta {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: var(--ops-space-1) var(--ops-space-2);
  font-size: var(--ops-font-sm);
  margin: 0 0 var(--ops-space-3);
}

.sa-inspector__meta dt {
  margin: 0;
}

.sa-inspector__meta dd {
  margin: 0;
}

.sa-inspector__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.sa-inspector__status--running {
  color: var(--ops-accent);
}

.sa-inspector__status--ok {
  color: var(--ops-healthy);
}

.sa-inspector__status--crit {
  color: var(--ops-crit);
}

.sa-inspector__status--warn {
  color: var(--ops-warn);
}

.sa-inspector__status--pending {
  color: var(--ops-pending);
}

.sa-inspector__section {
  margin-top: var(--ops-space-2);
}

.sa-inspector__label {
  display: block;
  font-size: var(--ops-font-xs);
  margin-bottom: var(--ops-space-1);
}

.sa-inspector__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.sa-inspector__chip {
  padding: 1px 6px;
  background: color-mix(in srgb, var(--ops-fg) 10%, transparent);
  border-radius: var(--ops-radius-ctl);
  font-size: var(--ops-font-xs);
}

.sa-inspector__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ops-space-2);
  padding: var(--ops-space-4);
  font-size: var(--ops-font-sm);
}

.sa-inspector__foot {
  padding: var(--ops-space-2) var(--ops-space-3);
  border-top: 1px solid var(--ops-border);
  display: flex;
  justify-content: flex-end;
}
</style>
