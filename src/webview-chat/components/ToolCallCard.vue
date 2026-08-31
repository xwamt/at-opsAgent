<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ToolCallView } from '../../protocol/host-protocol';
import { t } from '../i18n';
import { useCopiedFlag } from '../lib/clipboard';
import {
  formatDataOutputPreview,
  isCommandToolCall,
  isSubagentToolCall,
  parseToolOutputPreview,
  toolCallHeadline
} from '../store-helpers';
import TerminalViewer from './TerminalViewer.vue';

const props = defineProps<{ call: ToolCallView }>();

const PREVIEW_CAP = 4096; // preview 上限 4KB，超出一律截断

const isRunning = computed(() => props.call.status === 'running');

const isCommand = computed(() => isCommandToolCall(props.call));
const isSubagent = computed(() => isSubagentToolCall(props.call));

/** 默认折叠，但命令类工具在运行中且为写/执行操作时可自动展开 */
const expanded = ref(isRunning.value && (props.call.risk === 'write' || props.call.risk === 'exec'));

// 实时动态耗时（运行中递增计时）
const elapsedMs = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

function startTimer() {
  stopTimer();
  const start = Date.now();
  elapsedMs.value = 0;
  timer = setInterval(() => {
    elapsedMs.value = Date.now() - start;
  }, 100);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => isRunning.value,
  (running) => {
    if (running) {
      startTimer();
    } else {
      stopTimer();
    }
  },
  { immediate: true }
);

onMounted(() => {
  if (isRunning.value) {
    startTimer();
  }
});

onBeforeUnmount(() => {
  stopTimer();
});

const riskLabel = computed(() => {
  const key = props.call.risk === 'write' ? 'riskWrite' : props.call.risk === 'exec' ? 'riskExec' : 'riskRead';
  return t(key);
});

const STATUS_META: Record<
  ToolCallView['status'],
  { icon: string; key: 'statusToolRunning' | 'statusToolOk' | 'statusToolError' | 'statusToolCancelled' | 'statusToolInterrupted'; cls: string }
> = {
  running: { icon: 'codicon-loading codicon-modifier-spin', key: 'statusToolRunning', cls: 'tool__status--running' },
  ok: { icon: 'codicon-check', key: 'statusToolOk', cls: 'tool__status--ok' },
  error: { icon: 'codicon-error', key: 'statusToolError', cls: 'tool__status--error' },
  cancelled: { icon: 'codicon-circle-slash', key: 'statusToolCancelled', cls: 'tool__status--muted' },
  interrupted: { icon: 'codicon-debug-pause', key: 'statusToolInterrupted', cls: 'tool__status--muted' }
};

const status = computed(() => STATUS_META[props.call.status] ?? STATUS_META.running);

/** 标题显示命令意图（docs/14 P1-ui：磁盘/内存/…），原始工具名进 title 提示。 */
const headline = computed(() => {
  if (isSubagent.value) {
    return t('toolSubagentDispatch');
  }
  return toolCallHeadline(props.call);
});

const toolIcon = computed(() => {
  if (isSubagent.value) {
    return 'codicon-organization';
  }
  if (isCommand.value) {
    return 'codicon-terminal';
  }
  if (props.call.name.includes('skill') || props.call.name.includes('playbook')) {
    return 'codicon-book';
  }
  return 'codicon-tools';
});

const { copied, copy } = useCopiedFlag();
const { copied: copiedCmd, copy: copyCmd } = useCopiedFlag();
const { copied: copiedData, copy: copyData } = useCopiedFlag();

/** 复制 headline/命令。 */
async function copyHeadline(): Promise<void> {
  await copy(headline.value);
}

const parsed = computed(() => parseToolOutputPreview(props.call.preview));

const commandText = computed(() => parsed.value.command || '');

async function copyCommand(): Promise<void> {
  if (commandText.value) {
    await copyCmd(commandText.value);
  }
}

