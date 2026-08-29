<script setup lang="ts">
import { computed, ref } from 'vue';
import { dualConfirmText, t, type OpsMessageKey } from '../i18n';
import { annotateCommandKeywords, isBlankApprovalValue } from '../lib/approval-brief';
import { useCopiedFlag } from '../lib/clipboard';
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

/** 9 要素标签（i18n，P1-13）。 */
const ELEMENT_LABELS: Array<{ key: string; labelKey: OpsMessageKey }> = [
  { key: 'goal', labelKey: 'elGoal' },
  { key: 'evidence', labelKey: 'elEvidence' },
  { key: 'impact', labelKey: 'elImpact' },
  { key: 'prechecks', labelKey: 'elPrechecks' },
  { key: 'backup', labelKey: 'elBackup' },
  { key: 'commands', labelKey: 'elCommands' },
  { key: 'successCriteria', labelKey: 'elSuccessCriteria' },
  { key: 'rollback', labelKey: 'elRollback' },
  { key: 'unknowns', labelKey: 'elUnknowns' }
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
  const known = ELEMENT_LABELS.map(({ key, labelKey }) => {
    const value = elements[key];
    const label = t(labelKey);
    if (key === 'commands' && Array.isArray(value)) {
      const commands = value.map(commandLine).filter((line) => line.trim().length > 0);
      if (commands.length === 0) {
        return null;
      }
      return { key, label, text: '', commands };
    }
    if (isBlankApprovalValue(value)) {
      return null;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { key, label, text, commands: null };
  }).filter((row): row is ElementRow => row !== null);
  const extras = Object.keys(elements)
    .filter((key) => key !== 'guidedManual')
    .filter((key) => !ELEMENT_LABELS.some((entry) => entry.key === key))
    .filter((key) => !isBlankApprovalValue(elements[key]))
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
  return t(risk === 'exec' ? 'riskExec' : risk === 'read' ? 'riskRead' : 'riskWrite');
});

const { copied, copy } = useCopiedFlag();

async function copyCommands(row: ElementRow): Promise<void> {
  if (!row.commands) {
    return;
  }
  await copy(row.commands.join('\n'));
}
</script>

<template>
  <!-- 两段式布局（P0-E §3）：第一行 = 标识（⚠ 待审批 + 风险 + 目标），
       第二行 = 动作按钮组（右对齐、可换行），侧边栏 300px 不再挤爆。 -->
  <section v-if="store.pendingApproval" class="approval" :class="'approval--' + store.pendingApproval.risk" :aria-label="t('approvalPendingTitle')">
    <div class="approval__row">
      <span class="codicon codicon-warning approval__warn" aria-hidden="true"></span>
      <span class="approval__title">{{ t('approvalPendingTitle') }}</span>
      <span class="ops-badge" :class="'ops-risk-' + store.pendingApproval.risk">{{ riskLabel }}</span>
      <span class="approval__target" :title="store.pendingApproval.targetLabel">{{ store.pendingApproval.targetLabel }}</span>
    </div>

    <div class="approval__actions">
      <button type="button" class="ops-btn ops-btn--secondary" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ t('approvalBriefToggle') }}
        <span class="codicon" :class="expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'" aria-hidden="true"></span>
      </button>
      <span class="approval__spacer"></span>
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
          <div v-if="row.commands" class="approval__commands-wrap">
            <pre class="ops-codeblock approval__commands"><template v-for="(line, i) in row.commands" :key="i"><span v-if="i > 0">{{ '\n' }}</span><span v-for="(seg, j) in annotateCommandKeywords(line)" :key="j" :class="{ approval__kw: seg.keyword }">{{ seg.text }}</span></template></pre>
            <button
              type="button"
              class="ops-copy-btn approval__copy"
              :class="{ 'ops-copy-btn--copied': copied }"
              :aria-label="copied ? t('copied') : t('copyAria')"
              :title="copied ? t('copied') : t('copy')"
              @click.stop="copyCommands(row)"
            >
              <span class="codicon" :class="copied ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
              <span v-if="copied">{{ t('copied') }}</span>
            </button>
          </div>
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
  padding: var(--ops-space-1) var(--ops-space-3);
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
  margin: var(--ops-space-1) 0 0;
  font-size: var(--ops-font-xs);
  overflow-wrap: anywhere;
}

/* 第一行：标识；min-width 0 让 target 可省略 */
.approval__row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-width: 0;
}

.approval__warn {
  color: var(--ops-warn);
  flex: 0 0 auto;
}

.approval__title {
  font-weight: 600;
  white-space: nowrap;
}

.approval__target {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ops-muted);
}

/* 第二行：动作组，右对齐可换行（GuidedManual 变体 4 钮也不溢出） */
.approval__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ops-space-1);
  margin-top: var(--ops-space-1);
  min-width: 0;
}

.approval__spacer {
  flex: 1;
}

.approval__hint {
  margin: var(--ops-space-1) 0 0;
  font-size: var(--ops-font-xs);
  color: var(--ops-warn);
}

.approval__brief {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px var(--ops-space-3);
  margin: var(--ops-space-1) 0 0;
  font-size: var(--ops-font-sm);
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

.approval__commands-wrap {
  position: relative;
}

.approval__copy {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
  opacity: 0;
  width: 22px;
  height: 22px;
}

.approval__commands-wrap:hover .approval__copy,
.approval__copy:focus-visible,
.approval__copy.ops-copy-btn--copied {
  opacity: 1;
}

.approval__copy.ops-copy-btn--copied {
  width: auto;
}

.approval__kw {
  color: var(--ops-crit);
  font-weight: 600;
}
</style>
