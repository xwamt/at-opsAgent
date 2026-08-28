<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';

const store = useOpsStore();
const emit = defineEmits<{ picked: [name: string]; close: [] }>();
const rootEl = ref<HTMLElement | null>(null);

function pick(name: string): void {
  store.runSkill(name);
  emit('picked', name);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    store.activePicker = null;
    emit('close');
  }
}

function onDocClick(event: MouseEvent): void {
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) {
    store.activePicker = null;
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick, true);
  rootEl.value?.querySelector<HTMLButtonElement>('button')?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick, true);
});
</script>

<template>
  <div ref="rootEl" class="skpick" role="listbox" :aria-label="t('pickerSkillAria')" @keydown="onKeydown">
    <header class="skpick__head ops-muted">{{ t('pickerSkillTitle') }}</header>
    <button
      v-for="skill in store.skills"
      :key="skill.name"
      type="button"
      class="skpick__item"
      role="option"
      @click="pick(skill.name)"
    >
      <span class="skpick__name ops-mono">{{ skill.name }}</span>
      <span v-if="skill.description" class="skpick__desc ops-muted">{{ skill.description }}</span>
    </button>
  </div>
</template>

<style scoped>
.skpick {
  background: var(--ops-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  padding: var(--ops-density);
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 240px;
}

.skpick__head {
  font-size: calc(var(--ops-font-size) - 2px);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
}

.skpick__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
  color: var(--ops-fg);
  cursor: pointer;
}

.skpick__item:hover,
.skpick__item:focus-visible {
  background: var(--ops-hover-bg);
  outline: none;
}

.skpick__item:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.skpick__name {
  font-weight: 600;
}

.skpick__desc {
  font-size: calc(var(--ops-font-size) - 2px);
}
</style>
