<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { useOpsStore, type ModelOption } from '../store';

const store = useOpsStore();

const SEP = '\u0000'; // provider/model 复合 value 分隔符（model id 里不会出现）

interface OptionView extends ModelOption {
  value: string;
}

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

const current = computed(() => {
  // 优先 provider+model 精确匹配（同名 model 可能挂在不同 provider 下）
  const hit =
    options.value.find(
      (m) =>
        m.model === store.modelLabel &&
        (!store.modelProvider || m.provider === store.modelProvider)
    ) ?? options.value.find((m) => m.model === store.modelLabel);
  if (hit) {
    return hit.value;
  }
  // 有清单但 host 尚未下发选中项 ⇒ 展示第一项（纯展示，不上行 model/set）
  return options.value.length > 0 ? options.value[0].value : '';
});

function optionText(opt: OptionView): string {
  return opt.provider && opt.provider !== 'custom' ? `${opt.label} · ${opt.provider}` : opt.label;
}

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const idx = value.indexOf(SEP);
  if (idx < 0) {
    return;
  }
  store.setModel(value.slice(0, idx), value.slice(idx + 1));
}
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

  <label v-else class="modelsel" :title="t('modelSelectorAria')">
    <span class="codicon codicon-chip modelsel__icon" aria-hidden="true"></span>
    <select
      class="modelsel__select"
      :value="current"
      :aria-label="t('modelSelectorAria')"
      @change="onChange"
    >
      <option v-for="opt in options" :key="opt.value" :value="opt.value">
        {{ optionText(opt) }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.modelsel {
  display: inline-flex;
  align-items: center;
  gap: 3px;
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

.modelsel__icon {
  color: var(--ops-muted);
  font-size: var(--ops-font-sm);
}

.modelsel__select {
  appearance: none;
  background: transparent;
  color: var(--ops-fg);
  border: none;
  font-family: inherit;
  font-size: var(--ops-font-sm);
  padding: 0 2px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.modelsel__select:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.modelsel__select option {
  background: var(--ops-input-bg);
  color: var(--ops-input-fg);
}
</style>