const duration = computed(() => {
  if (isRunning.value) {
    const sec = (elapsedMs.value / 1000).toFixed(1);
    return `${sec}s`;
  }
  const ms = props.call.durationMs;
  if (ms === undefined || ms === null) {
    return '';
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
});

const displayOutput = computed(() => {
  const content = parsed.value.stdout ?? (parsed.value.rawText !== parsed.value.command ? parsed.value.rawText : '');
  return content.slice(0, PREVIEW_CAP);
});

const formattedDataOutput = computed(() => {
  return formatDataOutputPreview(displayOutput.value);
});

async function copyDataContent(): Promise<void> {
  await copyData(displayOutput.value);
}

const clipped = computed(
  () => Boolean(props.call.truncated) || (parsed.value.stdout ?? parsed.value.rawText ?? '').length > PREVIEW_CAP
);

const hasBody = computed(
  () =>
    Boolean(commandText.value) ||
    Boolean(displayOutput.value) ||
    Boolean(props.call.artifactUri) ||
    props.call.status === 'error' ||
    isRunning.value
);

const artifactHref = computed(() =>
  props.call.artifactUri
    ? 'command:atOpsAgent.openArtifact?' +
      encodeURIComponent(JSON.stringify([props.call.artifactUri]))
    : ''
);
</script>

<template>
  <section
    class="tool"
    :class="[
      'tool--' + props.call.risk,
      {
        'tool--running': isRunning,
        'tool--command': isCommand,
        'tool--subagent': isSubagent
      }
    ]"
  >
    <!-- 头行是 div：复制钮必须是真 button，不能嵌在展开 button 里 -->
    <div
      class="tool__head"
      :class="{ 'tool__head--static': !hasBody }"
      role="button"
      :tabindex="hasBody ? 0 : -1"
      :aria-expanded="hasBody ? expanded : undefined"
      :aria-label="t('toolToggleAria')"
      @click="hasBody && (expanded = !expanded)"
      @keydown.enter.prevent="hasBody && (expanded = !expanded)"
      @keydown.space.prevent="hasBody && (expanded = !expanded)"
    >
      <span
        class="codicon tool__chevron"
        :class="expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"
        aria-hidden="true"
      ></span>
      <span class="codicon tool__icon" :class="toolIcon" aria-hidden="true"></span>
      <span class="tool__name ops-mono" :title="props.call.name">{{ headline }}</span>
      <span v-if="props.call.pluginId" class="tool__plugin ops-muted ops-mono">{{ props.call.pluginId }}</span>
      <span class="ops-badge" :class="'ops-risk-' + props.call.risk">{{ riskLabel }}</span>
      <button
        type="button"
        class="ops-copy-btn tool__copy"
        :class="{ 'ops-copy-btn--copied': copied }"
        :aria-label="copied ? t('copied') : t('copyAria')"
        :title="copied ? t('copied') : t('copy')"
        @click.stop="copyHeadline"
      >
        <span class="codicon" :class="copied ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
        <span v-if="copied">{{ t('copied') }}</span>
      </button>
      <span class="tool__spacer"></span>
      <span class="tool__status" :class="status.cls">
        <span class="codicon" :class="status.icon" aria-hidden="true"></span>{{ t(status.key) }}
      </span>
      <span v-if="duration" class="ops-muted ops-mono tool__duration">{{ duration }}</span>
    </div>

    <template v-if="expanded">
      <!-- ── A. 终端命令执行（Kilo / Cursor 风格）：仅对 Command 类工具生效 ── -->
      <template v-if="isCommand">
        <!-- 1. 独立命令卡：提取的完整命令 + 提示符 + 独立复制按钮 -->
        <div v-if="commandText" class="tool__cmd-bar">
          <div class="tool__cmd-content">
            <span class="tool__cmd-prompt ops-mono">$</span>
            <span class="tool__cmd-text ops-mono" :title="commandText">{{ commandText }}</span>
            <button
              type="button"
              class="ops-copy-btn tool__cmd-copy"
              :class="{ 'ops-copy-btn--copied': copiedCmd }"
              :aria-label="copiedCmd ? t('copied') : t('copyAria')"
              :title="copiedCmd ? t('copied') : t('copy')"
              @click.stop="copyCommand"
            >
              <span class="codicon" :class="copiedCmd ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
              <span v-if="copiedCmd">{{ t('copied') }}</span>
            </button>
          </div>
        </div>

        <!-- 2. 独立终端视窗：实时渲染标准输出/错误、退出码、ANSI 颜色与光标 -->
        <TerminalViewer
          class="tool__term-viewer"
          :text="displayOutput"
          :is-running="isRunning"
          :exit-code="parsed.exitCode"
          :uri="props.call.artifactUri"
          :truncated="clipped"
        />
      </template>

      <!-- ── B. 子代理派发（Subagent Dispatch）：展示任务目标与状态，绝无空终端 ── -->
      <template v-else-if="isSubagent">
        <div class="tool__subagent-panel">
          <div class="tool__subagent-row ops-muted">
            <span class="codicon codicon-hubot" aria-hidden="true"></span>
            <span>{{ isRunning ? t('saRunning') : t('toolSubagentDispatched') }}</span>
            <span v-if="props.call.pluginId" class="ops-mono">({{ props.call.pluginId }})</span>
          </div>
          <div v-if="displayOutput" class="tool__subagent-desc ops-mono">
            {{ displayOutput }}
          </div>
        </div>
      </template>

      <!-- ── C. 普通数据/只读发现工具（如 ops_list_playbooks, ops_read_skill）：标准数据预览 ── -->
      <template v-else>
        <div class="tool__data-panel">
          <div class="tool__data-header">
            <span class="tool__data-title ops-muted">{{ t('toolDataPreview') }}</span>
            <button
              v-if="displayOutput"
              type="button"
              class="ops-copy-btn tool__data-copy"
              :class="{ 'ops-copy-btn--copied': copiedData }"
              :aria-label="copiedData ? t('copied') : t('copyAria')"
              :title="copiedData ? t('copied') : t('copy')"
              @click.stop="copyDataContent"
            >
              <span class="codicon" :class="copiedData ? 'codicon-check' : 'codicon-copy'" aria-hidden="true"></span>
              <span v-if="copiedData">{{ t('copied') }}</span>
            </button>
          </div>
          <pre v-if="displayOutput" class="ops-codeblock tool__data-code ops-mono">{{ formattedDataOutput }}</pre>
          <div v-else-if="isRunning" class="tool__data-running ops-muted">
            <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
            <span>{{ t('toolRunningTimer') }}</span>
          </div>
          <div v-if="artifactHref" class="tool__truncated">
            <a class="tool__artifact" :href="artifactHref">{{ t('toolOpenArtifact') }}</a>
          </div>
        </div>
      </template>

      <!-- 3. 错误警示面板（若出错） -->
      <div v-if="props.call.status === 'error'" class="tool__error">
        <div class="tool__error-head">
          <span class="codicon codicon-error" aria-hidden="true"></span>
          <span v-if="props.call.errorCode" class="ops-mono font-bold">{{ props.call.errorCode }}</span>
        </div>
        <span v-if="props.call.errorMessage" class="tool__error-msg ops-mono">{{ props.call.errorMessage }}</span>
        <span v-if="!props.call.errorCode && !props.call.errorMessage">{{ t('toolFailed') }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.tool {
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ops-border);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
  transition: all 180ms ease;
}

