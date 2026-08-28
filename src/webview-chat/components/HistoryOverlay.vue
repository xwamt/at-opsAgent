<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { getLocale, t } from '../i18n';
import { useOpsStore } from '../store';

const store = useOpsStore();

function close(): void {
  store.toggleHistory(false);
}

function formatTime(createdAt: number): string {
  if (!createdAt) {
    return '';
  }
  return new Date(createdAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
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
  <div class="history" role="dialog" aria-modal="true" :aria-label="t('historyTitle')">
    <div class="history__backdrop" aria-hidden="true" @click="close"></div>
    <aside class="history__panel">
      <header class="history__head">
        <span class="history__title">{{ t('historyTitle') }}</span>
        <span class="history__spacer"></span>
        <button type="button" class="ops-btn ops-btn--secondary history__new" @click="store.newSession()">
          ＋ {{ t('historyNew') }}
        </button>
        <button
          type="button"
          class="history__close"
          :aria-label="t('historyCloseAria')"
          @click="close"
        >
          ✕
        </button>
      </header>
      <div class="history__list">
        <button
          v-for="session in store.historySessions"
          :key="session.id"
          type="button"
          class="history__item"
          :class="{ 'history__item--current': session.id === store.sessionId }"
          :aria-label="t('historySwitchAria') + ' ' + session.title"
          @click="store.switchSession(session.id)"
        >
          <span class="history__item-row">
            <span class="history__item-title">{{ session.title }}</span>
            <span v-if="session.id === store.sessionId" class="history__item-badge">
              {{ t('historyCurrent') }}
            </span>
          </span>
          <span class="history__item-meta ops-mono ops-muted">
            {{ session.id.slice(0, 12) }}<template v-if="session.createdAt"> · {{ formatTime(session.createdAt) }}</template>
          </span>
        </button>
        <p v-if="store.historySessions.length === 0" class="history__empty ops-muted">
          {{ t('historyEmpty') }}
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.history {
  position: absolute;
  inset: 0;
  z-index: 20;
}

.history__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
}

/* Cline 式 History：侧滑覆盖层，不占常驻 chrome */
.history__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(320px, 88%);
  background: var(--ops-bg);
  border-left: 1px solid var(--ops-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  animation: history-slide 0.15s ease-out;
}

@keyframes history-slide {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.history__head {
  display: flex;
  align-items: center;
  gap: var(--ops-density);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-bottom: 1px solid var(--ops-border);
}

.history__title {
  font-weight: 600;
}

.history__spacer {
  flex: 1;
}

.history__new {
  padding: 1px calc(var(--ops-density) + 2px);
  font-size: calc(var(--ops-font-size) - 2px);
  white-space: nowrap;
}

.history__close {
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 2px var(--ops-density);
  line-height: 1;
}

.history__close:hover {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
}

.history__close:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.history__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--ops-density);
}

.history__item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) + 2px);
  color: var(--ops-fg);
  cursor: pointer;
  min-width: 0;
}

.history__item:hover,
.history__item:focus-visible {
  background: var(--ops-hover-bg);
  outline: none;
}

.history__item:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.history__item--current {
  border-left: 2px solid var(--ops-accent);
}

.history__item-row {
  display: flex;
  align-items: baseline;
  gap: var(--ops-density);
  min-width: 0;
}

.history__item-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history__item-badge {
  flex: 0 0 auto;
  font-size: calc(var(--ops-font-size) - 3px);
  color: var(--ops-accent);
  border: 1px solid var(--ops-accent);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
  line-height: 1.5;
}

.history__item-meta {
  font-size: calc(var(--ops-font-size) - 3px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history__empty {
  margin: var(--ops-density);
  text-align: center;
}
</style>
