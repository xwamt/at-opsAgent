<script setup lang="ts">
import { computed } from 'vue';
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
      provider: 'custom',
      model: store.modelLabel,
      label: store.modelLabel,
      value: 'custom' + SEP + store.modelLabel
    });
  }
  return list;
});

const current = computed(() => {
  const hit = options.value.find((m) => m.model === store.modelLabel);
  return hit ? hit.value : '';
});

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
  <label class="modelsel" title="切换模型（model/set）">
    <span class="modelsel__icon" aria-hidden="true">⬡</span>
    <select
      class="modelsel__select"
      :value="current"
      aria-label="选择模型"
      @change="onChange"
    >
      <option v-if="!current" value="" disabled>模型未设置</option>
      <option v-for="opt in options" :key="opt.value" :value="opt.value">
        {{ opt.label }}<template v-if="opt.provider !== 'custom'"> · {{ opt.provider }}</template>
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

.modelsel__icon {
  color: var(--ops-muted);
  font-size: calc(var(--ops-font-size) - 2px);
}

.modelsel__select {
  appearance: none;
  background: transparent;
  color: var(--ops-fg);
  border: none;
  font-family: inherit;
  font-size: calc(var(--ops-font-size) - 2px);
  padding: 0 2px;
  max-width: 160px;
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
