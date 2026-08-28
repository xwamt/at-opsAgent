<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';

const store = useOpsStore();
const emit = defineEmits<{ picked: [playbookId: string]; close: [] }>();
const rootEl = ref<HTMLElement | null>(null);

const RISK_LABEL: Record<'read' | 'write' | 'exec', string> = {
  read: '只读',
  write: '写',
  exec: '执行'
};

function pick(playbookId: string): void {
  store.startPlaybook(playbookId);
  emit('picked', playbookId);
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
  <div ref="rootEl" class="pbpick" role="listbox" :aria-label="t('pickerPlaybookAria')" @keydown="onKeydown">
    <header class="pbpick__head ops-muted">{{ t('pickerPlaybookTitle') }}</header>
    <button
      v-for="pb in store.playbooks"
      :key="pb.id"
      type="button"
      class="pbpick__item"
      role="option"
      :aria-selected="store.playbook?.id === pb.id"
      :class="{ 'pbpick__item--current': store.playbook?.id === pb.id }"
      @click="pick(pb.id)"
    >
      <span class="pbpick__title">{{ pb.title }}</span>
      <span class="pbpick__id ops-mono ops-muted">{{ pb.id }}</span>
      <span class="ops-badge" :class="'ops-risk-' + pb.maxRisk">{{ RISK_LABEL[pb.maxRisk] }}</span>
      <span v-if="pb.description" class="pbpick__desc ops-muted">{{ pb.description }}</span>
    </button>
  </div>
</template>

<style scoped>
.pbpick {
  background: var(--ops-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  padding: var(--ops-density);
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 260px;
}

.pbpick__head {
  font-size: calc(var(--ops-font-size) - 2px);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
}

.pbpick__item {
  display: grid;
  grid-template-columns: max-content 1fr max-content;
  align-items: baseline;
  gap: 2px calc(var(--ops-density) * 2);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
  color: var(--ops-fg);
  cursor: pointer;
}

.pbpick__item:hover,
.pbpick__item:focus-visible {
  background: var(--ops-hover-bg);
  outline: none;
}

.pbpick__item:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.pbpick__item--current {
  border-left: 2px solid var(--ops-accent);
}

.pbpick__title {
  font-weight: 600;
  white-space: nowrap;
}

.pbpick__id {
  font-size: calc(var(--ops-font-size) - 3px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pbpick__desc {
  grid-column: 1 / -1;
  font-size: calc(var(--ops-font-size) - 2px);
}
</style>
