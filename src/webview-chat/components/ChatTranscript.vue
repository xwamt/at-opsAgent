<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import type { NoticeAction } from '../../protocol/host-protocol';
import { t, tf } from '../i18n';
import { useOpsStore } from '../store';
import { assistantDisplay, visibleUntrustedQuotes, thinkingMetaVisible, formatThinkingDurationMs, type TimelineStripEntry } from '../store-helpers';
import { getVsCodeApi } from '../vscode-api';
import EvidenceNote from './EvidenceNote.vue';
import MarkdownBlock from './MarkdownBlock.vue';
import SubagentBoard from './SubagentBoard.vue';
import ToolCallCard from './ToolCallCard.vue';
import UntrustedQuotes from './UntrustedQuotes.vue';

const store = useOpsStore();
const scroller = ref<HTMLElement | null>(null);

// ── 紧凑事件脉络条：timeline/upsert 事件 + 证据便签（图标+文字双通道） ──
const STRIP_TONE: Record<TimelineStripEntry['tone'], { icon: string; cls: string }> = {
  confirmed: { icon: 'codicon-check', cls: 'tstrip__chip--confirmed' },
  hypothesis: { icon: 'codicon-warning', cls: 'tstrip__chip--hypothesis' },
  pending: { icon: 'codicon-circle-outline', cls: 'tstrip__chip--pending' },
  info: { icon: 'codicon-circle-outline', cls: 'tstrip__chip--info' },
  warn: { icon: 'codicon-warning', cls: 'tstrip__chip--warn' },
  crit: { icon: 'codicon-error', cls: 'tstrip__chip--crit' }
};

const STRIP_LABEL_CAP = 28;

function stripLabel(label: string): string {
  return label.length > STRIP_LABEL_CAP ? `${label.slice(0, STRIP_LABEL_CAP)}…` : label;
}

// ── notice 卡（P0-D 可行动错误）：variant 三态图标 + 动作按钮 ──
const NOTICE_META: Record<string, { icon: string; cls: string }> = {
  error: { icon: 'codicon-error', cls: 'notice--error' },
  info: { icon: 'codicon-info', cls: 'notice--info' },
  success: { icon: 'codicon-check', cls: 'notice--success' }
};

function noticeMeta(variant: string): { icon: string; cls: string } {
  return NOTICE_META[variant] ?? NOTICE_META.info;
}

function commandHref(action: NoticeAction): string {
  if (!action.command) {
    return '';
  }
  return action.command.startsWith('command:') ? action.command : `command:${action.command}`;
}

// ── 只读工具聚合组（P1-2）：默认折叠，点击展开逐条工具卡 ──
const openGroups = reactive(new Set<string>());

function toggleGroup(id: string): void {
  if (openGroups.has(id)) {
    openGroups.delete(id);
  } else {
    openGroups.add(id);
  }
}

// ── 简单块级虚拟化：仅当条目数超过阈值时，只渲染滚动位置 ± OVERSCAN 的窗口 ──
const VIRTUAL_MIN = 80;
const EST_HEIGHT = 72; // 未渲染块的估高（px），只影响滚动条比例
const OVERSCAN = 20;

const range = ref({ start: 0, end: Number.MAX_SAFE_INTEGER });
const virtual = computed(() => store.renderItems.length > VIRTUAL_MIN);

const visibleEntries = computed(() =>
  virtual.value ? store.renderItems.slice(range.value.start, range.value.end) : store.renderItems
);
const padTop = computed(() => (virtual.value ? range.value.start * EST_HEIGHT : 0));
const padBottom = computed(() =>
  virtual.value ? Math.max(0, store.renderItems.length - range.value.end) * EST_HEIGHT : 0
);

function updateRange(): void {
  if (!virtual.value) {
    return;
  }
  const el = scroller.value;
  if (!el) {
    return;
  }
  const first = Math.floor(el.scrollTop / EST_HEIGHT);
  const count = Math.ceil(el.clientHeight / EST_HEIGHT);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(store.renderItems.length, first + count + OVERSCAN);
  if (start !== range.value.start || end !== range.value.end) {
    range.value = { start, end };
  }
}

// 滚动：rAF 节流更新窗口；滚动位置进 getState（仅 UI 状态，非真源）
let scrollRaf = 0;
function onScroll(): void {
  if (scrollRaf) {
    return;
  }
  scrollRaf = window.requestAnimationFrame(() => {
    scrollRaf = 0;
    updateRange();
    const api = getVsCodeApi();
    const prev = (api.getState() as Record<string, unknown> | undefined) ?? {};
    api.setState({ ...prev, transcriptScrollTop: scroller.value?.scrollTop ?? 0 });
  });
}

