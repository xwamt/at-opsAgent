<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  CUSTOM_PROVIDER_ID,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PRESETS,
  ROLE_MODEL_ROLES,
  THINKING_FORMATS,
  THINKING_LEVELS,
  isReasoningModel,
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

// 批量拉取导入抽屉状态
const batchImportProviderId = ref<string | null>(null);
const selectedBatchModels = ref<string[]>([]);
const batchSearchQuery = ref('');
const manualBatchModelId = ref('');

// 表单内「从 API 选择模型」浮层状态与内联建议下拉
const showFormModelPicker = ref(false);
const formModelSearchQuery = ref('');
const showInlineSuggestions = ref(false);

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

const filteredFormSuggestions = computed(() => {
  const query = formModelSearchQuery.value.trim().toLowerCase();
  if (!query) return modelSuggestions.value;
  return modelSuggestions.value.filter((id) => id.toLowerCase().includes(query));
});

const inlineFilteredSuggestions = computed(() => {
  const query = store.models.modelId.trim().toLowerCase();
  if (!query) return modelSuggestions.value;
  return modelSuggestions.value.filter((id) => id.toLowerCase().includes(query));
});

function getQuickPresetModels(providerId: string): readonly string[] {
  const preset = providerPresetById(providerId);
  return preset?.models ?? [];
}

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

// 批量抽屉中当前服务商的建议模型及搜索筛选
const currentBatchGroup = computed(() =>
  displayProviderGroups.value.find((g) => g.providerId === batchImportProviderId.value)
);

const filteredBatchModels = computed(() => {
  const query = batchSearchQuery.value.trim().toLowerCase();
  if (!query) return store.modelSuggestions;
  return store.modelSuggestions.filter((id) => id.toLowerCase().includes(query));
});

function isModelInGroup(group: ConfiguredProviderGroup | undefined, modelId: string): boolean {
  if (!group) return false;
  return group.models.some((m) => m.id === modelId);
}

function startAddProvider(): void {
  store.selectProviderPreset('openai');
  store.models.modelId = '';
  store.models.modelName = '';
  store.models.apiKey = '';
  isEditing.value = true;
  showFormModelPicker.value = false;
  showInlineSuggestions.value = false;
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
  showFormModelPicker.value = false;
  showInlineSuggestions.value = false;
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
  showFormModelPicker.value = false;
  showInlineSuggestions.value = false;
  formCardRef.value?.scrollIntoView({ behavior: 'smooth' });
}

function cancelEdit(): void {
  isEditing.value = false;
  store.editingModelId = '';
  showFormModelPicker.value = false;
  showInlineSuggestions.value = false;
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
    reasoning: quickModelReasoning.value || isReasoningModel(mId)
  });
  closeQuickAdd();
}

function onQuickModelIdChange(id: string): void {
  quickModelId.value = id;
  if (!quickModelName.value) {
    quickModelName.value = id;
  }
  if (isReasoningModel(id)) {
    quickModelReasoning.value = true;
  }
}

// ── 批量导入抽屉 ──
function openBatchImport(provider: ConfiguredProviderGroup): void {
  batchImportProviderId.value = provider.providerId;
  selectedBatchModels.value = [];
  batchSearchQuery.value = '';
  store.models.providerId = provider.providerId;
  store.models.baseUrl = provider.baseUrl;
  store.fetchModels({
    providerId: provider.providerId,
    baseUrl: provider.baseUrl
  });
}

function refreshBatchModels(provider: ConfiguredProviderGroup): void {
  store.fetchModels({
    providerId: provider.providerId,
    baseUrl: provider.baseUrl
  });
}

function closeBatchImport(): void {
  batchImportProviderId.value = null;
  selectedBatchModels.value = [];
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
  const targets = filteredBatchModels.value;
  for (const id of targets) {
    if (!selectedBatchModels.value.includes(id)) {
      selectedBatchModels.value.push(id);
    }
  }
}

function selectUnaddedBatchModels(group: ConfiguredProviderGroup): void {
  const unadded = filteredBatchModels.value.filter((id) => !isModelInGroup(group, id));
  selectedBatchModels.value = [...new Set([...selectedBatchModels.value, ...unadded])];
}

function deselectAllBatchModels(): void {
  selectedBatchModels.value = [];
}

function invertBatchSelection(): void {
  const currentFiltered = filteredBatchModels.value;
  const newSelection: string[] = [];
  for (const id of currentFiltered) {
    if (!selectedBatchModels.value.includes(id)) {
      newSelection.push(id);
    }
  }
  selectedBatchModels.value = newSelection;
}

