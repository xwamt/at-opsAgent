<script setup lang="ts">
import { computed } from 'vue';
import { CONFIG_FIELDS } from '../helpers';
import { t, type SettingsMessageKey } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

const status = computed(() => store.status.general);

// CONFIG_FIELDS 的 labelKey/descKey 均在 settings i18n 中登记（helpers 不依赖 i18n 类型）。
function tk(key: string): string {
  return t(key as SettingsMessageKey);
}
</script>

<template>
  <section>
    <h2 class="set-title">{{ t('generalTitle') }}</h2>
    <p class="set-hint">{{ t('generalHint') }}</p>

    <div class="set-card">
      <div v-for="field in CONFIG_FIELDS" :key="field.key" class="set-field">
        <label v-if="field.kind === 'boolean'" class="set-check">
          <input type="checkbox" v-model="store.draft[field.key]" />
          <span>
            <span class="set-label">{{ tk(field.labelKey) }}</span>
            <span class="set-desc">{{ tk(field.descKey) }}</span>
          </span>
        </label>

        <template v-else-if="field.kind === 'enum'">
          <label class="set-label" :for="`cfg-${field.key}`">{{ tk(field.labelKey) }}</label>
          <select :id="`cfg-${field.key}`" class="set-select" v-model="store.draft[field.key]">
            <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <span class="set-desc">{{ tk(field.descKey) }}</span>
        </template>

        <template v-else>
          <label class="set-label" :for="`cfg-${field.key}`">{{ tk(field.labelKey) }}</label>
          <input
            :id="`cfg-${field.key}`"
            type="number"
            class="set-input"
            v-model.number="store.draft[field.key]"
            :min="field.min"
            :max="field.max"
          />
          <span class="set-desc">{{ tk(field.descKey) }}</span>
        </template>
      </div>
    </div>

    <div class="set-actions">
      <button type="button" class="ops-btn" :disabled="!store.generalDirty" @click="store.saveGeneral()">
        {{ t('save') }}
      </button>
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.openVsCodeSettings()">
        {{ t('openVsCodeSettings') }}
      </button>
    </div>
    <div
      v-if="status"
      class="set-status"
      :class="status.ok ? 'set-status--ok' : 'set-status--err'"
      role="status"
    >
      {{ status.text }}
    </div>
  </section>
</template>
