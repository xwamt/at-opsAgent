<script setup lang="ts">
import { t } from '../../webview-chat/i18n';
import { useBoardStore } from '../store';
import IncidentTimeline from './IncidentTimeline.vue';

const store = useBoardStore();
</script>

<template>
  <div class="board">
    <header class="board__head">
      <span class="board__title">{{ t('boardTitle') }}</span>
      <span class="ops-muted">{{ store.events.length }} {{ t('boardCountUnit') }}</span>
      <span v-if="store.mock" class="board__mock" title="未检测到 acquireVsCodeApi，使用本地 mock host">mock</span>
    </header>
    <IncidentTimeline class="board__timeline" />
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.board__head {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 2);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-bottom: 1px solid var(--ops-border);
  font-size: calc(var(--ops-font-size) - 1px);
}

.board__title {
  font-weight: 600;
}

.board__mock {
  margin-left: auto;
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
  font-size: calc(var(--ops-font-size) - 2px);
}

.board__timeline {
  flex: 1;
  min-height: 0;
}
</style>