function addManualBatchModel(group: ConfiguredProviderGroup): void {
  const mId = manualBatchModelId.value.trim();
  if (!mId) return;
  if (!store.modelSuggestions.includes(mId)) {
    store.modelSuggestions.unshift(mId);
  }
  if (!selectedBatchModels.value.includes(mId)) {
    selectedBatchModels.value.push(mId);
  }
  manualBatchModelId.value = '';
}

function submitBatchImport(provider: ConfiguredProviderGroup): void {
  if (selectedBatchModels.value.length === 0) return;
  store.batchAddFetchedModels(provider.providerId, provider.baseUrl, selectedBatchModels.value);
  closeBatchImport();
}

// ── 表单内一键获取并选择模型 ──
function triggerFormFetchAndPick(): void {
  if (!store.models.baseUrl.trim()) {
    store.setStatus('models', false, t('mRequired'));
    return;
  }
  showFormModelPicker.value = true;
  formModelSearchQuery.value = '';
  store.fetchModels({
    providerId: store.models.providerId,
    baseUrl: store.models.baseUrl,
    apiKey: store.models.apiKey
  });
}

function pickModelForForm(id: string): void {
  store.models.modelId = id;
  if (!store.models.modelName) {
    store.models.modelName = id;
  }
  if (isReasoningModel(id)) {
    store.models.reasoning = true;
  }
  showFormModelPicker.value = false;
  showInlineSuggestions.value = false;
}

function selectInlineSuggestion(id: string): void {
  store.models.modelId = id;
  if (!store.models.modelName) {
    store.models.modelName = id;
  }
  if (isReasoningModel(id)) {
    store.models.reasoning = true;
  }
  showInlineSuggestions.value = false;
}