function nearBottom(): boolean {
  const el = scroller.value;
  if (!el) {
    return true;
  }
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scrollToBottom(): void {
  const el = scroller.value;
  if (!el) {
    return;
  }
  if (virtual.value) {
    // 先把窗口挪到末尾再滚，保证最后一屏是真实渲染的
    const count = Math.ceil(el.clientHeight / EST_HEIGHT);
    range.value = {
      start: Math.max(0, store.renderItems.length - count - OVERSCAN),
      end: store.renderItems.length
    };
  }
  el.scrollTop = el.scrollHeight;
}

watch(
  () => [store.items.length, store.streaming ? Date.now() : 0],
  async (_next, _prev) => {
    const stick = nearBottom();
    await nextTick();
    if (stick) {
      scrollToBottom();
    } else {
      updateRange();
    }
  },
  { deep: false }
);

onMounted(async () => {
  await nextTick();
  const state = getVsCodeApi().getState() as { transcriptScrollTop?: number } | undefined;
  const el = scroller.value;
  if (el && typeof state?.transcriptScrollTop === 'number') {
    el.scrollTop = state.transcriptScrollTop;
  }
  updateRange();
});

/** 审批行：批准/拒绝/超时 · HH:mm:ss；旧会话无 decision 仍显示「已处理」。 */
function approvalOutcomeText(item: { decision?: string; ts?: number }): string {
  let label: string;
  switch (item.decision) {
    case 'approved':
      label = t('approvalApprove');
      break;
    case 'rejected':
      label = t('approvalReject');
      break;
    case 'timeout':
      label = t('approvalTimeout');
      break;
    case 'pending':
      label = t('approvalPendingDecision');
      break;
    default:
      return t('approvalHandled');
  }
  if (typeof item.ts === 'number') {
    return `${label} · ${new Date(item.ts).toLocaleTimeString()}`;
  }
  return label;
}

function thinkingLabel(item: { durationMs?: number }): string {
  const duration = formatThinkingDurationMs(item.durationMs);
  return duration ? tf('thinkingDuration', { duration }) : t('thinkingInProgress');
}
</script>

<template>
  <div class="transcript-wrap">
    <div v-if="store.timelineStrip.length > 0" class="tstrip" :aria-label="t('timelineStrip')">
      <span class="tstrip__label ops-muted">{{ t('timelineStrip') }}</span>
      <span
        v-for="entry in store.timelineStrip"
        :key="entry.id"
        class="tstrip__chip"
        :class="STRIP_TONE[entry.tone].cls"
        :title="entry.label"
      >
        <span class="codicon tstrip__icon" :class="STRIP_TONE[entry.tone].icon" aria-hidden="true"></span
        >{{ stripLabel(entry.label) }}
      </span>
    </div>

    <!-- 空态由 ChatApp 的欢迎页承接（items 为空时本组件不渲染），避免双重空态 -->
    <div ref="scroller" class="transcript" role="log" :aria-label="t('transcriptAria')" @scroll="onScroll">
    <div v-if="padTop > 0" class="transcript__pad" :style="{ height: padTop + 'px' }" aria-hidden="true"></div>
    <template v-for="entry in visibleEntries" :key="entry.id">
      <!-- 连续只读工具聚合组：折叠头一行，展开后逐条工具卡 -->
      <section v-if="entry.kind === 'toolGroup'" class="toolgroup">
        <button
          type="button"
          class="toolgroup__head"
          :aria-expanded="openGroups.has(entry.id)"
          @click="toggleGroup(entry.id)"
        >
          <span
            class="codicon"
            :class="openGroups.has(entry.id) ? 'codicon-chevron-down' : 'codicon-chevron-right'"
            aria-hidden="true"
          ></span>
          <span class="codicon codicon-tools" aria-hidden="true"></span>
          <span class="toolgroup__label">{{ tf('toolGroupReads', { count: entry.items.length }) }}</span>
        </button>
        <div v-if="openGroups.has(entry.id)" class="toolgroup__body">
          <ToolCallCard v-for="toolItem in entry.items" :key="toolItem.id" :call="toolItem.call" />
        </div>
      </section>

      <template v-else-if="entry.kind === 'item'">
        <div v-if="entry.item.kind === 'user'" class="transcript__msg transcript__msg--user">
          <span class="transcript__who">{{ t('roleUser') }}</span>
          <div class="transcript__text transcript__well">{{ entry.item.text }}</div>
        </div>

        <!-- 空 assistant 不占位（docs/14 P1-ui）：空正文已结束 ⇒ 无 DOM；
             空正文流式中 ⇒ 单行「正在巡检…」；其余照常渲染 -->
        <template v-else-if="entry.item.kind === 'assistant'">
          <div
            v-if="assistantDisplay(entry.item) === 'progress'"
            class="transcript__inspecting ops-muted"
            role="status"
          >
            <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
            <span>{{ t('inspectingProgress') }}</span>
          </div>
          <div
            v-else-if="assistantDisplay(entry.item) === 'content'"
            class="transcript__msg transcript__msg--agent"
          >
            <span class="transcript__who-row">
              <span class="transcript__who transcript__who--agent">{{ t('roleAgent') }}</span>
              <button
                type="button"
                class="ops-copy-btn transcript__save-doc"
                :aria-label="t('saveOpsDocAria')"
                :title="t('saveOpsDocAria')"
                @click.stop="store.saveOpsDoc(entry.item.id)"
              >
                <span class="codicon codicon-save" aria-hidden="true"></span>
              </button>
            </span>
            <div v-if="entry.item.error" class="transcript__text transcript__text--error">
              {{ entry.item.text }}
            </div>
            <template v-else>
              <MarkdownBlock :source="entry.item.text" :streaming="!!entry.item.streaming" />
              <span v-if="entry.item.streaming" class="transcript__caret" :aria-label="t('generating')">▍</span>
            </template>
            <!-- 失败可重试（P1-5）：错误 footer + Retry -->
            <div v-if="entry.item.error && entry.item.retryable" class="transcript__retry">
              <button
                type="button"
                class="ops-btn ops-btn--secondary transcript__retry-btn"
                :aria-label="t('retryAria')"
                @click="store.retryAssistant(entry.item.id)"
              >
                <span class="codicon codicon-refresh" aria-hidden="true"></span> {{ t('retry') }}
              </button>
            </div>
          </div>
        </template>

        <!-- thinking：CoT 正文永不渲染（对齐 pi hideThinkingBlock，无 expander）；
             showThinking 时只出时长行；untrustedQuotes 警示块始终可出。 -->
        <template v-else-if="entry.item.kind === 'thinking'">
          <div
            v-if="thinkingMetaVisible(store.showThinking, store.conclusionMode)"
            class="transcript__thinking ops-muted"
            role="status"
          >
            <span
              class="codicon"
              :class="
                entry.item.durationMs == null
                  ? 'codicon-loading codicon-modifier-spin'
                  : 'codicon-light-bulb'
              "
              aria-hidden="true"
            ></span>
            <span>{{ thinkingLabel(entry.item) }}</span>
          </div>
          <UntrustedQuotes
            v-if="visibleUntrustedQuotes(entry.item).length > 0"
            :quotes="visibleUntrustedQuotes(entry.item)"
          />
        </template>

        <ToolCallCard v-else-if="entry.item.kind === 'tool'" :call="entry.item.call" />

        <SubagentBoard v-else-if="entry.item.kind === 'subagents'" :agents="entry.item.agents" />

        <EvidenceNote v-else-if="entry.item.kind === 'evidence'" :note="entry.item.note" />

        <div v-else-if="entry.item.kind === 'approval'" class="transcript__approval-ref ops-muted">
          <span class="codicon codicon-warning" aria-hidden="true"></span>
          {{ t('approvalRequestLabel') }} <span class="ops-mono">{{ entry.item.briefId }}</span>
          <span v-if="store.pendingApproval && store.pendingApproval.id === entry.item.briefId">{{ t('approvalSeeBelow') }}</span>
          <span v-else>{{ approvalOutcomeText(entry.item) }}</span>
        </div>

        <!-- notice 卡（P0-D）：一句人话原因 + 动作按钮（打开设置 / 诊断 / 重试） -->
        <section
          v-else-if="entry.item.kind === 'notice'"
          class="notice"
          :class="noticeMeta(entry.item.variant).cls"
          role="note"
        >
          <div class="notice__row">
            <span class="codicon notice__icon" :class="noticeMeta(entry.item.variant).icon" aria-hidden="true"></span>
            <span class="notice__text">{{ entry.item.text }}</span>
          </div>
          <div v-if="entry.item.actions && entry.item.actions.length > 0" class="notice__actions">
            <template v-for="action in entry.item.actions" :key="action.id">
              <a v-if="action.command" class="ops-btn ops-btn--secondary notice__btn" :href="commandHref(action)">
                {{ action.label }}
              </a>
              <button
                v-else
                type="button"
                class="ops-btn ops-btn--secondary notice__btn"
                @click="store.runNoticeAction(action)"
              >
                {{ action.label }}
              </button>
            </template>
          </div>
        </section>

        <!-- system：compaction 等低调系统行 -->
        <div v-else-if="entry.item.kind === 'system'" class="transcript__system ops-muted">
          <span class="codicon codicon-info" aria-hidden="true"></span>
          <span>{{ entry.item.text }}</span>
        </div>
      </template>
    </template>
    <div v-if="padBottom > 0" class="transcript__pad" :style="{ height: padBottom + 'px' }" aria-hidden="true"></div>
    </div>
  </div>
</template>

<style scoped>
.transcript-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* 事件脉络条：不随消息滚动，压在 transcript 顶部 */
.tstrip {
  display: flex;
  align-items: baseline;
  gap: var(--ops-space-1);
  flex-wrap: wrap;
  padding: var(--ops-space-1) var(--ops-space-2);
  border-bottom: 1px solid var(--ops-border);
  font-size: var(--ops-font-xs);
}

.tstrip__label {
  flex: 0 0 auto;
  font-size: var(--ops-font-xs);
}

.tstrip__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid currentColor;
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-space-1);
  line-height: 1.5;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tstrip__icon {
  font-size: var(--ops-font-xs);
}

