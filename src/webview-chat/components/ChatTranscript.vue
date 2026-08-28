<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useOpsStore } from '../store';
import EvidenceNote from './EvidenceNote.vue';
import SubagentBoard from './SubagentBoard.vue';
import ThinkingTrace from './ThinkingTrace.vue';
import ToolCallCard from './ToolCallCard.vue';

const store = useOpsStore();
const scroller = ref<HTMLElement | null>(null);

function nearBottom(): boolean {
  const el = scroller.value;
  if (!el) {
    return true;
  }
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

watch(
  () => [store.items.length, store.streaming ? Date.now() : 0],
  async (_next, _prev) => {
    const stick = nearBottom();
    await nextTick();
    const el = scroller.value;
    if (el && stick) {
      el.scrollTop = el.scrollHeight;
    }
  },
  { deep: false }
);
</script>

<template>
  <div ref="scroller" class="transcript" role="log" aria-label="会话记录">
    <div v-if="store.items.length === 0" class="transcript__empty ops-muted">
      描述你的运维问题，或粘贴告警文本开始调查。
    </div>
    <template v-for="item in store.items" :key="item.id">
      <div v-if="item.kind === 'user'" class="transcript__row transcript__row--user">
        <span class="transcript__who">你</span>
        <div class="transcript__text">{{ item.text }}</div>
      </div>

      <div v-else-if="item.kind === 'assistant'" class="transcript__row">
        <span class="transcript__who transcript__who--agent">Agent</span>
        <div class="transcript__text">
          {{ item.text }}<span v-if="item.streaming" class="transcript__caret" aria-label="生成中">▍</span>
        </div>
      </div>

      <ThinkingTrace
        v-else-if="item.kind === 'thinking'"
        :steps="item.steps"
        :untrusted-quotes="item.untrustedQuotes"
      />

      <ToolCallCard v-else-if="item.kind === 'tool'" :call="item.call" />

      <SubagentBoard v-else-if="item.kind === 'subagents'" :agents="item.agents" />

      <EvidenceNote v-else-if="item.kind === 'evidence'" :note="item.note" />

      <div v-else-if="item.kind === 'approval'" class="transcript__approval-ref ops-muted">
        ⚠ 审批请求 <span class="ops-mono">{{ item.briefId }}</span>
        <span v-if="store.pendingApproval && store.pendingApproval.id === item.briefId">（见下方审批栏）</span>
        <span v-else>（已处理）</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.transcript {
  overflow-y: auto;
  padding: calc(var(--ops-density) * 2);
  display: flex;
  flex-direction: column;
  gap: calc(var(--ops-density) * 2);
}

.transcript__empty {
  padding: calc(var(--ops-density) * 4) var(--ops-density);
  text-align: center;
}

.transcript__row {
  display: flex;
  gap: calc(var(--ops-density) * 2);
  align-items: baseline;
}

.transcript__who {
  flex: 0 0 auto;
  font-size: calc(var(--ops-font-size) - 2px);
  color: var(--ops-muted);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
  line-height: 1.6;
}

.transcript__who--agent {
  color: var(--ops-accent);
  border-color: var(--ops-accent);
}

.transcript__row--user .transcript__text {
  color: var(--ops-fg);
  font-weight: 500;
}

.transcript__text {
  white-space: pre-wrap;
  word-break: break-word;
  min-width: 0;
  line-height: 1.5;
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