.tool--running {
  background: color-mix(in srgb, var(--ops-bg) 94%, var(--ops-accent) 6%);
  border-color: color-mix(in srgb, var(--ops-border) 70%, var(--ops-accent) 30%);
}

.tool--read {
  border-left-color: var(--ops-read);
}

.tool--write {
  border-left-color: var(--ops-write);
}

.tool--exec {
  border-left-color: var(--ops-exec);
}

/* 摘要头本身是按钮：整行可点展开/收起 */
.tool__head {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-width: 0;
  width: 100%;
  font-size: var(--ops-font-sm);
  background: transparent;
  border: none;
  padding: 2px 0;
  color: var(--ops-fg);
  cursor: pointer;
  text-align: left;
}

.tool__head--static {
  cursor: default;
}

.tool__head:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.tool__copy {
  opacity: 0;
  width: 22px;
  height: 22px;
}

.tool__head:hover .tool__copy,
.tool__copy:focus-visible,
.tool__copy.ops-copy-btn--copied {
  opacity: 1;
}

.tool__copy.ops-copy-btn--copied {
  width: auto;
}

.tool__chevron,
.tool__icon {
  flex: 0 0 auto;
  color: var(--ops-muted);
}

.tool__head--static .tool__chevron {
  visibility: hidden;
}