.tstrip__chip--confirmed {
  color: var(--ops-healthy);
}

.tstrip__chip--hypothesis,
.tstrip__chip--warn {
  color: var(--ops-warn);
}

.tstrip__chip--pending,
.tstrip__chip--info {
  color: var(--ops-pending);
}

.tstrip__chip--crit {
  color: var(--ops-crit);
}

.transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* Plan 12 T11：收敛到 4/8（--ops-space-1 / --ops-space-2），不用 12px space-3 */
  padding: var(--ops-space-1) var(--ops-space-2);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.transcript__pad {
  flex: 0 0 auto;
}

/* Copilot 式分组：角色标签在上，正文在下；用户消息右侧成井，Agent 左侧全宽 */
.transcript__msg {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.transcript__msg--user {
  align-self: flex-end;
  align-items: flex-end;
  max-width: 88%;
}

.transcript__msg--agent {
  align-self: stretch;
}

.transcript__who {
  font-size: var(--ops-font-xs);
  color: var(--ops-muted);
  line-height: 1.4;
}

.transcript__who--agent {
  color: var(--ops-accent);
  font-weight: 600;
}

.transcript__who-row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-width: 0;
}

.transcript__save-doc {
  opacity: 0;
  width: 22px;
  height: 22px;
}

.transcript__msg--agent:hover .transcript__save-doc,
.transcript__save-doc:focus-visible {
  opacity: 1;
}

