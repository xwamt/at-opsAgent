<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import ApprovalBar from './ApprovalBar.vue';
import ChatTranscript from './ChatTranscript.vue';
import Composer from './Composer.vue';
import HostSessionChip from './HostSessionChip.vue';
import ModelSelector from './ModelSelector.vue';
import PlaybookHeader from './PlaybookHeader.vue';
import PlaybookPicker from './PlaybookPicker.vue';
import SkillPicker from './SkillPicker.vue';

const store = useOpsStore();

const runState = computed(() => (store.streaming ? t('statusRunning') : t('statusIdle')));
const sessionShort = computed(() =>
  store.sessionId ? store.sessionId.slice(0, 12) : t('statusNoSession')
);
</script>

<template>
  <div class="chat-app">
    <PlaybookHeader />
    <ChatTranscript class="chat-app__transcript" />
    <div class="chat-app__dock">
      <PlaybookPicker v-if="store.activePicker === 'playbook'" class="chat-app__picker" />
      <SkillPicker v-else-if="store.activePicker === 'skill'" class="chat-app__picker" />
      <ApprovalBar v-if="store.pendingApproval" />
      <Composer />
    </div>
    <footer class="chat-app__statusbar" aria-label="会话状态">
      <ModelSelector />
      <span aria-hidden="true">·</span>
      <span :class="{ 'chat-app__running': store.streaming }">{{ runState }}</span>
      <span aria-hidden="true">·</span>
      <span class="ops-muted">{{ sessionShort }}</span>
      <span class="chat-app__providers">
        <HostSessionChip
          v-for="p in store.providerChips"
          :key="p.id"
          :plugin-id="p.id"
          :label="p.label"
          :connected="p.connected"
        />
        <span v-if="store.providerChips.length === 0" class="ops-muted">{{ t('statusNoProviders') }}</span>
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

.chat-app__dock {
  position: relative;
}

.chat-app__picker {
  position: absolute;
  bottom: calc(100% + var(--ops-density));
  left: calc(var(--ops-density) * 2);
  right: calc(var(--ops-density) * 2);
  z-index: 10;
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

.chat-app__running {
  color: var(--ops-accent);
}

.chat-app__providers {
  display: flex;
  gap: calc(var(--ops-density) * 1.5);
  margin-left: auto;
  overflow: hidden;
}

.chat-app__mock {
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
}
</style>
