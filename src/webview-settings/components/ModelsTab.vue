<script setup lang="ts">
import { computed, ref } from 'vue';
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
  type ConfiguredModelItem,
  type ConfiguredProviderGroup,
  type RoleModelRole
} from '../helpers';
import { t, tf, type SettingsMessageKey } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

const isEditing = ref(false);
const formCardRef = ref<HTMLElement | null>(null);

// 确认删除状态管理（解决 VS Code Webview 屏蔽 window.confirm 问题）
const deletingKey = ref<string | null>(null);
const deletingProviderId = ref<string | null>(null);

// 快速添加单模型到指定 Provider
const quickAddingProviderId = ref<string | null>(null);
const quickModelId = ref('');
const quickModelName = ref('');
const quickModelReasoning = ref(false);

// 批量拉取导入模态状态
const batchImportProviderId = ref<string | null>(null);
const selectedBatchModels = ref<string[]>([]);

const status = computed(() => store.status.models);
const oauthStatus = computed(() => store.status.oauth);
const oauthNote = computed(() => store.models.oauthNote || t('mOauthNote'));

const presetModel = computed({
  get: () => presetIdForProvider(store.models.providerId),
  set: (value: string) => store.selectProviderPreset(value)
});
const isCustom = computed(() => presetModel.value === CUSTOM_PROVIDER_ID);

const apiKeyPlaceholder = computed(() =>
  store.models.hasKey ? t('mApiKeyPlaceholder') : t('mApiKeyPlaceholderFirstRun')
);

const keyState = computed(() =>
  store.models.hasKey
    ? `${t('mKeySaved')}${store.models.providerId ? `（${store.models.providerId}）` : ''}`
    : t('mKeyMissing')
);

const keyWarn = computed(() => modelsKeyMissing(store.models));

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

// 统一 Provider 分组视图：优先使用 store.providerGroups，若无则从 store.modelList 自动聚合成组
const displayProviderGroups = computed<ConfiguredProviderGroup[]>(() => {
  if (store.providerGroups.length > 0) {
    return store.providerGroups;
  }
  const map = new Map<string, ConfiguredProviderGroup>();
  for (const m of store.modelList) {
    let group = map.get(m.providerId);
    if (!group) {
      group = {
        providerId: m.providerId,
        baseUrl: m.baseUrl,
        api: m.api,
        hasKey: m.hasKey,
        thinkingFormat: m.thinkingFormat,
        supportsDeveloperRole: m.supportsDeveloperRole,
        models: []
      };
      map.set(m.providerId, group);
    }
    group.models.push({
      id: m.modelId,
      name: m.modelName,
      reasoning: m.reasoning,
      isDefault: m.isDefault,
      latencyMs: m.latencyMs,
      testStatus: m.testStatus,
      testError: m.testError
    });
  }
  return Array.from(map.values());
});

function startAddProvider(): void {
  store.selectProviderPreset('openai');
  store.models.modelId = '';
  store.models.modelName = '';
  store.models.apiKey = '';
  isEditing.value = true;
  formCardRef.value?.scrollIntoView({ behavior: 'smooth' });
}

function editProvider(group: ConfiguredProviderGroup): void {
  store.models.providerId = group.providerId;
  store.models.baseUrl = group.baseUrl;
  store.models.api = group.api;
  store.models.hasKey = group.hasKey;
  if (group.models.length > 0) {
    const first = group.models[0];
    store.models.modelId = first.id;
    store.models.modelName = first.name;
    store.models.reasoning = first.reasoning;
  } else {
    store.models.modelId = '';
    store.models.modelName = '';
  }
  store.models.apiKey = '';
  isEditing.value = true;
  formCardRef.value?.scrollIntoView({ behavior: 'smooth' });
}