.transcript__well {
  background: var(--ops-user-msg-bg);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-3);
}

.transcript__text {
  white-space: pre-wrap;
  word-break: break-word;
  min-width: 0;
  line-height: 1.55;
}

.transcript__text--error {
  color: var(--ops-crit);
}

.transcript__caret {
  color: var(--ops-accent);
  animation: transcript-blink 1s steps(2) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .transcript__caret {
    animation: none;
  }
}

/* 空 assistant 流式占位：单行低调「正在巡检…」 */
.transcript__inspecting {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  font-size: var(--ops-font-sm);
}

.transcript__thinking {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  font-size: var(--ops-font-sm);
}

.transcript__retry {
  margin-top: var(--ops-space-1);
}

.transcript__retry-btn {
  padding: 1px var(--ops-space-2);
  font-size: var(--ops-font-sm);
}

.transcript__approval-ref {
  font-size: var(--ops-font-sm);
}

.transcript__system {
  display: flex;
  align-items: baseline;
  gap: var(--ops-space-2);
  font-size: var(--ops-font-sm);
  justify-content: center;
  text-align: center;
}

/* 只读工具聚合组 */
.toolgroup {
  border: 1px solid var(--ops-border);
  border-left: 3px solid var(--ops-read);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
}

.toolgroup__head {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  width: 100%;
  background: transparent;
  border: none;
  padding: 2px 0;
  color: var(--ops-muted);
  cursor: pointer;
  font-size: var(--ops-font-sm);
  text-align: left;
}

.toolgroup__head:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.toolgroup__label {
  color: var(--ops-fg);
}

.toolgroup__body {
  margin-top: var(--ops-space-1);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-1);
}

/* notice 卡：与 assistant 气泡区分的可行动错误/提示 */
.notice {
  border: 1px solid var(--ops-border);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.notice--error {
  border-left-color: var(--ops-crit);
}

.notice--error .notice__icon {
  color: var(--ops-crit);
}

.notice--info {
  border-left-color: var(--ops-accent);
}

.notice--info .notice__icon {
  color: var(--ops-accent);
}

.notice--success {
  border-left-color: var(--ops-healthy);
}

.notice--success .notice__icon {
  color: var(--ops-healthy);
}

.notice__row {
  display: flex;
  align-items: baseline;
  gap: var(--ops-space-2);
  min-width: 0;
}

.notice__text {
  min-width: 0;
  word-break: break-word;
  line-height: 1.5;
}

.notice__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2);
}

.notice__btn {
  padding: 1px var(--ops-space-2);
  font-size: var(--ops-font-sm);
  text-decoration: none;
  line-height: 1.7;
}

@keyframes transcript-blink {
  50% {
    opacity: 0;
  }
}
</style>