function applyCustomModelForForm(customId: string): void {
  const trimmed = customId.trim();
  if (!trimmed) return;
  store.models.modelId = trimmed;
  if (!store.models.modelName) {
    store.models.modelName = trimmed;
  }
  if (isReasoningModel(trimmed)) {
    store.models.reasoning = true;
  }
  showFormModelPicker.value = false;
  showInlineSuggestions.value = false;
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
        <button type="button" class="ops-btn ops-btn--primary" @click="startAddProvider">
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
          @click="store.openModelsJson"
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
        <button type="button" class="ops-btn ops-btn--primary ops-btn--sm" @click="startAddProvider">
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
                <span class="ops-badge ops-badge--ghost ops-mono">
                  {{ group.models.length }} {{ t('mProviderModels') }}
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
                  {{ t('mConfirmDeleteBtn') }}
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
                  @click="openBatchImport(group)"
                >
                  <span class="codicon codicon-cloud-download" aria-hidden="true"></span>
                  {{ t('mFetchModels') }}
                </button>
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
                placeholder="模型 ID (如 deepseek-chat, gpt-4o, 或自定义模型)"
                @input="onQuickModelIdChange(quickModelId)"
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
                {{ t('mConfirmAddBtn') }}
              </button>
              <button
                type="button"
                class="ops-btn ops-btn--secondary ops-btn--xs"
                @click="closeQuickAdd"
              >
                {{ t('mCancelBtn') }}
              </button>
            </div>
            <!-- 常用模型推荐标签 (点击可直接填入) -->
            <div v-if="getQuickPresetModels(group.providerId).length > 0" class="quick-add-chips">
              <span class="quick-add-chips__label ops-muted">{{ t('mQuickSuggestions') }}:</span>
              <button
                v-for="chip in getQuickPresetModels(group.providerId)"
                :key="chip"
                type="button"
                class="ops-btn ops-btn--ghost ops-btn--xs ops-mono quick-chip-btn"
                :class="{ 'quick-chip-btn--active': quickModelId === chip }"
                @click="onQuickModelIdChange(chip)"
              >
                {{ chip }}
              </button>
            </div>
          </div>

          <!-- 对标 Kilo 的批量拉取与导入模型抽屉 -->
          <div v-if="batchImportProviderId === group.providerId" class="batch-import-drawer">
            <div class="batch-import-drawer__head">
              <div class="batch-import-drawer__title-block">
                <strong>
                  <span class="codicon codicon-cloud-download" aria-hidden="true"></span>
                  {{ t('mBatchImportTitle') }}
                </strong>
                <span class="ops-badge ops-badge--secondary ops-mono">{{ group.providerId }}</span>
                <span v-if="!store.fetchingModels && store.modelSuggestions.length > 0" class="batch-import-drawer__count-badge">
                  {{ t('mFetchedCount') }} {{ store.modelSuggestions.length }} 个 · {{ t('mSelectedCount') }} {{ selectedBatchModels.length }} 项
                </span>
              </div>
              <div class="batch-import-drawer__actions">
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  :disabled="store.fetchingModels"
                  @click="refreshBatchModels(group)"
                >
                  <span
                    class="codicon"
                    :class="store.fetchingModels ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'"
                    aria-hidden="true"
                  ></span>
                  刷新
                </button>
                <button
                  type="button"
                  class="ops-btn ops-btn--primary ops-btn--xs"
                  :disabled="selectedBatchModels.length === 0"
                  @click="submitBatchImport(group)"
                >
                  <span class="codicon codicon-check" aria-hidden="true"></span>
                  {{ t('mBatchAddBtn') }} ({{ selectedBatchModels.length }})
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

            <!-- 加载状态 -->
            <div v-if="store.fetchingModels" class="batch-import-drawer__loading ops-muted">
              <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
              {{ t('mFetching') }}
            </div>

            <!-- 批量模型多选、搜索与自定义添加面板 -->
            <div v-else class="batch-import-drawer__content">
              <!-- 搜索与快捷多选过滤工具栏 -->
              <div class="batch-import-drawer__filter-row">
                <div class="batch-import-search-box">
                  <span class="codicon codicon-search" aria-hidden="true"></span>
                  <input
                    v-model="batchSearchQuery"
                    type="text"
                    class="ops-input ops-input--sm batch-import-search-input"
                    :placeholder="t('mSearchModelPh')"
                  />
                  <button
                    v-if="batchSearchQuery"
                    type="button"
                    class="search-clear-btn"
                    @click="batchSearchQuery = ''"
                  >
                    <span class="codicon codicon-close" aria-hidden="true"></span>
                  </button>
                </div>
                <div class="batch-import-quick-selects">
                  <button
                    type="button"
                    class="ops-btn ops-btn--secondary ops-btn--xs"
                    @click="selectAllBatchModels"
                  >
                    {{ t('mSelectAll') }}
                  </button>
                  <button
                    type="button"
                    class="ops-btn ops-btn--secondary ops-btn--xs"
                    @click="selectUnaddedBatchModels(group)"
                  >
                    {{ t('mSelectUnadded') }}
                  </button>
                  <button
                    type="button"
                    class="ops-btn ops-btn--secondary ops-btn--xs"
                    @click="invertBatchSelection"
                  >
                    {{ t('mInvertSelect') }}
                  </button>
                  <button
                    v-if="selectedBatchModels.length > 0"
                    type="button"
                    class="ops-btn ops-btn--ghost ops-btn--xs"
                    @click="deselectAllBatchModels"
                  >
                    {{ t('mDeselectAll') }}
                  </button>
                </div>
              </div>

              <!-- 手动添加自定义模型到批量清单 -->
              <div class="batch-import-drawer__manual-row">
                <input
                  v-model="manualBatchModelId"
                  type="text"
                  class="ops-input ops-input--sm ops-mono batch-import-manual-input"
                  :placeholder="t('mAddCustomPh')"
                  @keydown.enter.prevent="addManualBatchModel(group)"
                />
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary ops-btn--xs"
                  :disabled="!manualBatchModelId.trim()"
                  @click="addManualBatchModel(group)"
                >
                  <span class="codicon codicon-add" aria-hidden="true"></span>
                  {{ t('mAddBtn') }}
                </button>
              </div>

              <!-- 模型选择网格列表 -->
              <div class="batch-import-drawer__list">
                <div
                  v-for="suggested in filteredBatchModels"
                  :key="suggested"
                  class="batch-import-drawer__item-card"
                  :class="{
                    'batch-import-drawer__item-card--selected': selectedBatchModels.includes(suggested),
                    'batch-import-drawer__item-card--exists': isModelInGroup(group, suggested)
                  }"
                  @click="toggleSelectBatchModel(suggested)"
                >
                  <input
                    type="checkbox"
                    :checked="selectedBatchModels.includes(suggested)"
                    @click.stop
                    @change="toggleSelectBatchModel(suggested)"
                  />
                  <div class="batch-import-item-info">
                    <span class="ops-mono batch-import-model-name">{{ suggested }}</span>
                    <div class="batch-import-item-badges">
                      <span v-if="isModelInGroup(group, suggested)" class="ops-badge ops-badge--success ops-badge--xs">
                        {{ t('mAlreadyAdded') }}
                      </span>
                      <span v-if="isReasoningModel(suggested)" class="ops-badge ops-badge--info ops-badge--xs">
                        <span class="codicon codicon-sparkle" aria-hidden="true"></span>
                        {{ t('mReasoning') }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 搜索过滤为空 -->
              <div v-if="filteredBatchModels.length === 0" class="batch-import-empty-search ops-muted">
                {{ t('mFilterEmpty') }}
              </div>
            </div>
          </div>

          <!-- 服务商下的已配置模型列表 -->
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
                    {{ t('mConfirmDeleteBtn') }}
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

        <!-- 模型 ID 输入与对标 Kilo 的一键 API 获取选择浮层 -->
        <div class="set-row">
          <label class="set-label" for="models-model-id">{{ t('mModelId') }}</label>
          <div class="set-ctrl">
            <div class="models-combobox-container">
              <div class="models-input-row">
                <div class="models-combobox-input-wrapper">
                  <input
                    id="models-model-id"
                    v-model="store.models.modelId"
                    type="text"
                    class="ops-input ops-mono models-combobox-input"
                    placeholder="例如 deepseek-chat, gpt-4o, qwen-plus, 或自定义模型 ID"
                    @focus="showInlineSuggestions = true"
                    @input="isReasoningModel(store.models.modelId) ? (store.models.reasoning = true) : null"
                  />
                  <button
                    v-if="modelSuggestions.length > 0"
                    type="button"
                    class="models-combobox-toggle-btn"
                    :title="t('mSelectModel')"
                    @click="showInlineSuggestions = !showInlineSuggestions"
                  >
                    <span class="codicon" :class="showInlineSuggestions ? 'codicon-chevron-up' : 'codicon-chevron-down'" aria-hidden="true"></span>
                  </button>
                </div>
                <button
                  type="button"
                  class="ops-btn ops-btn--secondary"
                  :disabled="store.fetchingModels || !store.models.baseUrl"
                  @click="triggerFormFetchAndPick"
                >
                  <span
                    class="codicon"
                    :class="store.fetchingModels ? 'codicon-loading codicon-modifier-spin' : 'codicon-cloud-download'"
                    aria-hidden="true"
                  ></span>
                  {{ store.fetchingModels ? t('mFetching') : t('mSelectModelFromApi') }}
                </button>
              </div>

              <!-- 下拉候选气泡 (Combobox Dropdown) -->
              <div v-if="showInlineSuggestions && modelSuggestions.length > 0" class="models-inline-suggestions-dropdown">
                <div class="models-inline-suggestions-head">
                  <span class="ops-muted">{{ t('mSelectFromSuggestions') }} ({{ modelSuggestions.length }})</span>
                  <button type="button" class="ops-btn ops-btn--ghost ops-btn--xs" @click="showInlineSuggestions = false">
                    <span class="codicon codicon-close" aria-hidden="true"></span>
                  </button>
                </div>
                <!-- 用户输入了自定义模型 ID 且不在建议列表中，提示使用自定义模型 -->
                <div
                  v-if="store.models.modelId.trim() && !modelSuggestions.includes(store.models.modelId.trim())"
                  class="models-inline-suggestion-item models-inline-suggestion-item--custom"
                  @click="showInlineSuggestions = false"
                >
                  <div class="models-inline-custom-content">
                    <span class="codicon codicon-edit" aria-hidden="true"></span>
                    <span>{{ t('mUseCustomModel') }}: <strong class="ops-mono">{{ store.models.modelId.trim() }}</strong></span>
                  </div>
                  <span class="ops-badge ops-badge--info ops-badge--xs">{{ t('mCustomModelBadge') }}</span>
                </div>
                <div class="models-inline-suggestions-list">
                  <div
                    v-for="id in inlineFilteredSuggestions"
                    :key="id"
                    class="models-inline-suggestion-item"
                    :class="{ 'models-inline-suggestion-item--active': store.models.modelId === id }"
                    @click="selectInlineSuggestion(id)"
                  >
                    <span class="ops-mono">{{ id }}</span>
                    <span v-if="isReasoningModel(id)" class="ops-badge ops-badge--info ops-badge--xs">
                      <span class="codicon codicon-sparkle" aria-hidden="true"></span>
                      {{ t('mReasoning') }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <span class="set-ctrl__hint ops-muted">{{ t('mModelIdHint') }}</span>

            <!-- 交互式模型挑选浮层 -->
            <div v-if="showFormModelPicker" class="form-model-picker-modal">
              <div class="form-model-picker-modal__head">
                <strong>
                  <span class="codicon codicon-symbol-misc" aria-hidden="true"></span>
                  {{ t('mSelectFromSuggestions') }} ({{ modelSuggestions.length }})
                </strong>
                <button
                  type="button"
                  class="ops-btn ops-btn--ghost ops-btn--xs"
                  @click="showFormModelPicker = false"
                >
                  <span class="codicon codicon-close" aria-hidden="true"></span>
                </button>
              </div>

              <div class="form-model-picker-modal__search">
                <span class="codicon codicon-search" aria-hidden="true"></span>
                <input
                  v-model="formModelSearchQuery"
                  type="text"
                  class="ops-input ops-input--sm"
                  :placeholder="t('mSearchModelPh')"
                  autofocus
                />
              </div>

              <!-- 搜索过滤中支持一键使用自定义输入 -->
              <div
                v-if="formModelSearchQuery.trim() && !modelSuggestions.includes(formModelSearchQuery.trim())"
                class="form-model-picker-modal__custom-choice"
                @click="applyCustomModelForForm(formModelSearchQuery)"
              >
                <div class="form-model-picker-modal__custom-label">
                  <span class="codicon codicon-add" aria-hidden="true"></span>
                  <span>{{ t('mUseCustomModel') }}: <strong class="ops-mono">{{ formModelSearchQuery.trim() }}</strong></span>
                </div>
                <button type="button" class="ops-btn ops-btn--primary ops-btn--xs">{{ t('mSelectModel') }}</button>
              </div>

              <div v-if="store.fetchingModels" class="form-model-picker-modal__loading ops-muted">
                <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
                {{ t('mFetching') }}
              </div>
              <div v-else-if="filteredFormSuggestions.length === 0 && !formModelSearchQuery.trim()" class="form-model-picker-modal__empty ops-muted">
                {{ t('mFilterEmpty') }}
              </div>
              <div v-else-if="filteredFormSuggestions.length > 0" class="form-model-picker-modal__list">
                <div
                  v-for="id in filteredFormSuggestions"
                  :key="id"
                  class="form-model-picker-modal__item"
                  :class="{ 'form-model-picker-modal__item--active': store.models.modelId === id }"
                  @click="pickModelForForm(id)"
                >
                  <span class="ops-mono">{{ id }}</span>
                  <span v-if="isReasoningModel(id)" class="ops-badge ops-badge--info ops-badge--xs">
                    <span class="codicon codicon-sparkle" aria-hidden="true"></span>
                    {{ t('mReasoning') }}
                  </span>
                </div>
              </div>
            </div>
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

        <div class="set-row">
          <span class="set-label">{{ t('modelsSectionCompat') }}</span>
          <div class="set-ctrl">
            <label class="ops-checkbox-label">
              <input v-model="store.models.supportsDeveloperRole" type="checkbox" />
              <span>{{ t('mSupportsDeveloperRole') }}</span>
            </label>
            <span class="set-ctrl__hint ops-muted">{{ t('mCompatHint') }}</span>
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
              @click="store.oauthLogin"
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

/* 批量导入抽屉优化样式 */
.batch-import-drawer__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--ops-space-3);
  gap: var(--ops-space-3);
  flex-wrap: wrap;
}