function editModel(provider: ConfiguredProviderGroup, model: ConfiguredProviderGroup['models'][number]): void {
  store.loadModelIntoForm({
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    api: provider.api,
    hasKey: provider.hasKey,
    thinkingFormat: provider.thinkingFormat,
    supportsDeveloperRole: provider.supportsDeveloperRole,
    modelId: model.id,
    modelName: model.name,
    reasoning: model.reasoning
  });
  isEditing.value = true;
  formCardRef.value?.scrollIntoView({ behavior: 'smooth' });
}

function cancelEdit(): void {
  isEditing.value = false;
  store.editingModelId = '';
}

function promptDeleteModel(providerId: string, modelId: string): void {
  deletingKey.value = `${providerId}::${modelId}`;
}

function executeDeleteModel(providerId: string, modelId: string): void {
  store.deleteModel(providerId, modelId);
  deletingKey.value = null;
}

function promptDeleteProvider(providerId: string): void {
  deletingProviderId.value = providerId;
}

function executeDeleteProvider(providerId: string): void {
  store.deleteProvider(providerId);
  deletingProviderId.value = null;
}

function openQuickAdd(providerId: string): void {
  quickAddingProviderId.value = providerId;
  quickModelId.value = '';
  quickModelName.value = '';
  quickModelReasoning.value = false;
}

function closeQuickAdd(): void {
  quickAddingProviderId.value = null;
}

function submitQuickAdd(provider: ConfiguredProviderGroup): void {
  const mId = quickModelId.value.trim();
  if (!mId) return;
  store.post('models/save', {
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    modelId: mId,
    modelName: quickModelName.value.trim() || mId,
    reasoning: quickModelReasoning.value
  });
  closeQuickAdd();
}

function openBatchImport(provider: ConfiguredProviderGroup): void {
  batchImportProviderId.value = provider.providerId;
  selectedBatchModels.value = [];
  store.models.providerId = provider.providerId;
  store.models.baseUrl = provider.baseUrl;
  store.fetchModelsList();
}

function closeBatchImport(): void {
  batchImportProviderId.value = null;
}

function toggleSelectBatchModel(id: string): void {
  const idx = selectedBatchModels.value.indexOf(id);
  if (idx >= 0) {
    selectedBatchModels.value.splice(idx, 1);
  } else {
    selectedBatchModels.value.push(id);
  }
}

function selectAllBatchModels(): void {
  selectedBatchModels.value = [...store.modelSuggestions];
}

function submitBatchImport(provider: ConfiguredProviderGroup): void {
  if (selectedBatchModels.value.length === 0) return;
  store.batchAddFetchedModels(provider.providerId, provider.baseUrl, selectedBatchModels.value);
  closeBatchImport();
}

function testSingle(provider: ConfiguredProviderGroup, model: ConfiguredProviderGroup['models'][number]): void {
  store.testSingleModel({
    providerId: provider.providerId,
    modelId: model.id,
    baseUrl: provider.baseUrl,
    testStatus: model.testStatus
  });
}

function testAll(): void {
  for (const group of displayProviderGroups.value) {
    for (const model of group.models) {
      testSingle(group, model);
    }
  }
}

async function saveAndFinish(): Promise<void> {
  await store.saveAndTestModels();
}
</script>

