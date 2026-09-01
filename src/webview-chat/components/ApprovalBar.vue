<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { dualConfirmText, t, tf, type OpsMessageKey } from '../i18n';
import {
  annotateCommandKeywords,
  countBlankApprovalElements,
  formatApprovalCommandLine,
  isBlankApprovalValue,
  isBriefLong
} from '../lib/approval-brief';
import { COPIED_FEEDBACK_MS, copyText } from '../lib/clipboard';
import { useOpsStore } from '../store';

const store = useOpsStore();
const expanded = ref(false);
const commandsExpandedRows = ref<Record<string, boolean>>({});
const copiedLineKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

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
  return formatApprovalCommandLine(entry);
}

const showBriefEditorLink = computed(
  () => expanded.value && isBriefLong(store.pendingApproval?.elements as Record<string, unknown> | undefined)
);

const briefOpenUri = computed(() => {
  const brief = store.pendingApproval;
  if (!brief || !showBriefEditorLink.value) {
    return '';
  }
  return (
    'command:atOpsAgent.openBrief?' + encodeURIComponent(JSON.stringify([brief.id]))
  );
});

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

const blankCount = computed(() =>
  countBlankApprovalElements(store.pendingApproval?.elements as Record<string, unknown> | undefined)
);

const riskLabel = computed(() => {
  const risk = String(store.pendingApproval?.risk ?? '');
  return t(risk === 'exec' ? 'riskExec' : risk === 'read' ? 'riskRead' : 'riskWrite');
});

const COMMAND_PREVIEW_LINES = 3;

function visibleCommandLines(row: ElementRow): string[] {
  if (!row.commands) {
    return [];
  }
  if (commandsExpandedRows.value[row.key] || row.commands.length <= COMMAND_PREVIEW_LINES) {
    return row.commands;
  }
  return row.commands.slice(0, COMMAND_PREVIEW_LINES);
}

function hiddenCommandCount(row: ElementRow): number {
  if (!row.commands || commandsExpandedRows.value[row.key]) {
    return 0;
  }
  return Math.max(0, row.commands.length - COMMAND_PREVIEW_LINES);
}

function toggleCommandsExpanded(rowKey: string): void {
  commandsExpandedRows.value = {
    ...commandsExpandedRows.value,
    [rowKey]: !commandsExpandedRows.value[rowKey]
  };
}

function lineCopyKey(rowKey: string, index: number): string {
  return `${rowKey}:${index}`;
}

function isLineCopied(rowKey: string, index: number): boolean {
  return copiedLineKey.value === lineCopyKey(rowKey, index);
}

async function copyCommandLine(rowKey: string, index: number, text: string): Promise<void> {
  await copyText(text);
  copiedLineKey.value = lineCopyKey(rowKey, index);
  if (copiedTimer !== undefined) {
    clearTimeout(copiedTimer);
  }
  copiedTimer = setTimeout(() => {
    copiedLineKey.value = null;
    copiedTimer = undefined;
  }, COPIED_FEEDBACK_MS);
}

function onEscReject(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !store.pendingApproval) {
    return;
  }
  event.preventDefault();
  store.respondApproval('rejected');
}