.batch-import-drawer__title-block {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  flex-wrap: wrap;
}

.batch-import-drawer__count-badge {
  font-size: 11px;
  color: var(--ops-muted);
}

.batch-import-drawer__actions {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
}

.batch-import-drawer__content {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.batch-import-drawer__filter-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--ops-space-2);
  flex-wrap: wrap;
}

.batch-import-search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 200px;
}

.batch-import-search-box .codicon-search {
  position: absolute;
  left: 8px;
  color: var(--ops-muted);
  font-size: 12px;
  pointer-events: none;
}

.batch-import-search-input {
  padding-left: 28px !important;
  padding-right: 24px !important;
  width: 100%;
}

.search-clear-btn {
  position: absolute;
  right: 6px;
  background: none;
  border: none;
  color: var(--ops-muted);
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
}

.batch-import-quick-selects {
  display: flex;
  align-items: center;
  gap: 6px;
}

.batch-import-drawer__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  background: var(--ops-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
}

.batch-import-drawer__item-card {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: 6px 10px;
  background: var(--ops-bg-card, var(--ops-bg));
  border: 1px solid var(--ops-border);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.batch-import-drawer__item-card:hover {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 10%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
}

.batch-import-drawer__item-card--selected {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 15%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
}

.batch-import-drawer__item-card--exists {
  opacity: 0.85;
}

.batch-import-item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.batch-import-model-name {
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.batch-import-item-badges {
  display: flex;
  align-items: center;
  gap: 4px;
}

.batch-import-drawer__loading,
.batch-import-drawer__empty,
.batch-import-empty-search {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ops-space-2);
  padding: var(--ops-space-4);
  font-size: 12px;
  text-align: center;
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

/* 表单内交互式模型选择浮层 */
.form-model-picker-modal {
  margin-top: var(--ops-space-2);
  background: var(--ops-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-3);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.form-model-picker-modal__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.form-model-picker-modal__search {
  position: relative;
  display: flex;
  align-items: center;
}

.form-model-picker-modal__search .codicon-search {
  position: absolute;
  left: 8px;
  color: var(--ops-muted);
  font-size: 12px;
  pointer-events: none;
}

.form-model-picker-modal__search .ops-input {
  padding-left: 28px !important;
  width: 100%;
}

.form-model-picker-modal__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding: 4px;
}

.form-model-picker-modal__item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--ops-space-2);
  padding: 6px 10px;
  background: var(--ops-bg-card, var(--ops-bg));
  border: 1px solid var(--ops-border);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.form-model-picker-modal__item:hover {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 12%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
}

.form-model-picker-modal__item--active {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 20%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
  font-weight: 600;
}

.form-model-picker-modal__loading,
.form-model-picker-modal__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ops-space-2);
  padding: var(--ops-space-3);
  font-size: 12px;
}

