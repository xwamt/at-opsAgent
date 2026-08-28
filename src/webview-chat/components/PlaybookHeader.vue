<script setup lang="ts">
import { computed } from 'vue';
import { useOpsStore } from '../store';

const store = useOpsStore();

/** pb.incident 主路径阶段（docs/04 §2.1）；GuidedManual 仅在命中时插入。 */
const CANONICAL_STAGES: Array<{ id: string; label: string }> = [
  { id: 'triage', label: '分诊' },
  { id: 'selecting', label: '选择' },
  { id: 'investigating', label: '调查' },
  { id: 'synthesizing', label: '归纳' },
  { id: 'awaitingapproval', label: '待审批' },
  { id: 'executing', label: '执行' },
  { id: 'verifying', label: '验证' },
  { id: 'reporting', label: '报告' },
  { id: 'closed', label: '关闭' }
];

const normalizedStage = computed(() =>
  (store.playbook?.stage ?? '').toLowerCase().replace(/[^a-z]/g, '')
);

const stages = computed(() => {
  const list = [...CANONICAL_STAGES];
  const current = normalizedStage.value;
  if (current && !list.some((stage) => stage.id === current)) {
    // GuidedManual 等非主干阶段：插到 Reporting 前
    list.splice(list.length - 2, 0, {
      id: current,
      label: store.playbook?.stage ?? current
    });
  }
  const currentIdx = list.findIndex((stage) => stage.id === current);
  return list.map((stage, idx) => ({
    ...stage,
    state:
      currentIdx < 0
        ? 'pending'
        : idx < currentIdx
          ? 'done'
          : idx === currentIdx
            ? 'active'
            : 'pending'
  }));
});

const stageLabel = computed(() => {
  const hit = stages.value.find((stage) => stage.state === 'active');
  return hit ? hit.label : store.playbook?.stage ?? '';
});
</script>

<template>
  <header class="pb-header">
    <template v-if="store.playbook">
      <div class="pb-header__title">
        <span class="pb-header__bar" aria-hidden="true"></span>
        <span class="pb-header__id ops-mono">{{ store.playbook.id }}</span>
        <span class="ops-muted">· {{ stageLabel }}</span>
      </div>
      <ol class="pb-header__chips" aria-label="Playbook 阶段">
        <li
          v-for="stage in stages"
          :key="stage.id"
          class="pb-header__chip"
          :class="'pb-header__chip--' + stage.state"
          :aria-current="stage.state === 'active' ? 'step' : undefined"
        >
          <span class="pb-header__chip-mark" aria-hidden="true">
            {{ stage.state === 'done' ? '✓' : stage.state === 'active' ? '●' : '○' }}
          </span>
          {{ stage.label }}
        </li>
      </ol>
    </template>
    <div v-else class="pb-header__empty ops-muted">未启动 Playbook · 直接提问或粘贴告警</div>
  </header>
</template>

<style scoped>
.pb-header {
  border-bottom: 1px solid var(--ops-border);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
}

.pb-header__title {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 1.5);
  min-width: 0;
}

.pb-header__bar {
  width: 3px;
  align-self: stretch;
  background: var(--ops-accent);
  border-radius: 1px;
}

.pb-header__id {
  font-weight: 600;
}

.pb-header__chips {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-density);
  margin: var(--ops-density) 0 0;
  padding: 0;
}

.pb-header__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: 0 calc(var(--ops-density) + 2px);
  font-size: calc(var(--ops-font-size) - 2px);
  line-height: 1.6;
  color: var(--ops-muted);
}

.pb-header__chip--done {
  color: var(--ops-healthy);
  border-color: var(--ops-healthy);
}

.pb-header__chip--active {
  color: var(--ops-fg);
  border-color: var(--ops-accent);
  background: var(--ops-hover-bg);
}

.pb-header__empty {
  font-size: calc(var(--ops-font-size) - 1px);
}
</style>
