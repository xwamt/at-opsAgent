<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import type { SubagentCard } from '../../protocol/host-protocol';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import { subagentTitle } from '../store-helpers';

/**
 * 子代理只读 inspector（docs/12 §3）：从 SubagentBoard 抬升到 ChatApp 顶层
 * （Teleport 到 body），不再受 transcript 的 overflow/滚动裁剪——顶栏运行条
 * 和看板整卡点击都能稳定看到弹层。数据源是 store.inspectedSubagent
 * （id 失配视同关闭），本组件不接 props。
 */
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

/** ChatApp 已 v-if 守卫；这里再取一次供模板类型收窄与响应式跟随。 */
const inspected = computed<SubagentCard | null>(() => store.inspectedSubagent);

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

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <!-- VS Code editorWidget 风格只读详情（backdrop 点击 / Escape 关闭） -->
  <div
    v-if="inspected"
    class="sa-inspector"
    role="dialog"
    aria-modal="true"
    :aria-label="t('subagentInspectorAria')"
  >
    <div class="sa-inspector__backdrop" aria-hidden="true" @click="close"></div>
    <section class="sa-inspector__panel">
      <header class="sa-inspector__head">
        <span
          class="codicon sa-inspector__role"
          :class="ROLE_ICON[inspected.role] ?? 'codicon-hubot'"
          aria-hidden="true"
        ></span>
        <div class="sa-inspector__heading">
          <h2 class="sa-inspector__title">{{ subagentTitle(inspected) }}</h2>
          <span class="sa-inspector__sub ops-muted ops-mono">{{ inspected.label }} · {{ inspected.taskId }}</span>
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
      <div class="sa-inspector__body">
        <dl class="sa-inspector__meta">
          <dt class="ops-muted">{{ t('subagentStatusLabel') }}</dt>
          <dd>
            <span class="sa-inspector__status" :class="statusOf(inspected).cls">
              <span class="codicon" :class="statusOf(inspected).icon" aria-hidden="true"></span>{{ t(statusOf(inspected).key) }}
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
        <div class="sa-inspector__section">
          <span class="sa-inspector__label ops-muted">{{ t('subagentLatestLabel') }}</span>
          <pre v-if="inspected.latest" class="sa-inspector__latest">{{ inspected.latest }}</pre>
          <p v-else class="sa-inspector__empty ops-muted">{{ t('subagentNoOutput') }}</p>
        </div>
      </div>
      <footer v-if="abortable(inspected)" class="sa-inspector__foot">
        <button
          type="button"
          class="ops-btn ops-btn--danger"
          :aria-label="t('subagentAbortAria') + ' ' + subagentTitle(inspected)"
          @click="store.abortSubagent(inspected.taskId)"
        >
          {{ t('subagentAbort') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* ── inspector overlay：VS Code editorWidget 观感 ── */
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
  background: color-mix(in srgb, var(--vscode-widget-shadow, #000) 30%, transparent);
}

.sa-inspector__panel {
  position: relative;
  width: min(560px, 100%);
  max-height: min(80vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--vscode-editorWidget-background, var(--ops-bg));
  border: 1px solid var(--vscode-editorWidget-border, var(--ops-border));
  border-radius: var(--ops-radius);
  box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
}

.sa-inspector__head {
  display: flex;
  align-items: flex-start;
  gap: var(--ops-space-2);
  padding: var(--ops-space-2) var(--ops-space-3);
  border-bottom: 1px solid var(--ops-border);
}

.sa-inspector__role {
  color: var(--ops-muted);
  margin-top: 2px;
  flex: 0 0 auto;
}

.sa-inspector__heading {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sa-inspector__title {
  margin: 0;
  font-size: var(--ops-font-md);
  font-weight: 600;
  line-height: 1.35;
  word-break: break-word;
}

.sa-inspector__sub {
  font-size: var(--ops-font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sa-inspector__close {
  background: transparent;
  border: none;
  border-radius: var(--ops-radius-ctl);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 2px var(--ops-space-1);
  line-height: 1;
  flex: 0 0 auto;
}

.sa-inspector__close .codicon {
  font-size: var(--ops-font-sm);
}

.sa-inspector__close:hover {
  background: var(--ops-toolbar-hover-bg);
  color: var(--ops-fg);
}

.sa-inspector__close:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.sa-inspector__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--ops-space-2) var(--ops-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.sa-inspector__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--ops-space-1) var(--ops-space-3);
  margin: 0;
  font-size: var(--ops-font-sm);
}

.sa-inspector__meta dd {
  margin: 0;
  min-width: 0;
}

.sa-inspector__status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--ops-font-xs);
  white-space: nowrap;
}

.sa-inspector__status .codicon {
  font-size: var(--ops-font-xs);
}

.sa-inspector__status--pending {
  color: var(--ops-pending);
}

.sa-inspector__status--running {
  color: var(--ops-accent);
}

.sa-inspector__status--ok {
  color: var(--ops-healthy);
}

.sa-inspector__status--warn {
  color: var(--ops-warn);
}

.sa-inspector__status--crit {
  color: var(--ops-crit);
}

.sa-inspector__section {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-1);
}

.sa-inspector__label {
  font-size: var(--ops-font-xs);
}

.sa-inspector__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-1);
}

.sa-inspector__chip {
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-space-2);
  font-size: var(--ops-font-xs);
  line-height: 1.7;
  color: var(--ops-fg);
  background: var(--ops-code-bg);
}

/* latest 全文：pre-wrap，编辑器底色（区别于 sideBar 面板底） */
.sa-inspector__latest {
  margin: 0;
  font-family: var(--ops-mono);
  font-size: var(--ops-font-sm);
  background: var(--vscode-editor-background, var(--ops-code-bg));
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-3);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 40vh;
  overflow-y: auto;
}

.sa-inspector__empty {
  margin: 0;
  font-size: var(--ops-font-sm);
}

.sa-inspector__foot {
  display: flex;
  justify-content: flex-end;
  padding: var(--ops-space-2) var(--ops-space-3);
  border-top: 1px solid var(--ops-border);
}

.sa-inspector__foot .ops-btn {
  padding: 1px var(--ops-space-2);
  font-size: var(--ops-font-sm);
}
</style>