.tool__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool__plugin {
  font-size: var(--ops-font-xs);
}

.tool__spacer {
  flex: 1;
}

.tool__status {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  white-space: nowrap;
}

.tool__status--running {
  color: var(--ops-accent);
}

.tool__status--ok {
  color: var(--ops-healthy);
}

.tool__status--error {
  color: var(--ops-crit);
}

.tool__status--muted {
  color: var(--ops-pending);
}

.tool__duration {
  font-size: var(--ops-font-xs);
}

/* ── A. 终端命令独立卡 ── */
.tool__cmd-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-space-2);
  margin-top: var(--ops-space-1);
  margin-bottom: var(--ops-space-1);
  padding: 5px var(--ops-space-2);
  background: color-mix(in srgb, var(--ops-bg) 65%, black 35%);
  border: 1px solid color-mix(in srgb, var(--ops-border) 75%, black 25%);
  border-radius: var(--ops-radius-ctl);
  font-size: var(--ops-font-xs);
}

.tool__cmd-content {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  flex: 1 1 auto;
  min-width: 0;
}

.tool__cmd-prompt {
  color: var(--ops-accent);
  font-weight: 700;
  user-select: none;
}

.tool__cmd-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ops-fg);
}

.tool__cmd-copy {
  opacity: 0.7;
}

.tool__cmd-copy:hover {
  opacity: 1;
}

.tool__term-viewer {
  margin-top: var(--ops-space-1);
}

/* ── B. 子代理面板 ── */
.tool__subagent-panel {
  margin-top: var(--ops-space-1);
  padding: var(--ops-space-2);
  background: color-mix(in srgb, var(--ops-bg) 80%, var(--ops-accent) 20%);
  border: 1px dashed color-mix(in srgb, var(--ops-border) 60%, var(--ops-accent) 40%);
  border-radius: var(--ops-radius-ctl);
  font-size: var(--ops-font-xs);
}

.tool__subagent-row {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
}

.tool__subagent-desc {
  margin-top: 4px;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── C. 普通数据预览面板 ── */
.tool__data-panel {
  margin-top: var(--ops-space-1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool__data-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--ops-font-xs);
  padding: 0 2px;
}

.tool__data-copy {
  opacity: 0.8;
}

.tool__data-code {
  max-height: 200px;
  overflow-x: auto;
  overflow-y: auto;
  background: var(--ops-code-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
  padding: var(--ops-space-2);
  font-size: var(--ops-font-xs);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}

.tool__data-running {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  padding: var(--ops-space-2);
  font-size: var(--ops-font-xs);
}

.tool__truncated {
  margin-top: 2px;
  font-size: var(--ops-font-xs);
}

.tool__artifact {
  color: var(--ops-accent);
  text-decoration: none;
}

.tool__artifact:hover {
  text-decoration: underline;
}

/* ── 3. 错误警示面板 ── */
.tool__error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--ops-space-1);
  padding: var(--ops-space-2);
  background: color-mix(in srgb, var(--ops-bg) 85%, var(--ops-crit) 15%);
  border-radius: var(--ops-radius-ctl);
  border: 1px solid color-mix(in srgb, var(--ops-crit) 30%, transparent);
  color: var(--ops-crit);
  font-size: var(--ops-font-xs);
}

.tool__error-head {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
}

.tool__error-msg {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
