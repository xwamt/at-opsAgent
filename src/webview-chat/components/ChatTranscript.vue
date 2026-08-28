<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import { visibleUntrustedQuotes, type TimelineStripEntry } from '../store-helpers';
import { getVsCodeApi } from '../vscode-api';
import EvidenceNote from './EvidenceNote.vue';
import SubagentBoard from './SubagentBoard.vue';
import ToolCallCard from './ToolCallCard.vue';
import UntrustedQuotes from './UntrustedQuotes.vue';

const store = useOpsStore();
const scroller = ref<HTMLElement | null>(null);

// ── 紧凑事件脉络条：timeline/upsert 事件 + 证据便签（图标+文字双通道） ──
const STRIP_TONE: Record<TimelineStripEntry['tone'], { icon: string; cls: string }> = {
  confirmed: { icon: '✓', cls: 'tstrip__chip--confirmed' },
  hypothesis: { icon: '△', cls: 'tstrip__chip--hypothesis' },
  pending: { icon: '○', cls: 'tstrip__chip--pending' },
  info: { icon: '○', cls: 'tstrip__chip--info' },
  warn: { icon: '△', cls: 'tstrip__chip--warn' },
  crit: { icon: '✗', cls: 'tstrip__chip--crit' }
};

const STRIP_LABEL_CAP = 28;

function stripLabel(label: string): string {
  return label.length > STRIP_LABEL_CAP ? `${label.slice(0, STRIP_LABEL_CAP)}…` : label;
}

// ── 简单块级虚拟化：仅当消息数超过阈值时，只渲染滚动位置 ± OVERSCAN 的窗口 ──
const VIRTUAL_MIN = 80;
const EST_HEIGHT = 72; // 未渲染块的估高（px），只影响滚动条比例
const OVERSCAN = 20;

const range = ref({ start: 0, end: Number.MAX_SAFE_INTEGER });
const virtual = computed(() => store.items.length > VIRTUAL_MIN);

const visibleItems = computed(() =>
  virtual.value ? store.items.slice(range.value.start, range.value.end) : store.items
);
const padTop = computed(() => (virtual.value ? range.value.start * EST_HEIGHT : 0));
const padBottom = computed(() =>
  virtual.value ? Math.max(0, store.items.length - range.value.end) * EST_HEIGHT : 0
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
  const end = Math.min(store.items.length, first + count + OVERSCAN);
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
      start: Math.max(0, store.items.length - count - OVERSCAN),
      end: store.items.length
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
        <span aria-hidden="true">{{ STRIP_TONE[entry.tone].icon }}</span>{{ stripLabel(entry.label) }}
      </span>
    </div>

    <!-- 空态由 ChatApp 的欢迎页承接（items 为空时本组件不渲染），避免双重空态 -->
    <div ref="scroller" class="transcript" role="log" aria-label="会话记录" @scroll="onScroll">
    <div v-if="padTop > 0" class="transcript__pad" :style="{ height: padTop + 'px' }" aria-hidden="true"></div>
    <template v-for="item in visibleItems" :key="item.id">
      <div v-if="item.kind === 'user'" class="transcript__msg transcript__msg--user">
        <span class="transcript__who">{{ t('roleUser') }}</span>
        <div class="transcript__text transcript__well">{{ item.text }}</div>
      </div>

      <div v-else-if="item.kind === 'assistant'" class="transcript__msg transcript__msg--agent">
        <span class="transcript__who transcript__who--agent">{{ t('roleAgent') }}</span>
        <div class="transcript__text">
          {{ item.text }}<span v-if="item.streaming" class="transcript__caret" aria-label="生成中">▍</span>
        </div>
      </div>

      <!-- thinking：CoT 永不渲染（对齐 pi hideThinkingBlock，恒为隐藏）；
           仅 untrustedQuotes 警示块可见。item 仍占虚拟化索引，只是不产出 DOM。 -->
      <template v-else-if="item.kind === 'thinking'">
        <UntrustedQuotes
          v-if="visibleUntrustedQuotes(item).length > 0"
          :quotes="visibleUntrustedQuotes(item)"
        />
      </template>

      <ToolCallCard v-else-if="item.kind === 'tool'" :call="item.call" />

      <SubagentBoard v-else-if="item.kind === 'subagents'" :agents="item.agents" />

      <EvidenceNote v-else-if="item.kind === 'evidence'" :note="item.note" />

      <div v-else-if="item.kind === 'approval'" class="transcript__approval-ref ops-muted">
        ⚠ 审批请求 <span class="ops-mono">{{ item.briefId }}</span>
        <span v-if="store.pendingApproval && store.pendingApproval.id === item.briefId">（见下方审批栏）</span>
        <span v-else>（已处理）</span>
      </div>
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
  gap: var(--ops-density);
  flex-wrap: wrap;
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-bottom: 1px solid var(--ops-border);
  font-size: calc(var(--ops-font-size) - 2px);
}

.tstrip__label {
  flex: 0 0 auto;
  font-size: calc(var(--ops-font-size) - 3px);
}

.tstrip__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid currentColor;
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
  line-height: 1.5;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
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
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
  font-size: calc(var(--ops-font-size) - 2px);
  color: var(--ops-muted);
  line-height: 1.4;
}

.transcript__who--agent {
  color: var(--ops-accent);
  font-weight: 600;
}

.transcript__well {
  background: var(--ops-user-msg-bg);
  border-radius: var(--ops-radius);
  padding: calc(var(--ops-density) + 2px) calc(var(--ops-density) * 2);
}

.transcript__text {
  white-space: pre-wrap;
  word-break: break-word;
  min-width: 0;
  line-height: 1.55;
}

.transcript__caret {
  color: var(--ops-accent);
  animation: transcript-blink 1s steps(2) infinite;
}

.transcript__approval-ref {
  font-size: calc(var(--ops-font-size) - 1px);
}

@keyframes transcript-blink {
  50% {
    opacity: 0;
  }
}
</style>
