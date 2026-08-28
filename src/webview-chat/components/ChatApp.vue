<script setup lang="ts">
import { t } from '../i18n';
import { useOpsStore } from '../store';
import ApprovalBar from './ApprovalBar.vue';
import ChatTranscript from './ChatTranscript.vue';
import Composer from './Composer.vue';
import HistoryOverlay from './HistoryOverlay.vue';
import PlaybookHeader from './PlaybookHeader.vue';
import PlaybookPicker from './PlaybookPicker.vue';
import WelcomeState from './WelcomeState.vue';

const store = useOpsStore();
</script>

<template>
  <div class="chat-app">
    <PlaybookHeader />
    <!-- 空态走欢迎页（标题 + 建议卡），transcript 不再渲染自己的空提示 -->
    <WelcomeState v-if="store.items.length === 0" class="chat-app__transcript" />
    <ChatTranscript v-else class="chat-app__transcript" />
    <div class="chat-app__dock">
      <PlaybookPicker v-if="store.activePicker === 'playbook'" class="chat-app__picker" />
      <!-- 能力插件健康：composer 上方一条低调的点簇，不再占一整条状态栏 -->
      <div
        v-if="store.providerChips.length > 0 || store.mock"
        class="chat-app__health"
        :aria-label="t('healthAria')"
      >
        <span
          v-for="p in store.providerChips"
          :key="p.id"
          class="chat-app__health-chip"
          :class="p.connected ? 'chat-app__health-chip--ok' : 'chat-app__health-chip--off'"
          :title="p.id + ' · ' + p.label + ' ' + (p.connected ? t('connected') : t('disconnected'))"
        >
          <span
            class="codicon chat-app__health-icon"
            :class="p.connected ? 'codicon-circle-filled' : 'codicon-circle-outline'"
            aria-hidden="true"
          ></span>
          <span class="chat-app__health-label">{{ p.label }}</span>
        </span>
        <span v-if="store.mock" class="chat-app__mock" :title="t('mockHint')">
          mock
        </span>
      </div>
      <ApprovalBar v-if="store.pendingApproval" />
      <Composer />
    </div>
    <HistoryOverlay v-if="store.historyOpen" />
  </div>
</template>

<style scoped>
.chat-app {
  position: relative;
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

.chat-app__health {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: calc(var(--ops-density) * 1.5);
  padding: 2px calc(var(--ops-density) * 2);
  font-size: calc(var(--ops-font-size) - 3px);
  color: var(--ops-muted);
  min-width: 0;
}

/* 连接态双通道：圆点 codicon + title 里的「已连接/未连接」文字 */
.chat-app__health-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
  overflow: hidden;
}

.chat-app__health-icon {
  font-size: 8px;
}

.chat-app__health-chip--ok {
  color: var(--ops-healthy);
}

.chat-app__health-chip--off {
  color: var(--ops-pending);
}

.chat-app__health-label {
  color: var(--ops-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-app__mock {
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
}
</style>