<template>
  <section class="models-tab">
    <header class="models-tab__head">
      <div>
        <h2 class="set-page-title">{{ t('modelsTitle') }}</h2>
        <p class="set-hint">{{ t('modelsHint') }}</p>
      </div>
      <div class="models-tab__head-actions">
        <button type="button" class="ops-btn" @click="startAddProvider">
          <span class="codicon codicon-add" aria-hidden="true"></span>
          {{ t('mAddProviderBtn') }}
        </button>
        <button
          v-if="displayProviderGroups.length > 0"
          type="button"
          class="ops-btn ops-btn--secondary"
          @click="testAll"
        >
          <span class="codicon codicon-pulse" aria-hidden="true"></span>
          {{ t('mTestAll') }}
        </button>
        <button
          type="button"
          class="ops-btn ops-btn--ghost ops-btn--sm"
          @click="store.openModelsFile"
        >
          <span class="codicon codicon-json" aria-hidden="true"></span>
          {{ t('mOpenModels') }}
        </button>
      </div>
    </header>

    <!-- 顶栏状态提示 -->
    <div
      v-if="status"
      class="set-status"
      :class="{ 'set-status--ok': status.ok, 'set-status--error': !status.ok }"
      role="status"
    >
      <span
        class="codicon"
        :class="status.ok ? 'codicon-check' : 'codicon-error'"
        aria-hidden="true"
      ></span>
      <span>{{ status.text }}</span>
    </div>

    <!-- 1. 按服务商分组展示的已配置模型列表（对标 Kilo Code / Cline） -->
    <section class="models-catalog-section">
      <div class="models-catalog-section__head">
        <h3 class="set-section-title">{{ t('mModelListTitle') }}</h3>
        <span class="set-hint">{{ t('mModelListHint') }}</span>
      </div>

      <!-- 空状态 -->
      <div v-if="displayProviderGroups.length === 0" class="models-empty-box ops-well">
        <span class="codicon codicon-info" aria-hidden="true"></span>
        <p>{{ t('mNoModelsFound') }}</p>
        <button type="button" class="ops-btn ops-btn--sm" @click="startAddProvider">
          <span class="codicon codicon-add" aria-hidden="true"></span>
          {{ t('mAddProviderBtn') }}
        </button>
      </div>

      <!-- 服务商卡片列表（包含多模型） -->
      <div v-else class="provider-groups-list">
        <article
          v-for="group in displayProviderGroups"
          :key="group.providerId"
          class="provider-card"
        >
          <!-- 服务商头部信息栏 -->
          <header class="provider-card__head">
            <div class="provider-card__meta">
              <div class="provider-card__title-row">
                <span class="codicon codicon-server-process provider-card__icon" aria-hidden="true"></span>
                <strong class="provider-card__name">{{ group.providerId }}</strong>
                <span class="ops-badge ops-badge--secondary ops-mono">{{ group.api }}</span>
                <span
                  class="ops-badge"
                  :class="group.hasKey ? 'ops-badge--success' : 'ops-badge--muted'"
                >
                  {{ group.hasKey ? t('mKeySaved') : t('mKeyMissing') }}
                </span>
              </div>
              <p class="provider-card__url ops-mono">{{ group.baseUrl || '(Base URL 未填写)' }}</p>
            </div>

            <!-- 服务商操作按钮 -->
            <div class="provider-card__actions">
              <!-- 行内删除服务商确认 -->
              <div
                v-if="deletingProviderId === group.providerId"
                class="inline-confirm"
              >
                <span class="inline-confirm__text">{{ t('mDeleteProviderConfirm') }}</span>
                <button
                  type="button"
                  class="ops-btn ops-btn--danger ops-btn--xs"
                  @click="executeDeleteProvider(group.providerId)"
                >
                  {{ t('mConfirmBtn') }}
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  @click="deletingProviderId = null"
                >
                  {{ t('mCancelBtn') }}
                </button>
              </div>
              <template v-else>
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  @click="openQuickAdd(group.providerId)"
                >
                  <span class="codicon codicon-add" aria-hidden="true"></span>
                  {{ t('mQuickAddModel') }}
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  @click="openBatchImport(group)"
                >
                  <span class="codicon codicon-cloud-download" aria-hidden="true"></span>
                  {{ t('mFetchModels') }}
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  @click="editProvider(group)"
                >
                  <span class="codicon codicon-edit" aria-hidden="true"></span>
                  {{ t('mEditProvider') }}
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--ghost ops-btn--xs"
                  @click="promptDeleteProvider(group.providerId)"
                >
                  <span class="codicon codicon-trash" aria-hidden="true"></span>
                  {{ t('mDeleteProvider') }}
                </button>
              </template>
            </div>
          </header>

          <!-- 快速添加模型抽屉 -->
          <div v-if="quickAddingProviderId === group.providerId" class="quick-add-drawer">
            <div class="quick-add-drawer__title">
              <span class="codicon codicon-add" aria-hidden="true"></span>
              <strong>{{ t('mQuickAddModel') }} ({{ group.providerId }})</strong>
            </div>
            <div class="quick-add-drawer__fields">
              <input
                v-model="quickModelId"
                type="text"
                class="ops-input ops-input--sm ops-mono"
                placeholder="模型 ID (如 deepseek-chat, gpt-4o)"
                @keydown.enter.prevent="submitQuickAdd(group)"
              />
              <input
                v-model="quickModelName"
                type="text"
                class="ops-input ops-input--sm"
                placeholder="显示名 (可选)"
                @keydown.enter.prevent="submitQuickAdd(group)"
              />
              <label class="ops-checkbox-label">
                <input v-model="quickModelReasoning" type="checkbox" />
                <span>{{ t('mReasoning') }}</span>
              </label>
              <button
                type="button"
                class="ops-btn ops-btn--primary ops-btn--xs"
                :disabled="!quickModelId.trim()"
                @click="submitQuickAdd(group)"
              >
                {{ t('mConfirmBtn') }}
              </button>
              <button
                type="button"
                class="ops-btn ops-btn--secondary ops-btn--xs"
                @click="closeQuickAdd"
              >
                {{ t('mCancelBtn') }}
              </button>
            </div>
          </div>

          <!-- 批量拉取模型抽屉 -->
          <div v-if="batchImportProviderId === group.providerId" class="batch-import-drawer">
            <div class="batch-import-drawer__head">
              <strong>
                <span class="codicon codicon-cloud-download" aria-hidden="true"></span>
                {{ t('mFetchModels') }} ({{ group.providerId }})
              </strong>
              <div class="batch-import-drawer__actions">
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  @click="selectAllBatchModels"
                >
                  全选 ({{ store.modelSuggestions.length }})
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--primary ops-btn--xs"
                  :disabled="selectedBatchModels.length === 0"
                  @click="submitBatchImport(group)"
                >
                  {{ t('mAddSelectedFetched') }} ({{ selectedBatchModels.length }})
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--ghost ops-btn--xs"
                  @click="closeBatchImport"
                >
                  {{ t('mCancelBtn') }}
                </button>
              </div>
            </div>
            <div v-if="store.fetchingModels" class="batch-import-drawer__loading ops-muted">
              <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
              {{ t('mFetching') }}
            </div>
            <div v-else-if="store.modelSuggestions.length === 0" class="batch-import-drawer__empty ops-muted">
              未拉取到模型列表，请确认 Base URL 与 API Key 是否正确。
            </div>
            <div v-else class="batch-import-drawer__list">
              <label
                v-for="suggested in store.modelSuggestions"
                :key="suggested"
                class="batch-import-drawer__item"
              >
                <input
                  type="checkbox"
                  :checked="selectedBatchModels.includes(suggested)"
                  @change="toggleSelectBatchModel(suggested)"
                />
                <span class="ops-mono">{{ suggested }}</span>
              </label>
            </div>
          </div>

          <!-- 服务商下的模型列表 -->
          <div class="provider-models-table">
            <div
              v-for="model in group.models"
              :key="model.id"
              class="model-row"
              :class="{ 'model-row--default': model.isDefault }"
            >
              <div class="model-row__main">
                <div class="model-row__id-row">
                  <span class="model-row__id ops-mono">{{ model.id }}</span>
                  <span v-if="model.name && model.name !== model.id" class="model-row__name ops-muted">
                    ({{ model.name }})
                  </span>
                  <span v-if="model.isDefault" class="ops-badge ops-badge--success">
                    <span class="codicon codicon-check" aria-hidden="true"></span>
                    {{ t('mDefaultBadge') }}
                  </span>
                  <span v-if="model.reasoning" class="ops-badge ops-badge--info">
                    <span class="codicon codicon-sparkle" aria-hidden="true"></span>
                    {{ t('mReasoning') }}
                  </span>
                </div>

                <!-- 连通性测试结果徽标 -->
                <div v-if="model.testStatus && model.testStatus !== 'idle'" class="model-row__test-status">
                  <span v-if="model.testStatus === 'testing'" class="ops-badge ops-badge--secondary ops-mono">
                    <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
                    {{ t('mTestingSingle') }}
                  </span>
                  <span v-else-if="model.testStatus === 'ok'" class="ops-badge ops-badge--success ops-mono">
                    <span class="codicon codicon-pass" aria-hidden="true"></span>
                    {{ t('mTestOk') }} {{ model.latencyMs != null ? `(${Math.round(model.latencyMs)}ms)` : '' }}
                  </span>
                  <span v-else-if="model.testStatus === 'error'" class="ops-badge ops-badge--danger ops-mono" :title="model.testError">
                    <span class="codicon codicon-error" aria-hidden="true"></span>
                    {{ t('mTestFail') }}{{ model.testError || '' }}
                  </span>
                </div>
              </div>

              <!-- 模型单行操作 -->
              <div class="model-row__actions">
                <!-- 行内删除模型确认 -->
                <div
                  v-if="deletingKey === `${group.providerId}::${model.id}`"
                  class="inline-confirm"
                >
                  <span class="inline-confirm__text">{{ tf('mDeleteConfirmPrompt', { model: model.id }) }}?</span>
                  <button
                    type="button"
                    class="ops-btn ops-btn--danger ops-btn--xs"
                    @click="executeDeleteModel(group.providerId, model.id)"
                  >
                    {{ t('mConfirmBtn') }}
                  </button>
                  <button
                    type="button"
                    class="ops-btn ops-btn--secondary ops-btn--xs"
                    @click="deletingKey = null"
                  >
                    {{ t('mCancelBtn') }}
                  </button>
                </div>
                <template v-else>
                  <button
                    type="button"
                    class="ops-btn ops-btn--secondary ops-btn--xs"
                    :disabled="model.testStatus === 'testing'"
                    @click="testSingle(group, model)"
                  >
                    <span class="codicon codicon-pulse" aria-hidden="true"></span>
                    {{ t('mTestSingle') }}
                  </button>
                  <button
                    v-if="!model.isDefault"
                    type="button"
                    class="ops-btn ops-btn--secondary ops-btn--xs"
                    @click="store.setDefaultModel(group.providerId, model.id)"
                  >
                    {{ t('mSetDefault') }}
                  </button>
                  <button
                    type="button"
                    class="ops-btn ops-btn--ghost ops-btn--xs"
                    @click="editModel(group, model)"
                  >
                    <span class="codicon codicon-edit" aria-hidden="true"></span>
                    {{ t('mEditModel') }}
                  </button>
                  <button
                    type="button"
                    class="ops-btn ops-btn--ghost ops-btn--xs"
                    @click="promptDeleteModel(group.providerId, model.id)"
                  >
                    <span class="codicon codicon-trash" aria-hidden="true"></span>
                    {{ t('mDeleteModel') }}
                  </button>
                </template>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- 2. 编辑 / 添加服务商与模型表单（折叠/卡片） -->
    <section ref="formCardRef" class="set-card model-form-card" :class="{ 'model-form-card--open': isEditing }">
      <header class="model-form-card__head" @click="isEditing = !isEditing">
        <div class="model-form-card__title">
          <span class="codicon" :class="isEditing ? 'codicon-chevron-down' : 'codicon-chevron-right'" aria-hidden="true"></span>
          <span class="codicon codicon-tools" aria-hidden="true"></span>
          <strong>{{ store.editingModelId ? t('mEditModel') : t('mAddProviderBtn') }}</strong>
        </div>
        <button v-if="isEditing" type="button" class="ops-btn ops-btn--ghost ops-btn--xs" @click.stop="cancelEdit">
          {{ t('mCancelEdit') }}
        </button>
      </header>

      <div v-if="isEditing" class="model-form-card__body">
        <!-- 预设选择器 -->
        <div class="set-row">
          <label class="set-label" for="models-preset">{{ t('mProvider') }}</label>
          <div class="set-ctrl">
            <select id="models-preset" v-model="presetModel" class="ops-select">
              <option
                v-for="preset in PROVIDER_PRESETS"
                :key="preset.id"
                :value="preset.id"
              >
                {{ t(preset.labelKey) }}
              </option>
            </select>
          </div>
        </div>

        <div v-if="isCustom" class="set-row">
          <label class="set-label" for="models-provider-id">{{ t('mProviderId') }}</label>
          <div class="set-ctrl">
            <input
              id="models-provider-id"
              v-model="store.models.providerId"
              type="text"
              class="ops-input ops-mono"
              placeholder="openai-compatible"
            />
          </div>
        </div>

        <div class="set-row">
          <label class="set-label" for="models-base-url">{{ t('mBaseUrl') }}</label>
          <div class="set-ctrl">
            <input
              id="models-base-url"
              v-model="store.models.baseUrl"
              type="text"
              class="ops-input ops-mono"
              placeholder="https://..."
            />
          </div>
        </div>

        <div class="set-row">
          <label class="set-label" for="models-api-key">{{ t('mApiKey') }}</label>
          <div class="set-ctrl">
            <input
              id="models-api-key"
              v-model="store.models.apiKey"
              type="password"
              class="ops-input ops-mono"
              autocomplete="off"
              :placeholder="apiKeyPlaceholder"
            />
            <span class="set-ctrl__hint">{{ keyState }}</span>
            <span class="set-ctrl__hint ops-muted">{{ t('mKeySecretNote') }}</span>
          </div>
        </div>

        <div class="set-row">
          <label class="set-label" for="models-model-id">{{ t('mModelId') }}</label>
          <div class="set-ctrl">
            <div class="models-input-row">
              <input
                id="models-model-id"
                v-model="store.models.modelId"
                type="text"
                list="models-suggestions"
                class="ops-input ops-mono"
                placeholder="例如 deepseek-chat, qwen-plus"
              />
              <datalist id="models-suggestions">
                <option v-for="id in modelSuggestions" :key="id" :value="id" />
              </datalist>
              <button
                type="button"
                class="ops-btn ops-btn--secondary"
                :disabled="store.fetchingModels || !store.models.baseUrl"
                @click="store.fetchModelsList"
              >
                <span
                  class="codicon"
                  :class="store.fetchingModels ? 'codicon-loading codicon-modifier-spin' : 'codicon-cloud-download'"
                  aria-hidden="true"
                ></span>
                {{ store.fetchingModels ? t('mFetching') : t('mFetchModels') }}
              </button>
            </div>
            <span class="set-ctrl__hint ops-muted">{{ t('mModelIdHint') }}</span>
          </div>
        </div>

        <div class="set-row">
          <label class="set-label" for="models-model-name">{{ t('mModelName') }}</label>
          <div class="set-ctrl">
            <input
              id="models-model-name"
              v-model="store.models.modelName"
              type="text"
              class="ops-input"
              placeholder="显示名称 (可选)"
            />
          </div>
        </div>

        <div class="set-row">
          <span class="set-label">{{ t('modelsSectionReasoning') }}</span>
          <div class="set-ctrl">
            <label class="ops-checkbox-label">
              <input v-model="store.models.reasoning" type="checkbox" />
              <span>{{ t('mReasoning') }}</span>
            </label>
          </div>
        </div>

        <!-- 缺 key 警告提示 -->
        <div v-if="keyWarn" class="set-alert set-alert--warn" role="alert">
          <span class="codicon codicon-warning" aria-hidden="true"></span>
          <span>{{ t('mKeyMissingWarn') }}</span>
        </div>

        <div class="model-form-card__foot">
          <button
            type="button"
            class="ops-btn ops-btn--primary"
            :disabled="store.testingModel || !store.models.baseUrl"
            @click="saveAndFinish"
          >
            <span
              class="codicon"
              :class="store.testingModel ? 'codicon-loading codicon-modifier-spin' : 'codicon-save'"
              aria-hidden="true"
            ></span>
            {{ store.testingModel ? t('mTesting') : t('mSaveTest') }}
          </button>
          <button type="button" class="ops-btn ops-btn--secondary" @click="cancelEdit">
            {{ t('mCancelEdit') }}
          </button>
        </div>
      </div>
    </section>

    <!-- 3. 按角色分配模型矩阵 -->
    <section class="set-card">
      <header class="set-card__head">
        <h3 class="set-section-title">{{ t('mRolesTitle') }}</h3>
        <p class="set-hint">{{ t('mRolesHint') }}</p>
      </header>
      <div class="set-card__body">
        <div v-for="role in ROLE_MODEL_ROLES" :key="role" class="set-row">
          <label class="set-label" :for="`role-${role}-model`">{{ t(ROLE_LABEL_KEYS[role]) }}</label>
          <div class="set-ctrl set-ctrl--row">
            <input
              :id="`role-${role}-provider`"
              v-model="store.models.roleModels[role].provider"
              type="text"
              class="ops-input ops-mono"
              :placeholder="t('mRoleProviderPh')"
            />
            <input
              :id="`role-${role}-model`"
              v-model="store.models.roleModels[role].model"
              type="text"
              class="ops-input ops-mono"
              :placeholder="t('mRoleModelPh')"
            />
          </div>
        </div>
      </div>
    </section>

    <!-- 4. OAuth 登录支持 -->
    <section class="set-card">
      <header class="set-card__head">
        <h3 class="set-section-title">{{ t('modelsSectionOauth') }}</h3>
        <p class="set-hint">{{ oauthNote }}</p>
      </header>
      <div class="set-card__body">
        <div class="set-row">
          <label class="set-label" for="oauth-provider-select">{{ t('mOauthProvider') }}</label>
          <div class="set-ctrl set-ctrl--row">
            <select id="oauth-provider-select" v-model="store.models.oauthProvider" class="ops-select">
              <option v-for="id in OAUTH_PROVIDER_IDS" :key="id" :value="id">
                {{ id }}
              </option>
              <option value="custom">{{ t('mOauthCustom') }}</option>
            </select>
            <input
              v-if="store.models.oauthProvider === 'custom'"
              v-model="store.models.oauthProviderCustom"
              type="text"
              class="ops-input ops-mono"
              :placeholder="t('mOauthCustomPh')"
            />
            <button
              type="button"
              class="ops-btn ops-btn--secondary"
              :disabled="store.oauthBusy || !oauthProviderResolved"
              @click="store.loginOauth"
            >
              <span
                class="codicon"
                :class="store.oauthBusy ? 'codicon-loading codicon-modifier-spin' : 'codicon-sign-in'"
                aria-hidden="true"
              ></span>
              {{ store.oauthBusy ? t('mOauthPending') : t('mOauthLogin') }}
            </button>
          </div>
        </div>
        <div
          v-if="oauthStatus"
          class="set-status"
          :class="{ 'set-status--ok': oauthStatus.ok, 'set-status--error': !oauthStatus.ok }"
          role="status"
        >
          <span>{{ oauthStatus.text }}</span>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.models-tab {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-4);
}

