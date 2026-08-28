<script setup lang="ts">
import { computed, ref } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';

const store = useOpsStore();

/** 阶段行默认收起（Cline 式安静头部）：点身份 chip 展开 9 阶段。 */
const stagesOpen = ref(false);

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
    <div class="pb-header__row">
      <!-- Playbook 身份 = 一个 chip（id · 阶段）；点它展开/收起阶段行 -->
      <button
        v-if="store.playbook"
        type="button"
        class="pb-header__identity"
        :aria-expanded="stagesOpen"
        :aria-label="t('headerStagesToggle')"
        :title="t('headerStagesToggle')"
        @click="stagesOpen = !stagesOpen"
      >
        <span class="pb-header__id ops-mono">{{ store.playbook.id }}</span>
        <span class="pb-header__stage">· {{ stageLabel }}</span>
        <span aria-hidden="true">{{ stagesOpen ? '▾' : '▸' }}</span>
      </button>
      <span v-else class="pb-header__idle ops-muted">{{ t('headerIdle') }}</span>
      <span class="pb-header__spacer"></span>
      <button
        type="button"
        class="ops-btn ops-btn--secondary pb-header__btn"
        :aria-expanded="store.historyOpen"
        :aria-label="t('historyTitle')"
        @click="store.toggleHistory()"
      >
        ↺ {{ t('historyButton') }}
      </button>
      <button
        type="button"
        class="ops-btn ops-btn--secondary pb-header__btn"
        :aria-expanded="store.activePicker === 'playbook'"
        aria-label="选择 Playbook"
        @click="store.togglePicker('playbook')"
      >
        ▤ Playbook
      </button>
    </div>
    <ol v-if="store.playbook && stagesOpen" class="pb-header__chips" aria-label="Playbook 阶段">
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
  </header>
</template>

<style scoped>
.pb-header {
  border-bottom: 1px solid var(--ops-border);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
}

.pb-header__row {
  display: flex;
  align-items: center;
  gap: var(--ops-density);
  min-width: 0;
}

.pb-header__identity {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--ops-density) - 2px);
  background: transparent;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: 1px calc(var(--ops-density) + 2px);
  color: var(--ops-fg);
  cursor: pointer;
  font-size: calc(var(--ops-font-size) - 1px);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.pb-header__identity:hover {
  background: var(--ops-hover-bg);
}

.pb-header__identity:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.pb-header__id {
  font-weight: 600;
}

.pb-header__stage {
  color: var(--ops-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}

.pb-header__idle {
  font-size: calc(var(--ops-font-size) - 1px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pb-header__spacer {
  flex: 1;
}

.pb-header__btn {
  padding: 1px calc(var(--ops-density) + 2px);
  font-size: calc(var(--ops-font-size) - 2px);
  line-height: 1.7;
  white-space: nowrap;
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
</style>
