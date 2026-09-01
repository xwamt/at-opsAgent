<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t, tf } from '../i18n';
import { useOpsStore, type ModelOption } from '../store';

const store = useOpsStore();

const SEP = '\u0000'; // provider/model 复合 value 分隔符（model id 里不会出现）

interface OptionView extends ModelOption {
  value: string;
}

interface ProviderGroup {
  provider: string;
  items: OptionView[];
}

const open = ref(false);
const filterQuery = ref('');
const highlightIndex = ref(-1);
const rootEl = ref<HTMLElement | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);

const options = computed<OptionView[]>(() => {
  const list: OptionView[] = store.modelOptions.map((m) => ({
    ...m,
    value: m.provider + SEP + m.model
  }));
  // 当前模型不在列表里（如 host 侧手工配置）时补一个只读项
  if (store.modelLabel && !list.some((m) => m.model === store.modelLabel)) {
    list.unshift({
      provider: store.modelProvider || 'custom',
      model: store.modelLabel,
      label: store.modelLabel,
      value: (store.modelProvider || 'custom') + SEP + store.modelLabel
    });
  }
  return list;
});

const showFilter = computed(() => options.value.length > 5 || filterQuery.value.length > 0);

const currentOption = computed(() => {
  const hit =
    options.value.find(
      (m) =>
        m.model === store.modelLabel &&
        (!store.modelProvider || m.provider === store.modelProvider)
    ) ?? options.value.find((m) => m.model === store.modelLabel);
  if (hit) {
    return hit;
  }
  return options.value.length > 0 ? options.value[0] : null;
});

const currentLabel = computed(() => currentOption.value?.label ?? '');

const groupedOptions = computed<ProviderGroup[]>(() => {
  const map = new Map<string, OptionView[]>();
  for (const opt of options.value) {
    const key = opt.provider || 'custom';
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(opt);
    } else {
      map.set(key, [opt]);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, items]) => ({ provider, items }));
});

function matchesFilter(opt: OptionView, q: string): boolean {
  const hay = `${opt.label} ${opt.model} ${opt.provider}`.toLowerCase();
  return hay.includes(q);
}

const filteredGroups = computed<ProviderGroup[]>(() => {
  const q = filterQuery.value.trim().toLowerCase();
  if (!q) {
    return groupedOptions.value;
  }
  return groupedOptions.value
    .map((group) => ({
      provider: group.provider,
      items: group.items.filter((opt) => matchesFilter(opt, q))
    }))
    .filter((group) => group.items.length > 0);
});

const flatNavItems = computed(() => filteredGroups.value.flatMap((group) => group.items));

function providerLabel(provider: string): string {
  return provider && provider !== 'custom' ? provider : t('modelSelectorProviderCustom');
}

function isCurrent(opt: OptionView): boolean {
  return (
    opt.model === store.modelLabel &&
    (!store.modelProvider || opt.provider === store.modelProvider)
  );
}

function select(opt: OptionView): void {
  store.setModel(opt.provider, opt.model);
  closePanel();
}

function selectCustom(customModelId: string): void {
  const model = customModelId.trim();
  if (!model) return;
  const provider = store.modelProvider || (store.modelOptions[0]?.provider ?? 'custom');
  store.setModel(provider, model);
  closePanel();
}

function openSettings(): void {
  closePanel();
  store.openSettings('models');
}

function closePanel(): void {
  open.value = false;
  filterQuery.value = '';
  highlightIndex.value = -1;
}

function togglePanel(): void {
  open.value = !open.value;
}

function syncHighlightToCurrent(): void {
  const idx = flatNavItems.value.findIndex((opt) => isCurrent(opt));
  highlightIndex.value = idx >= 0 ? idx : flatNavItems.value.length > 0 ? 0 : -1;
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    return;
  }
  syncHighlightToCurrent();
  await nextTick();
  if (showFilter.value) {
    filterInput.value?.focus();
    filterInput.value?.select();
  } else {
    focusHighlightedItem();
  }
});

watch(filterQuery, () => {
  highlightIndex.value = flatNavItems.value.length > 0 ? 0 : -1;
});

function focusHighlightedItem(): void {
  if (highlightIndex.value < 0) {
    return;
  }
  rootEl.value
    ?.querySelectorAll<HTMLButtonElement>('.modelsel__item')
    [highlightIndex.value]?.focus();
}