.models-tab__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--ops-space-3);
  flex-wrap: wrap;
}

.models-tab__head-actions {
  display: flex;
  gap: var(--ops-space-2);
  align-items: center;
}

.models-catalog-section {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-3);
}

.models-catalog-section__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.models-empty-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--ops-space-6);
  gap: var(--ops-space-3);
  text-align: center;
  border-radius: var(--ops-radius);
  border: 1px dashed var(--ops-border);
}

.provider-groups-list {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-3);
}

.provider-card {
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  background: var(--ops-bg-card, var(--ops-bg));
  overflow: hidden;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

.provider-card__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--ops-space-3) var(--ops-space-4);
  background: color-mix(in srgb, var(--ops-bg) 92%, var(--ops-fg) 8%);
  border-bottom: 1px solid var(--ops-border);
  gap: var(--ops-space-3);
  flex-wrap: wrap;
}

.provider-card__meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.provider-card__title-row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.provider-card__icon {
  color: var(--ops-primary, #388bfd);
}

.provider-card__name {
  font-size: 14px;
}

.provider-card__url {
  font-size: 11px;
  color: var(--ops-muted);
}

.provider-card__actions {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  flex-wrap: wrap;
}

.provider-models-table {
  display: flex;
  flex-direction: column;
}

.model-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--ops-space-2) var(--ops-space-4);
  border-bottom: 1px solid color-mix(in srgb, var(--ops-border) 60%, transparent 40%);
  gap: var(--ops-space-3);
}

