<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOpsStore } from '../store';

const store = useOpsStore();
const expanded = ref(false);

const ELEMENT_LABELS: Array<{ key: string; label: string }> = [
  { key: 'goal', label: '目标' },
  { key: 'evidence', label: '证据' },
  { key: 'impact', label: '影响面' },
  { key: 'prechecks', label: '前置检查' },
  { key: 'backup', label: '备份' },
  { key: 'commands', label: '命令集' },
  { key: 'successCriteria', label: '成功判据' },
  { key: 'rollback', label: '回滚方案' },
  { key: 'unknowns', label: '未知项' }
];

interface ElementRow {
  key: string;
  label: string;
  text: string;
  commands: string[] | null;
}

function commandLine(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  const rec = (entry ?? {}) as Record<string, unknown>;
  const tool = rec.tool ? String(rec.tool) : '';
  const command = rec.command ? String(rec.command) : rec.args ? JSON.stringify(rec.args) : '';
  return [tool, command].filter(Boolean).join('  ') || JSON.stringify(rec);
}

const rows = computed<ElementRow[]>(() => {
  const brief = store.pendingApproval;
  if (!brief) {
    return [];
  }
  const elements = (brief.elements ?? {}) as Record<string, unknown>;
  const known = ELEMENT_LABELS.map(({ key, label }) => {
    const value = elements[key];
    if (key === 'commands' && Array.isArray(value)) {
      return { key, label, text: '', commands: value.map(commandLine) };
    }
    const text =
      value === undefined || value === null
        ? '—'
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    return { key, label, text, commands: null };
  });
  const extras = Object.keys(elements)
    .filter((key) => !ELEMENT_LABELS.some((entry) => entry.key === key))
    .map((key) => ({
      key,
      label: key,
      text: typeof elements[key] === 'string' ? String(elements[key]) : JSON.stringify(elements[key]),
      commands: null
    }));
  return [...known, ...extras];
});

const riskLabel = computed(() =>
  store.pendingApproval?.risk === 'exec' ? '执行 exec' : '写 write'
);
</script>

<template>
  <section v-if="store.pendingApproval" class="approval" :class="'approval--' + store.pendingApproval.risk" aria-label="待审批">
    <div class="approval__row">
      <span aria-hidden="true">⚠</span>
      <span class="approval__title">待审批</span>
      <span class="ops-badge" :class="'ops-risk-' + store.pendingApproval.risk">{{ riskLabel }}</span>
      <span class="approval__target" :title="store.pendingApproval.targetLabel">{{ store.pendingApproval.targetLabel }}</span>
      <span class="approval__spacer"></span>
      <button type="button" class="ops-btn ops-btn--secondary" :aria-expanded="expanded" @click="expanded = !expanded">
        简报 {{ expanded ? '▾' : '▸' }}
      </button>
      <button type="button" class="ops-btn" @click="store.respondApproval('approved')">批准</button>
      <button type="button" class="ops-btn ops-btn--danger" @click="store.respondApproval('rejected')">拒绝</button>
    </div>

    <p class="approval__hint">批准后插件仍可能再次确认。插件弹窗不是本次批准。</p>

    <dl v-if="expanded" class="approval__brief">
      <template v-for="row in rows" :key="row.key">
        <dt class="approval__dt ops-muted">{{ row.label }}</dt>
        <dd class="approval__dd">
          <pre v-if="row.commands" class="ops-codeblock approval__commands">{{ row.commands.join('\n') }}</pre>
          <template v-else>{{ row.text }}</template>
        </dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
.approval {
  border-top: 1px solid var(--ops-border);
  border-left: 3px solid var(--ops-write);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  max-height: 45vh;
  overflow-y: auto;
}

.approval--exec {
  border-left-color: var(--ops-exec);
}

.approval__row {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 1.5);
  min-width: 0;
}

.approval__title {
  font-weight: 600;
}

.approval__target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ops-muted);
}

.approval__spacer {
  flex: 1;
}

.approval__hint {
  margin: var(--ops-density) 0 0;
  font-size: calc(var(--ops-font-size) - 2px);
  color: var(--ops-warn);
}

.approval__brief {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px calc(var(--ops-density) * 2);
  margin: var(--ops-density) 0 0;
  font-size: calc(var(--ops-font-size) - 1px);
}

.approval__dt {
  white-space: nowrap;
}

.approval__dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
}

.approval__commands {
  max-height: 120px;
}
</style>
