<script setup lang="ts">
import { computed } from 'vue';
import { THINKING_FORMATS, THINKING_LEVELS } from '../helpers';
import { t } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

const status = computed(() => store.status.models);
const oauthStatus = computed(() => store.status.oauth);
const oauthNote = computed(() => store.models.oauthNote || t('mOauthNote'));
const keyState = computed(() =>
  store.models.hasKey
    ? `${t('mKeySaved')}${store.models.providerId ? `（${store.models.providerId}）` : ''}`
    : t('mKeyMissing')
);
</script>

<template>
  <section>
    <h2 class="set-title">{{ t('modelsTitle') }}</h2>
    <p class="set-hint">
      {{ t('modelsHint') }}
      <template v-if="store.models.modelsPath"> · {{ store.models.modelsPath }}</template>
    </p>

    <!-- API Key（openai 兼容 provider） -->
    <div class="set-card">
      <h3 class="set-title">{{ t('modelsSectionApi') }}</h3>
      <div class="set-field">
        <label class="set-label" for="m-baseUrl">{{ t('mBaseUrl') }}</label>
        <input
          id="m-baseUrl"
          type="text"
          class="set-input"
          v-model="store.models.baseUrl"
          placeholder="https://llm.example.internal/v1"
          spellcheck="false"
        />
      </div>
      <div class="set-field">
        <label class="set-label" for="m-modelId">{{ t('mModelId') }}</label>
        <input
          id="m-modelId"
          type="text"
          class="set-input"
          v-model="store.models.modelId"
          placeholder="qwen3-max"
          spellcheck="false"
        />
      </div>
      <div class="set-field">
        <label class="set-label" for="m-modelName">{{ t('mModelName') }}</label>
        <input id="m-modelName" type="text" class="set-input" v-model="store.models.modelName" placeholder="Qwen3 Max" />
      </div>
      <div class="set-field">
        <label class="set-check">
          <input type="checkbox" v-model="store.models.thinking" />
          <span class="set-label">{{ t('mThinking') }}</span>
        </label>
      </div>
      <div class="set-field">
        <label class="set-label" for="m-thinkingLevel">{{ t('mThinkingLevel') }}</label>
        <select id="m-thinkingLevel" class="set-select" v-model="store.models.thinkingLevel">
          <option v-for="level in THINKING_LEVELS" :key="level" :value="level">{{ level }}</option>
        </select>
      </div>
      <div class="set-field">
        <label class="set-label" for="m-apiKey">{{ t('mApiKey') }}</label>
        <!-- password 永不回显：state 到达时该输入框总是被清空 -->
        <input
          id="m-apiKey"
          type="password"
          class="set-input"
          v-model="store.models.apiKey"
          autocomplete="off"
          :placeholder="t('mApiKeyPlaceholder')"
        />
        <span class="set-desc">{{ keyState }}</span>
      </div>
    </div>

    <!-- Compat -->
    <div class="set-card">
      <h3 class="set-title">{{ t('modelsSectionCompat') }}</h3>
      <div class="set-field">
        <label class="set-label" for="m-thinkingFormat">{{ t('mThinkingFormat') }}</label>
        <select id="m-thinkingFormat" class="set-select" v-model="store.models.thinkingFormat">
          <option v-for="format in THINKING_FORMATS" :key="format" :value="format">
            {{ format === 'default' ? t('mThinkingFormatDefault') : format }}
          </option>
        </select>
      </div>
      <div class="set-field">
        <label class="set-check">
          <input type="checkbox" v-model="store.models.supportsDeveloperRole" />
          <span class="set-label">{{ t('mSupportsDeveloperRole') }}</span>
        </label>
      </div>
      <span class="set-desc">{{ t('mCompatHint') }}</span>
    </div>

    <!-- OAuth -->
    <div class="set-card">
      <h3 class="set-title">{{ t('modelsSectionOauth') }}</h3>
      <div class="set-field">
        <label class="set-label" for="m-oauthProvider">{{ t('mOauthProvider') }}</label>
        <input
          id="m-oauthProvider"
          type="text"
          class="set-input"
          v-model="store.models.oauthProvider"
          placeholder="anthropic"
          spellcheck="false"
        />
      </div>
      <div class="set-actions">
        <button
          type="button"
          class="ops-btn"
          :disabled="store.oauthBusy || store.models.oauthProvider.trim().length === 0"
          @click="store.oauthLogin()"
        >
          {{ t('mOauthLogin') }}
        </button>
        <button type="button" class="ops-btn ops-btn--secondary" @click="store.openAuthJson()">
          {{ t('mOpenAuth') }}
        </button>
      </div>
      <p class="set-note">
        {{ oauthNote }}
        <template v-if="store.models.authPath">{{ t('mAuthPathLabel') }}{{ store.models.authPath }}</template>
      </p>
      <div
        v-if="oauthStatus"
        class="set-status"
        :class="oauthStatus.ok ? 'set-status--ok' : 'set-status--err'"
        role="status"
      >
        {{ oauthStatus.text }}
      </div>
    </div>

    <div class="set-actions">
      <button type="button" class="ops-btn" @click="store.saveModels()">{{ t('save') }}</button>
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.openModelsJson()">
        {{ t('mOpenModels') }}
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