.model-row:last-child {
  border-bottom: none;
}

.model-row--default {
  background: color-mix(in srgb, var(--ops-success, #2ea043) 6%, transparent 94%);
}

.model-row__main {
  display: flex;
  align-items: center;
  gap: var(--ops-space-3);
  flex-wrap: wrap;
}

.model-row__id-row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.model-row__id {
  font-weight: 600;
  font-size: 13px;
}

.model-row__name {
  font-size: 12px;
}

.model-row__actions {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.inline-confirm {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: 2px 8px;
  background: color-mix(in srgb, var(--ops-danger, #f85149) 12%, transparent 88%);
  border: 1px solid var(--ops-danger, #f85149);
  border-radius: var(--ops-radius);
}

.inline-confirm__text {
  font-size: 11px;
  color: var(--ops-danger, #f85149);
  font-weight: 500;
}

.quick-add-drawer,
.batch-import-drawer {
  padding: var(--ops-space-3) var(--ops-space-4);
  background: color-mix(in srgb, var(--ops-bg) 95%, var(--ops-primary, #388bfd) 5%);
  border-bottom: 1px solid var(--ops-border);
}

.quick-add-drawer__title {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  margin-bottom: var(--ops-space-2);
  font-size: 12px;
}

.quick-add-drawer__fields {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  flex-wrap: wrap;
}

.batch-import-drawer__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--ops-space-2);
}

.batch-import-drawer__actions {
  display: flex;
  gap: var(--ops-space-2);
}

.batch-import-drawer__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--ops-space-2);
  max-height: 180px;
  overflow-y: auto;
  padding: var(--ops-space-2) 0;
}

.batch-import-drawer__item {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  font-size: 12px;
  cursor: pointer;
}

.model-form-card {
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  background: var(--ops-bg-card, var(--ops-bg));
  overflow: hidden;
}

.model-form-card__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--ops-space-3) var(--ops-space-4);
  cursor: pointer;
  user-select: none;
}

.model-form-card__title {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.model-form-card__body {
  padding: var(--ops-space-3) var(--ops-space-4);
  border-top: 1px solid var(--ops-border);
}

.model-form-card__foot {
  display: flex;
  gap: var(--ops-space-2);
  margin-top: var(--ops-space-4);
}

.models-input-row {
  display: flex;
  gap: var(--ops-space-2);
}

.models-input-row .ops-input {
  flex: 1;
}
</style>
