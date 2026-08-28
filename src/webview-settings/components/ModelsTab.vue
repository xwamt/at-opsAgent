<script setup lang="ts">
import { computed } from 'vue';
import {
  CUSTOM_PROVIDER_ID,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PRESETS,
  ROLE_MODEL_ROLES,
  THINKING_FORMATS,
  THINKING_LEVELS,
  modelsKeyMissing,
  presetIdForProvider,
  providerPresetById,
  resolveOauthProvider,
  type RoleModelRole
} from '../helpers';
import { t, type SettingsMessageKey } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

const status = computed(() => store.status.models);
const oauthStatus = computed(() => store.status.oauth);
const oauthNote = computed(() => store.models.oauthNote || t('mOauthNote'));

/** 首跑向导态：还没有任何已存 key（ux.md §5 的 2 分钟向导文案）。 */
const firstRun = computed(() => !store.models.hasKey);

/** provider 下拉的双向绑定：未知 providerId 归到「自定义」。 */
const presetModel = computed({
  get: () => presetIdForProvider(store.models.providerId),
  set: (value: string) => store.selectProviderPreset(value)
});
const isCustom = computed(() => presetModel.value === CUSTOM_PROVIDER_ID);

/** 首跑绝不显示「留空 = 保持现有 key」（此时没有可保持的 key）。 */
const apiKeyPlaceholder = computed(() =>
  store.models.hasKey ? t('mApiKeyPlaceholder') : t('mApiKeyPlaceholderFirstRun')
);

const keyState = computed(() =>
  store.models.hasKey
    ? `${t('mKeySaved')}${store.models.providerId ? `（${store.models.providerId}）` : ''}`
    : t('mKeyMissing')
);

/** 保存前的内联黄字预警：既无已存 key 又没填（OAuth 预设豁免）。 */
const keyWarn = computed(() => modelsKeyMissing(store.models));

/** 模型 id 建议：models/fetch 拉回的真实目录优先，预设常见值补底。 */
const modelSuggestions = computed(() => {
  const preset = providerPresetById(store.models.providerId);
  const merged = [...store.modelSuggestions];
  for (const id of preset?.models ?? []) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
});

const ROLE_LABEL_KEYS: Record<RoleModelRole, SettingsMessageKey> = {
  investigator: 'roleInvestigator',
  executor: 'roleExecutor',
  writer: 'roleWriter',
  verifier: 'roleVerifier'
};

const oauthProviderResolved = computed(() => resolveOauthProvider(store.models));
</script>

