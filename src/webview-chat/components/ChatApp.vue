<script setup lang="ts">
import { computed } from 'vue';
import { useOpsStore } from '../store';
import ApprovalBar from './ApprovalBar.vue';
import ChatTranscript from './ChatTranscript.vue';
import Composer from './Composer.vue';
import PlaybookHeader from './PlaybookHeader.vue';

const store = useOpsStore();

const modelLabel = computed(() => store.modelLabel || '模型未设置');
const runState = computed(() => (store.streaming ? '运行中' : '空闲'));
const sessionShort = computed(() =>
  store.sessionId ? store.sessionId.slice(0, 12) : '无会话'
);
</script>

<template>
  <div class="chat-app">
    <PlaybookHeader />
    <ChatTranscript class="chat-app__transcript" />
    <ApprovalBar v-if="store.pendingApproval" />
    <Composer />
    <footer class="chat-app__statusbar" aria-label="会话状态">
      <span class="chat-app__model" :title="'当前模型 · 会话 ' + store.sessionId">{{ modelLabel }}</span>
      <span aria-hidden="true">·</span>
      <span :class="{ 'chat-app__running': store.streaming }">{{ runState }}</span>
      <span aria-hidden="true">·</span>
      <span class="ops-muted">{{ sessionShort }}</span>
      <span class="chat-app__providers">
        <span
          v-for="p in store.providerChips"
          :key="p.id"
          class="chat-app__provider"
          :class="p.connected ? 'chat-app__provider--ok' : 'chat-app__provider--off'"
          :title="p.label + (p.connected ? ' 已连接' : ' 未连接')"
        >
          {{ p.id }} {{ p.connected ? '✓' : '✗' }}
        </span>
        <span v-if="store.providerChips.length === 0" class="ops-muted">无能力插件</span>
      </span>
      <span v-if="store.mock" class="chat-app__mock" title="未检测到 acquireVsCodeApi，使用本地 mock host">mock</span>
    </footer>
  </div>
</template>

<style scoped>
.chat-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.chat-app__transcript {
  flex: 1 1 auto;
  min-height: 0;
}

.chat-app__statusbar {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 1.5);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-top: 1px solid var(--ops-border);
  font-size: calc(var(--ops-font-size) - 2px);
  color: var(--ops-muted);
  overflow: hidden;
  white-space: nowrap;
}

.chat-app__model {
  color: var(--ops-fg);
}

.chat-app__running {
  color: var(--ops-accent);
}

.chat-app__providers {
  display: flex;
  gap: calc(var(--ops-density) * 1.5);
  margin-left: auto;
  overflow: hidden;
}

.chat-app__provider--ok {
  color: var(--ops-healthy);
}

.chat-app__provider--off {
  color: var(--ops-pending);
}

.chat-app__mock {
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
}
</style>
