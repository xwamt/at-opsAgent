<script setup lang="ts">
import { t } from '../i18n';
import { useSettingsStore } from '../store';
import type { ProviderRow, ProviderToolRisk, ProviderToolRow } from '../helpers';

const store = useSettingsStore();

function riskClass(risk: ProviderToolRisk): string {
  if (risk === 'read') return 'ops-risk-read';
  if (risk === 'write') return 'ops-risk-write';
  return 'ops-risk-exec';
}

function providerTools(provider: ProviderRow): ProviderToolRow[] {
  if (provider.tools && provider.tools.length > 0) return provider.tools;
  return (provider.toolNames ?? []).map((name) => ({ name }));
}
</script>

<template>
  <section>
    <h2 class="set-page-title">{{ t('capTitle') }}</h2>
    <p class="set-hint">{{ t('capHint') }}</p>

    <div class="set-actions cap-actions">
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.refreshCapabilities()">
        {{ t('capRefresh') }}
      </button>
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.diagnose()">
        {{ t('capDiagnose') }}
      </button>
    </div>

    <div v-if="store.providers.length === 0" class="set-empty">
      <p>{{ t('capEmpty') }}</p>
      <p class="cap-empty-install">{{ t('capEmptyInstall') }}</p>
    </div>

    <div v-for="provider in store.providers" :key="provider.pluginId" class="set-card cap-card">
      <div class="cap-card__head">
        <span class="cap-card__name">{{ provider.displayName }}</span>
        <span class="cap-card__head-actions">
          <!-- 健康态：颜色 + 文字双通道 -->
          <span
            class="ops-badge"
            :class="provider.healthy ? 'ops-risk-read' : 'ops-risk-exec'"
          >
            {{ provider.healthy ? t('capHealthy') : t('capUnhealthy') }}
          </span>
          <button
            v-if="!provider.healthy"
            type="button"
            class="ops-btn ops-btn--secondary cap-card__diagnose"
            @click="store.diagnose()"
          >
            {{ t('capDiagnoseRun') }}
          </button>
        </span>
      </div>
      <div class="cap-card__meta ops-mono">{{ provider.pluginId }}</div>
      <div class="cap-card__meta">
        <template v-if="provider.liveToolCount !== undefined">
          {{ provider.liveToolCount }} {{ t('capLive') }} ·
        </template>
        {{ provider.toolCount }} {{ t('capTools') }} · {{ provider.bridgeCount }}
        {{ t('capBridges') }}
        <template v-if="provider.connectedTargets !== undefined">
          · {{ provider.connectedTargets }} {{ t('capConnected') }}
        </template>
      </div>
      <details v-if="providerTools(provider).length > 0" class="cap-tools">
        <summary>{{ t('capToolList') }}</summary>
        <ul class="cap-tools__list">
          <li v-for="tool in providerTools(provider)" :key="tool.name" class="cap-tools__item">
            <span class="ops-mono">{{ tool.name }}</span>
            <span
              v-if="tool.risk"
              class="ops-badge"
              :class="riskClass(tool.risk)"
            >
              {{ tool.risk }}
            </span>
          </li>
        </ul>
      </details>
    </div>
  </section>
</template>

<style scoped>
.cap-actions {
  margin: 0 0 12px;
}

.cap-empty-install {
  margin: 6px 0 0;
}

.cap-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cap-card__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.cap-card__name {
  font-weight: 600;
}

.cap-card__meta {
  font-size: 12px;
  color: var(--ops-muted);
  margin-top: 4px;
}

.cap-card__diagnose {
  font-size: 11px;
  padding: 2px 8px;
}

.cap-tools {
  margin-top: 8px;
}

.cap-tools summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--ops-muted);
}

.cap-tools__list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

.cap-tools__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
</style>