function moveHighlight(delta: number): void {
  const len = flatNavItems.value.length;
  if (len === 0) {
    highlightIndex.value = -1;
    return;
  }
  let next = highlightIndex.value < 0 ? 0 : highlightIndex.value + delta;
  if (next < 0) {
    next = len - 1;
  } else if (next >= len) {
    next = 0;
  }
  highlightIndex.value = next;
  focusHighlightedItem();
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closePanel();
    rootEl.value?.querySelector<HTMLButtonElement>('.modelsel__trigger')?.focus();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveHighlight(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveHighlight(-1);
    return;
  }
  if (event.key === 'Enter') {
    if (highlightIndex.value >= 0 && flatNavItems.value[highlightIndex.value]) {
      event.preventDefault();
      select(flatNavItems.value[highlightIndex.value]);
    } else if (filterQuery.value.trim()) {
      event.preventDefault();
      selectCustom(filterQuery.value);
    }
  }
}

function onDocClick(event: MouseEvent): void {
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) {
    closePanel();
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick, true);
});
</script>

<template>
  <!-- 空态 = 未配置：可点按钮直达设置 Models 页（P1-5，不再是 disabled option） -->
  <button
    v-if="options.length === 0"
    type="button"
    class="modelsel modelsel--empty"
    :aria-label="t('modelSelectorEmptyAria')"
    :title="t('modelSelectorEmptyAria')"
    @click="store.openSettings('models')"
  >
    <span class="codicon codicon-add" aria-hidden="true"></span>
    <span class="modelsel__empty-label">{{ t('modelSelectorEmpty') }}</span>
  </button>

  <div v-else ref="rootEl" class="modelsel">
    <button
      type="button"
      class="modelsel__trigger"
      :aria-label="t('modelSelectorAria')"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :title="currentLabel"
      @click="togglePanel"
    >
      <span class="codicon codicon-chip modelsel__icon" aria-hidden="true"></span>
      <span class="modelsel__label">{{ currentLabel }}</span>
      <span
        class="codicon modelsel__chevron"
        :class="open ? 'codicon-chevron-up' : 'codicon-chevron-down'"
        aria-hidden="true"
      ></span>
    </button>

    <div
      v-if="open"
      class="modelsel__panel"
      role="presentation"
      @keydown="onPanelKeydown"
    >
      <div v-if="showFilter" class="modelsel__filter">
        <span class="codicon codicon-search modelsel__filter-icon" aria-hidden="true"></span>
        <input
          ref="filterInput"
          v-model="filterQuery"
          type="search"
          class="modelsel__filter-input"
          :placeholder="t('modelSelectorFilterPlaceholder')"
          :aria-label="t('modelSelectorFilterAria')"
          @keydown.stop
        />
      </div>

      <div
        class="modelsel__list"
        role="listbox"
        :aria-label="t('modelSelectorAria')"
        :aria-activedescendant="
          highlightIndex >= 0 ? `modelsel-opt-${highlightIndex}` : undefined
        "
      >
        <!-- 输入自定义模型快捷选项 -->
        <div
          v-if="filterQuery.trim() && !options.some((o) => o.model.toLowerCase() === filterQuery.trim().toLowerCase())"
          class="modelsel__custom-group"
        >
          <button
            type="button"
            class="modelsel__item modelsel__item--custom"
            @click="selectCustom(filterQuery)"
          >
            <span class="modelsel__item-label">
              <span class="codicon codicon-add" aria-hidden="true"></span>
              {{ tf('modelSelectorCustomOption', { model: filterQuery.trim() }) }}
            </span>
            <span class="modelsel__item-id ops-mono ops-muted">{{ filterQuery.trim() }}</span>
          </button>
        </div>

        <template v-for="group in filteredGroups" :key="group.provider">
          <header class="modelsel__group ops-muted">{{ providerLabel(group.provider) }}</header>
          <button
            v-for="opt in group.items"
            :id="`modelsel-opt-${flatNavItems.indexOf(opt)}`"
            :key="opt.value"
            type="button"
            class="modelsel__item"
            role="option"
            :aria-selected="isCurrent(opt)"
            :class="{
              'modelsel__item--current': isCurrent(opt),
              'modelsel__item--highlight': flatNavItems.indexOf(opt) === highlightIndex
            }"
            @click="select(opt)"
            @mouseenter="highlightIndex = flatNavItems.indexOf(opt)"
          >
            <span class="modelsel__item-label">{{ opt.label }}</span>
            <span class="modelsel__item-id ops-mono ops-muted">{{ opt.model }}</span>
          </button>
        </template>
        <p v-if="flatNavItems.length === 0 && !filterQuery.trim()" class="modelsel__empty-filter ops-muted">
          {{ t('modelSelectorNoMatch') }}
        </p>
      </div>

      <button type="button" class="modelsel__footer" @click="openSettings">
        <span class="codicon codicon-settings-gear" aria-hidden="true"></span>
        {{ t('modelSelectorManage') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.modelsel {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

/* 空态按钮：与工具条同族的低调按钮，但可点、可聚焦 */
.modelsel--empty {
  background: transparent;
  border: 1px dashed var(--ops-border);
  border-radius: var(--ops-radius);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 1px var(--ops-space-2);
  font-size: var(--ops-font-sm);
  white-space: nowrap;
}

.modelsel--empty:hover {
  background: var(--ops-toolbar-hover-bg);
  color: var(--ops-fg);
  border-color: var(--ops-accent);
}

.modelsel--empty:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.modelsel--empty .codicon {
  font-size: var(--ops-font-sm);
}

.modelsel__trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  max-width: 220px;
  background: transparent;
  border: none;
  border-radius: var(--ops-radius-ctl);
  color: var(--ops-fg);
  cursor: pointer;
  padding: 1px var(--ops-space-1);
  font-family: inherit;
  font-size: var(--ops-font-sm);
}

.modelsel__trigger:hover {
  background: var(--ops-toolbar-hover-bg);
}

.modelsel__trigger:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.modelsel__icon {
  color: var(--ops-muted);
  font-size: var(--ops-font-sm);
  flex: 0 0 auto;
}

.modelsel__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.modelsel__chevron {
  color: var(--ops-muted);
  font-size: var(--ops-font-xs);
  flex: 0 0 auto;
}

.modelsel__panel {
  position: absolute;
  bottom: calc(100% + var(--ops-space-1));
  left: 0;
  z-index: 20;
  background: var(--ops-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  box-shadow: var(--ops-shadow);
  min-width: 260px;
  max-width: min(360px, 90vw);
  max-height: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modelsel__filter {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  padding: var(--ops-space-1) var(--ops-space-2);
  border-bottom: 1px solid var(--ops-border);
}

.modelsel__filter-icon {
  color: var(--ops-muted);
  font-size: var(--ops-font-sm);
  flex: 0 0 auto;
}

.modelsel__filter-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  color: var(--ops-input-fg);
  font-family: inherit;
  font-size: var(--ops-font-sm);
  padding: 0;
}

.modelsel__filter-input:focus {
  outline: none;
}

.modelsel__list {
  flex: 1 1 auto;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--ops-space-1);
}

.modelsel__group {
  font-size: var(--ops-font-xs);
  padding: var(--ops-space-1) var(--ops-space-2);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.modelsel__item {
  display: grid;
  grid-template-columns: 1fr max-content;
  align-items: baseline;
  gap: 2px var(--ops-space-2);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
  color: var(--ops-fg);
  cursor: pointer;
  font-size: var(--ops-font-sm);
}

.modelsel__item:hover,
.modelsel__item:focus-visible,
.modelsel__item--highlight {
  background: var(--ops-hover-bg);
  outline: none;
}

.modelsel__item:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.modelsel__item--current {
  border-left: 2px solid var(--ops-accent);
}

.modelsel__custom-group {
  padding: 2px 0;
  border-bottom: 1px solid var(--ops-border);
  margin-bottom: 2px;
}

.modelsel__item--custom {
  background: color-mix(in srgb, var(--ops-accent, #388bfd) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--ops-accent, #388bfd) 50%, transparent);
  margin-bottom: 2px;
}

.modelsel__item--custom:hover {
  background: color-mix(in srgb, var(--ops-accent, #388bfd) 20%, transparent);
}

.modelsel__item-label {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.modelsel__item-id {
  font-size: var(--ops-font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.modelsel__empty-filter {
  margin: 0;
  padding: var(--ops-space-2);
  font-size: var(--ops-font-sm);
  text-align: center;
}

.modelsel__footer {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  width: 100%;
  background: transparent;
  border: none;
  border-top: 1px solid var(--ops-border);
  color: var(--ops-muted);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--ops-font-sm);
  padding: var(--ops-space-2);
  text-align: left;
}

.modelsel__footer:hover,
.modelsel__footer:focus-visible {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
  outline: none;
}

.modelsel__footer:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.modelsel__footer .codicon {
  font-size: var(--ops-font-sm);
}
</style>
