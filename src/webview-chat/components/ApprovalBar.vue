<script setup lang="ts">
import { computed, ref } from 'vue';
import { dualConfirmText, t } from '../i18n';
import { useOpsStore } from '../store';

const store = useOpsStore();
const expanded = ref(false);

/** 双确认提示（docs/05 §3.1）：仅 brief.dualConfirmHint === true 时有值。 */
const dualText = computed(() => dualConfirmText(store.pendingApproval));

/**
 * GuidedManual 变体（docs/research/06 §B.1）：写操作属只读插件域（Nacos 发布、
 * Jenkins 触发构建）时，Agent 不代执行——引导去 IDE 操作，用户完成后回报。
 * 命中条件：brief.risk 运行时为 read，或 elements.guidedManual 已给出。
 */
const guided = computed(() => {
  const brief = store.pendingApproval;
  if (!brief) {
    return null;
  }
  const gm = (brief.elements ?? {}).guidedManual;
  if (String(brief.risk) !== 'read' && gm === undefined) {
    return null;
  }
  if (typeof gm === 'string') {
    return {
      label: t('guidedManualOpen'),
      commandUri: gm.startsWith('command:') ? gm : '',
      hint: gm.startsWith('command:') ? '' : gm
    };
  }
  const rec = (gm ?? {}) as Record<string, unknown>;
  const link = String(rec.command ?? rec.href ?? rec.link ?? '');
  return {
    label: String(rec.label ?? t('guidedManualOpen')),
    commandUri: link.startsWith('command:') ? link : '',
    hint: typeof rec.hint === 'string' ? rec.hint : link.startsWith('command:') ? '' : link
  };
});

function openGuided(): void {
  if (!store.pendingApproval) {
    return;
  }
  store.post('guidedManual/open', { briefId: store.pendingApproval.id });
}

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
    .filter((key) => key !== 'guidedManual')
    .filter((key) => !ELEMENT_LABELS.some((entry) => entry.key === key))
    .map((key) => ({
      key,
      label: key,
      text: typeof elements[key] === 'string' ? String(elements[key]) : JSON.stringify(elements[key]),
      commands: null
    }));
  return [...known, ...extras];
});

const riskLabel = computed(() => {
  const risk = String(store.pendingApproval?.risk ?? '');
  if (risk === 'exec') {
    return '执行 exec';
  }
  if (risk === 'read') {
    return '只读 read';
  }
  return '写 write';
});
</script>

<template>
  <section v-if="store.pendingApproval" class="approval" :class="'approval--' + store.pendingApproval.risk" :aria-label="t('approvalPendingTitle')">
    <div class="approval__row">
      <span aria-hidden="true">⚠</span>
      <span class="approval__title">{{ t('approvalPendingTitle') }}</span>
      <span class="ops-badge" :class="'ops-risk-' + store.pendingApproval.risk">{{ riskLabel }}</span>
      <span class="approval__target" :title="store.pendingApproval.targetLabel">{{ store.pendingApproval.targetLabel }}</span>
      <span class="approval__spacer"></span>
      <button type="button" class="ops-btn ops-btn--secondary" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ t('approvalBriefToggle') }} {{ expanded ? '▾' : '▸' }}
      </button>
      <!-- GuidedManual：Agent 不代执行，引导去 IDE，完成后回报 -->
      <template v-if="guided">
        <a v-if="guided.commandUri" class="ops-btn approval__deeplink" :href="guided.commandUri">{{ guided.label }}</a>
        <button v-else type="button" class="ops-btn" @click="openGuided">{{ guided.label }}</button>
        <button type="button" class="ops-btn ops-btn--secondary" @click="store.completeGuidedManual()">
          {{ t('guidedManualDone') }}
        </button>
        <button type="button" class="ops-btn ops-btn--danger" @click="store.respondApproval('rejected')">{{ t('approvalReject') }}</button>
      </template>
      <template v-else>
        <button type="button" class="ops-btn" @click="store.respondApproval('approved')">{{ t('approvalApprove') }}</button>
        <button type="button" class="ops-btn ops-btn--danger" @click="store.respondApproval('rejected')">{{ t('approvalReject') }}</button>
      </template>
    </div>

    <p v-if="guided && guided.hint" class="approval__guided-hint ops-muted">{{ guided.hint }}</p>
    <!-- 双确认句只在 dualConfirmHint（dedupePluginModal 取反）为 true 时出现 -->
    <p v-if="dualText" class="approval__hint">{{ dualText }}</p>

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

.approval--read {
  border-left-color: var(--ops-read);
}

.approval__deeplink {
  text-decoration: none;
  line-height: 1.7;
}

.approval__guided-hint {
  margin: var(--ops-density) 0 0;
  font-size: calc(var(--ops-font-size) - 2px);
  overflow-wrap: anywhere;
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