watch(
  () => store.pendingApproval,
  (pending) => {
    expanded.value = false;
    commandsExpandedRows.value = {};
    if (pending) {
      globalThis.addEventListener?.('keydown', onEscReject);
    } else {
      globalThis.removeEventListener?.('keydown', onEscReject);
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('keydown', onEscReject);
  if (copiedTimer !== undefined) {
    clearTimeout(copiedTimer);
  }
});
</script>

<template>
  <!-- 紧凑布局（OPT-3）：第一行 = 标识 + 动作；简报默认折叠，展开限高 min(30vh, 240px)。 -->
  <section v-if="store.pendingApproval" class="approval" :class="'approval--' + store.pendingApproval.risk" :aria-label="t('approvalPendingTitle')">
    <div class="approval__row">
      <span class="codicon codicon-warning approval__warn" aria-hidden="true"></span>
      <span class="approval__title">{{ t('approvalPendingTitle') }}</span>
      <span class="ops-badge" :class="'ops-risk-' + store.pendingApproval.risk">{{ riskLabel }}</span>
      <span class="approval__target" :title="store.pendingApproval.targetLabel">{{ store.pendingApproval.targetLabel }}</span>
      <span class="approval__spacer"></span>
      <button type="button" class="ops-btn ops-btn--secondary approval__toggle" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ t('approvalBriefToggle') }}
        <span class="codicon" :class="expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'" aria-hidden="true"></span>
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

    <p v-if="!expanded && blankCount > 0" class="approval__blank-summary ops-muted">
      {{ tf('approvalBlankSummary', { count: blankCount }) }}
    </p>

    <p v-if="guided && guided.hint" class="approval__guided-hint ops-muted">{{ guided.hint }}</p>
    <!-- 双确认句只在 dualConfirmHint（dedupePluginModal 取反）为 true 时出现 -->
    <p v-if="dualText" class="approval__hint">{{ dualText }}</p>

    <dl v-if="expanded" class="approval__brief">
      <a
        v-if="briefOpenUri"
        class="approval__brief-open ops-muted"
        :href="briefOpenUri"
      >{{ t('approvalBriefOpenEditor') }}</a>
      <template v-for="row in rows" :key="row.key">
        <dt class="approval__dt ops-muted">{{ row.label }}</dt>
        <dd class="approval__dd">
          <div v-if="row.commands" class="approval__commands">
            <div
              v-for="(line, i) in visibleCommandLines(row)"
              :key="i"
              class="approval__command-line"
            >
              <pre class="ops-codeblock approval__command-pre"><span v-for="(seg, j) in annotateCommandKeywords(line)" :key="j" :class="{ approval__kw: seg.keyword }">{{ seg.text }}</span></pre>
              <button
                type="button"
                class="ops-copy-btn approval__copy"
                :class="{ 'ops-copy-btn--copied': isLineCopied(row.key, i) }"
                :aria-label="isLineCopied(row.key, i) ? t('copied') : t('copyAria')"
                :title="isLineCopied(row.key, i) ? t('copied') : t('copy')"
                @click.stop="copyCommandLine(row.key, i, line)"
              >
                <span class="codicon" :class="isLineCopied(row.key, i) ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
                <span v-if="isLineCopied(row.key, i)">{{ t('copied') }}</span>
              </button>
            </div>
            <button
              v-if="hiddenCommandCount(row) > 0"
              type="button"
              class="approval__commands-toggle ops-muted"
              @click="toggleCommandsExpanded(row.key)"
            >
              {{ tf('approvalCommandsShowAll', { count: hiddenCommandCount(row) }) }}
            </button>
            <button
              v-else-if="row.commands.length > COMMAND_PREVIEW_LINES && commandsExpandedRows[row.key]"
              type="button"
              class="approval__commands-toggle ops-muted"
              @click="toggleCommandsExpanded(row.key)"
            >
              {{ t('approvalCommandsShowLess') }}
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

/* 第一行：标识 + 动作；min-width 0 让 target 可省略 */
.approval__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ops-space-1);
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
  flex: 1 1 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ops-muted);
}

.approval__spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.approval__toggle {
  flex-shrink: 0;
}

.approval__blank-summary {
  margin: var(--ops-space-1) 0 0;
  font-size: var(--ops-font-xs);
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
  max-height: min(30vh, 240px);
  overflow-y: auto;
}

.approval__brief-open {
  grid-column: 1 / -1;
  font-size: var(--ops-font-xs);
  text-decoration: underline;
  margin-bottom: var(--ops-space-1);
}

.approval__brief-open:hover {
  color: var(--ops-fg);
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
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-1);
}

.approval__command-line {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--ops-space-1);
}

.approval__command-pre {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.approval__commands-toggle {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font-size: var(--ops-font-xs);
  cursor: pointer;
  text-decoration: underline;
  color: var(--ops-muted);
}

.approval__commands-toggle:hover {
  color: var(--ops-fg);
}

.approval__copy {
  flex: 0 0 auto;
  opacity: 0;
  width: 22px;
  height: 22px;
}

.approval__command-line:hover .approval__copy,
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
