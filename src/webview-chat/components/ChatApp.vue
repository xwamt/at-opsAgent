<script setup lang="ts">
import { t, tf } from '../i18n';
import { useOpsStore } from '../store';
import { subagentTitle } from '../store-helpers';
import ApprovalBar from './ApprovalBar.vue';
import ChatTranscript from './ChatTranscript.vue';
import Composer from './Composer.vue';
import HistoryOverlay from './HistoryOverlay.vue';
import PlaybookHeader from './PlaybookHeader.vue';
import PlaybookPicker from './PlaybookPicker.vue';
import SubagentInspector from './SubagentInspector.vue';
import WelcomeState from './WelcomeState.vue';

const store = useOpsStore();
</script>

<template>
  <div class="chat-app">
    <PlaybookHeader />
    <!-- Kilo 式后台代理运行条：有 queued/running 子代理时常驻一行，支持点击任意子代理打开 inspector -->
    <div
      v-if="store.activeSubagents.length > 0"
      class="chat-app__agents"
      :aria-label="t('subagentStripAria')"
    >
      <span class="codicon codicon-loading codicon-modifier-spin chat-app__agents-icon" aria-hidden="true"></span>
      <span class="chat-app__agents-count">{{ tf('subagentStripCount', { count: store.activeSubagents.length }) }}</span>
      <div v-if="store.activeSubagents.length > 1" class="chat-app__agents-chips">
        <button
          v-for="sa in store.activeSubagents"
          :key="sa.taskId"
          type="button"
          class="chat-app__agent-chip"
          :title="subagentTitle(sa)"
          @click="store.inspectSubagent(sa.taskId)"
        >
          <span class="chat-app__agent-chip-text">{{ subagentTitle(sa) }}</span>
        </button>
      </div>
      <button
        v-else
        type="button"
        class="chat-app__agents-goal ops-muted"
        @click="store.inspectSubagent(store.activeSubagents[0].taskId)"
      >
        {{ subagentTitle(store.activeSubagents[0]) }}
      </button>
    </div>
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
    <!-- 子代理 inspector 抬升到 ChatApp（docs/12 §3）：Teleport 到 body，
         不受 transcript overflow 裁剪——看板滚出视口时顶栏条点击也能看到弹层 -->
    <Teleport to="body">
      <SubagentInspector v-if="store.inspectedSubagent" />
    </Teleport>
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

/* 后台代理运行条：不随 transcript 滚走，支持多子代理并列显示 */
.chat-app__agents {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  width: 100%;
  min-width: 0;
  padding: var(--ops-space-1) var(--ops-space-3);
  background: transparent;
  border-bottom: 1px solid var(--ops-border);
  color: var(--ops-fg);
  font-size: var(--ops-font-sm);
  text-align: left;
}

.chat-app__agents-icon {
  color: var(--ops-accent);
  font-size: var(--ops-font-sm);
  flex: 0 0 auto;
}

.chat-app__agents-count {
  white-space: nowrap;
  flex: 0 0 auto;
}

.chat-app__agents-chips {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1 1 auto;
  min-width: 0;
}

.chat-app__agents-chips::-webkit-scrollbar {
  display: none;
}

.chat-app__agent-chip {
  background: color-mix(in srgb, var(--ops-fg) 8%, transparent);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
  padding: 1px 6px;
  color: var(--ops-fg);
  cursor: pointer;
  font-size: var(--ops-font-xs);
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-app__agent-chip:hover {
  background: var(--ops-hover-bg);
  border-color: var(--ops-accent);
}

.chat-app__agent-chip:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.chat-app__agents-goal {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  border: none;
  color: var(--ops-muted);
  cursor: pointer;
  font-size: var(--ops-font-sm);
  text-align: left;
  padding: 0;
}

.chat-app__agents-goal:hover {
  color: var(--ops-fg);
  text-decoration: underline;
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
