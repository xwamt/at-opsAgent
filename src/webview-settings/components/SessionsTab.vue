<script setup lang="ts">
import { t } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

function formatTime(updatedAt: number | undefined): string {
  if (updatedAt === undefined) {
    return '';
  }
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return '';
  }
}
</script>

<template>
  <section>
    <h2 class="set-title">{{ t('sessionsTitle') }}</h2>

    <div class="set-actions sessions-actions">
      <button type="button" class="ops-btn" @click="store.newSession()">{{ t('sessionsNew') }}</button>
    </div>

    <div v-if="store.sessions.length === 0" class="set-empty">{{ t('sessionsEmpty') }}</div>

    <ul v-else class="sessions">
      <li v-for="session in store.sessions" :key="session.id">
        <button
          type="button"
          class="sessions__item"
          :class="{ 'sessions__item--active': session.active }"
          :disabled="session.active"
          @click="store.switchSession(session.id)"
        >
          <span class="sessions__title">
            {{ session.title }}
            <span v-if="session.active" class="ops-badge sessions__badge">{{ t('sessionsActive') }}</span>
          </span>
          <span class="sessions__meta ops-mono">
            {{ session.id.slice(0, 12) }}
            <template v-if="formatTime(session.updatedAt)"> · {{ formatTime(session.updatedAt) }}</template>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sessions-actions {
  margin: 0 0 12px;
}

.sessions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sessions__item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  cursor: pointer;
  background: transparent;
  color: inherit;
  border: 1px solid var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 8px 10px;
}

.sessions__item:hover:not([disabled]) {
  background: var(--ops-hover-bg);
}

.sessions__item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, var(--ops-accent));
  outline-offset: -1px;
}

.sessions__item--active {
  border-color: var(--vscode-focusBorder, var(--ops-accent));
  cursor: default;
}

.sessions__title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sessions__badge {
  color: var(--ops-accent);
}

.sessions__meta {
  font-size: 11px;
  color: var(--ops-muted);
}
</style>
