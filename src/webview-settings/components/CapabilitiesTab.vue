<script setup lang="ts">
import { t } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();
</script>

<template>
  <section>
    <h2 class="set-title">{{ t('capTitle') }}</h2>
    <p class="set-hint">{{ t('capHint') }}</p>

    <div class="set-actions cap-actions">
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.refreshCapabilities()">
        {{ t('capRefresh') }}
      </button>
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.diagnose()">
        {{ t('capDiagnose') }}
      </button>
    </div>

    <div v-if="store.providers.length === 0" class="set-empty">{{ t('capEmpty') }}</div>

    <div v-for="provider in store.providers" :key="provider.pluginId" class="set-card cap-card">
      <div class="cap-card__head">
        <span class="cap-card__name">{{ provider.displayName }}</span>
        <!-- 健康态：颜色 + 文字双通道 -->
        <span
          class="ops-badge"
          :class="provider.healthy ? 'ops-risk-read' : 'ops-risk-exec'"
        >
          {{ provider.healthy ? t('capHealthy') : t('capUnhealthy') }}
        </span>
      </div>
      <div class="cap-card__meta ops-mono">{{ provider.pluginId }}</div>
      <div class="cap-card__meta">
        {{ provider.toolCount }} {{ t('capTools') }} · {{ provider.bridgeCount }} {{ t('capBridges') }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.cap-actions {
  margin: 0 0 12px;
}

.cap-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cap-card__name {
  font-weight: 600;
}

.cap-card__meta {
  font-size: 12px;
  color: var(--ops-muted);
  margin-top: 4px;
}
</style>