/* 快速添加候选推荐 Chips */
.quick-add-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.quick-add-chips__label {
  font-size: 11px;
}

.quick-chip-btn {
  font-size: 11px !important;
  padding: 1px 6px !important;
  border: 1px dashed var(--ops-border);
  border-radius: 3px;
}

.quick-chip-btn:hover {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 12%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
}

.quick-chip-btn--active {
  background: var(--ops-primary, #388bfd) !important;
  color: #fff !important;
  border-color: var(--ops-primary, #388bfd) !important;
}

/* 批量导入手动追加自定义模型 */
.batch-import-drawer__manual-row {
  display: flex;
  gap: var(--ops-space-2);
  align-items: center;
  padding: 4px 0;
}

.batch-import-manual-input {
  flex: 1;
}

/* Combobox 可输入下拉组件样式 */
.models-combobox-container {
  position: relative;
  width: 100%;
}

.models-combobox-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
}

.models-combobox-input {
  padding-right: 28px !important;
  width: 100%;
}

.models-combobox-toggle-btn {
  position: absolute;
  right: 4px;
  background: transparent;
  border: none;
  color: var(--ops-muted);
  cursor: pointer;
  padding: 2px 4px;
  display: flex;
  align-items: center;
  border-radius: 3px;
}

.models-combobox-toggle-btn:hover {
  color: var(--ops-fg);
  background: var(--ops-hover-bg);
}

.models-inline-suggestions-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--ops-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 6px;
  max-height: 220px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.models-inline-suggestions-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  padding: 2px 4px;
  border-bottom: 1px solid var(--ops-border);
  margin-bottom: 2px;
}

.models-inline-suggestions-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px;
  overflow-y: auto;
  max-height: 150px;
  padding: 2px;
}

.models-inline-suggestion-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--ops-bg-card, var(--ops-bg));
  border: 1px solid var(--ops-border);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.models-inline-suggestion-item:hover {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 12%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
}

.models-inline-suggestion-item--active {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 20%, var(--ops-bg));
  border-color: var(--ops-primary, #388bfd);
  font-weight: 600;
}

.models-inline-suggestion-item--custom {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 8%, var(--ops-bg));
  border-style: dashed;
  border-color: var(--ops-primary, #388bfd);
  margin-bottom: 2px;
}

.models-inline-custom-content {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

/* API 选择浮层自定义选项 */
.form-model-picker-modal__custom-choice {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 10%, var(--ops-bg));
  border: 1px dashed var(--ops-primary, #388bfd);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.form-model-picker-modal__custom-choice:hover {
  background: color-mix(in srgb, var(--ops-primary, #388bfd) 18%, var(--ops-bg));
}

.form-model-picker-modal__custom-label {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
