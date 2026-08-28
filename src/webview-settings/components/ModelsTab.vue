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

/** 首跑态：还没有任何已存 key（docs/12 §5：一条 muted 提示，不再是三大段）。 */
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

    <!-- 主路径一屏（docs/12 §5，对标 Cline 设置）：provider → URL/模型 → key → 保存并测试 -->
    <div class="set-card">
      <h3 class="set-title">{{ t('modelsSectionConnect') }}</h3>
      <p v-if="firstRun" class="set-hint">{{ t('mFirstRunHint') }}</p>

      <div class="set-field">
        <label class="set-label" for="m-provider">{{ t('mProvider') }}</label>
        <select id="m-provider" class="set-select" v-model="presetModel">
          <option v-for="preset in PROVIDER_PRESETS" :key="preset.id" :value="preset.id">
            {{ t(preset.labelKey) }}
          </option>
        </select>
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

      <!-- 宽编辑器两列：Base URL | 模型 ID（窄视图自动落回单列） -->
      <div class="models-row">
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
      </div>

      <div class="set-field">
        <label class="set-label" for="m-modelName">{{ t('mModelName') }}</label>
        <input id="m-modelName" type="text" class="set-input" v-model="store.models.modelName" placeholder="Qwen3 Max" />
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
    </div>

    <!-- 高级折叠：思考 / 兼容 / OAuth / 角色模型（主路径不需要时不占屏） -->
    <details class="set-card models-advanced">
      <summary class="models-advanced__summary">
        <span class="set-title models-advanced__title">{{ t('mAdvanced') }}</span>
        <span class="set-desc models-advanced__hint">{{ t('mAdvancedHint') }}</span>
      </summary>

      <div class="models-advanced__group">
        <h4 class="set-title">{{ t('modelsSectionReasoning') }}</h4>
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
      </div>

      <div class="models-advanced__group">
        <h4 class="set-title">{{ t('modelsSectionCompat') }}</h4>
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

      <div class="models-advanced__group">
        <h4 class="set-title">{{ t('modelsSectionOauth') }}</h4>
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

      <div class="models-advanced__group">
        <h4 class="set-title">{{ t('mRolesTitle') }}</h4>
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
    </details>
  </section>
</template>

<style scoped>
/* 宽编辑器两列（Cline 式紧凑表单）：列宽不足 240px 时自动落回单列 */
.models-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  column-gap: 12px;
}

.models-row .set-field {
  min-width: 0;
}

/* 高级折叠：复用 set-card 边框，summary 做成卡片头（自绘 chevron，隐藏原生 marker）。
   卡片自身去 padding，由 summary / 分组各自持有，保证展开态内边距一致。 */
.models-advanced {
  padding: 0;
}

.models-advanced__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  list-style: none; /* 隐藏原生 disclosure 三角（含 Firefox ::marker） */
}

.models-advanced__summary::-webkit-details-marker {
  display: none;
}

/* 自绘 chevron：右指 → 展开后下指，跟随 muted 色 */
.models-advanced__summary::before {
  content: '';
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-right: 1.5px solid var(--ops-muted);
  border-bottom: 1.5px solid var(--ops-muted);
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

details[open] > .models-advanced__summary::before {
  transform: rotate(45deg);
}

.models-advanced__summary:hover {
  background: var(--ops-hover-bg);
}

.models-advanced__summary:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, var(--ops-accent));
  outline-offset: -1px;
}

/* 展开态：头部只圆上角，与内容之间画分隔线 */
details[open] > .models-advanced__summary {
  border-radius: 6px 6px 0 0;
  border-bottom: 1px solid var(--vscode-widget-border, var(--ops-border));
}

.models-advanced__title {
  flex: 0 0 auto;
  margin: 0;
}

.models-advanced__hint {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.models-advanced__group {
  padding: 12px 14px;
}

.models-advanced__group + .models-advanced__group {
  border-top: 1px solid var(--vscode-widget-border, var(--ops-border));
}

/* 组内末元素不再叠加自身下边距，分组上下留白一致 */
.models-advanced__group > :last-child {
  margin-bottom: 0;
}

.role-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.role-row__label {
  margin: 0;
}

/* provider + 模型 同行；容器不够宽时 flex-wrap 换行（各占整行） */
.role-row__inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.role-row__inputs .set-input {
  min-width: 0;
}

.role-row__inputs .set-input:first-child {
  flex: 1 1 150px;
}

.role-row__inputs .set-input:last-child {
  flex: 2 1 220px;
}
</style>