<template>
  <section>
    <h2 class="set-page-title">{{ t('modelsTitle') }}</h2>
    <p class="set-hint">
      {{ t('modelsHint') }}
      <template v-if="store.models.modelsPath"> · {{ store.models.modelsPath }}</template>
    </p>

    <!-- 连接与 API Key（P0-B 向导：预设 → key → 保存并测试） -->
    <div class="set-card">
      <h3 class="set-title">{{ t('modelsSectionApi') }}</h3>

      <p v-if="firstRun" class="set-step">{{ t('mWizardStep1') }}</p>
      <div class="set-field">
        <label class="set-label" for="m-provider">{{ t('mProvider') }}</label>
        <select id="m-provider" class="set-select" v-model="presetModel">
          <option v-for="preset in PROVIDER_PRESETS" :key="preset.id" :value="preset.id">
            {{ t(preset.labelKey) }}
          </option>
        </select>
        <span v-if="firstRun" class="set-desc">{{ t('mWizardStep1Hint') }}</span>
      </div>

      <div v-if="isCustom" class="set-field">
        <label class="set-label" for="m-providerId">{{ t('mProviderId') }}</label>
        <input
          id="m-providerId"
          type="text"
          class="set-input"
          v-model="store.models.providerId"
          :placeholder="CUSTOM_PROVIDER_ID"
          spellcheck="false"
        />
      </div>

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
        <span class="set-desc">{{ t('mApiStyle') }}: {{ store.models.api }}</span>
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
          list="m-model-suggestions"
        />
        <datalist id="m-model-suggestions">
          <option v-for="id in modelSuggestions" :key="id" :value="id"></option>
        </datalist>
        <span class="set-desc">{{ t('mModelIdHint') }}</span>
      </div>
      <div class="set-field">
        <label class="set-label" for="m-modelName">{{ t('mModelName') }}</label>
        <input id="m-modelName" type="text" class="set-input" v-model="store.models.modelName" placeholder="Qwen3 Max" />
      </div>
      <div class="set-field">
        <label class="set-check">
          <input type="checkbox" v-model="store.models.reasoning" />
          <span class="set-label">{{ t('mReasoning') }}</span>
        </label>
      </div>
      <div class="set-field">
        <label class="set-label" for="m-thinkingLevel">{{ t('mThinkingLevel') }}</label>
        <select id="m-thinkingLevel" class="set-select" v-model="store.models.thinkingLevel">
          <option v-for="level in THINKING_LEVELS" :key="level" :value="level">{{ level }}</option>
        </select>
      </div>

      <p v-if="firstRun" class="set-step">{{ t('mWizardStep2') }}</p>
      <div class="set-field">
        <label class="set-label" for="m-apiKey">{{ t('mApiKey') }}</label>
        <!-- password 永不回显：state 到达时该输入框总是被清空 -->
        <input
          id="m-apiKey"
          type="password"
          class="set-input"
          v-model="store.models.apiKey"
          autocomplete="off"
          :placeholder="apiKeyPlaceholder"
        />
        <span class="set-desc">{{ t('mKeySecretNote') }}</span>
        <span class="set-desc">{{ keyState }}</span>
        <span v-if="keyWarn" class="set-desc set-status--warn">{{ t('mKeyMissingWarn') }}</span>
      </div>

      <div class="set-actions">
        <button
          type="button"
          class="ops-btn"
          :disabled="store.testingModel"
          @click="store.saveAndTestModels()"
        >
          {{ t('mSaveTest') }}
        </button>
        <button
          type="button"
          class="ops-btn ops-btn--secondary"
          :disabled="store.fetchingModels || store.models.baseUrl.trim().length === 0"
          @click="store.fetchModels()"
        >
          {{ t('mFetchModels') }}
        </button>
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
      <p v-if="firstRun" class="set-step set-step--muted">{{ t('mWizardStep3') }}</p>
    </div>

    <!-- 按角色指定模型（P2：Investigator 便宜模型 / Writer、Verifier 强模型） -->
    <div class="set-card">
      <h3 class="set-title">{{ t('mRolesTitle') }}</h3>
      <p class="set-hint">{{ t('mRolesHint') }}</p>
      <div v-for="role in ROLE_MODEL_ROLES" :key="role" class="set-field role-row">
        <span class="set-label role-row__label">{{ t(ROLE_LABEL_KEYS[role]) }}</span>
        <div class="role-row__inputs">
          <input
            type="text"
            class="set-input"
            v-model="store.models.roleModels[role].provider"
            :placeholder="t('mRoleProviderPh')"
            :aria-label="`${t(ROLE_LABEL_KEYS[role])} provider`"
            spellcheck="false"
          />
          <input
            type="text"
            class="set-input"
            v-model="store.models.roleModels[role].model"
            :placeholder="t('mRoleModelPh')"
            :aria-label="`${t(ROLE_LABEL_KEYS[role])} model`"
            spellcheck="false"
            list="m-model-suggestions"
          />
        </div>
      </div>
    </div>

    <!-- 兼容性 -->
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

    <!-- OAuth（P2-5：常见 provider 下拉 + 自定义，不再默认 internal-gateway） -->
    <div class="set-card">
      <h3 class="set-title">{{ t('modelsSectionOauth') }}</h3>
      <div class="set-field">
        <label class="set-label" for="m-oauthProvider">{{ t('mOauthProvider') }}</label>
        <select id="m-oauthProvider" class="set-select" v-model="store.models.oauthProvider">
          <option v-for="id in OAUTH_PROVIDER_IDS" :key="id" :value="id">{{ id }}</option>
          <option value="custom">{{ t('mOauthCustom') }}</option>
        </select>
      </div>
      <div v-if="store.models.oauthProvider === 'custom'" class="set-field">
        <input
          type="text"
          class="set-input"
          v-model="store.models.oauthProviderCustom"
          :placeholder="t('mOauthCustomPh')"
          :aria-label="t('mOauthProvider')"
          spellcheck="false"
        />
      </div>
      <div class="set-actions">
        <button
          type="button"
          class="ops-btn"
          :disabled="store.oauthBusy || oauthProviderResolved.length === 0"
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
  </section>
</template>

<style scoped>
.role-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.role-row__label {
  margin: 0;
}

.role-row__inputs {
  display: flex;
  gap: 8px;
}

.role-row__inputs .set-input:first-child {
  flex: 0 0 38%;
}
</style>
