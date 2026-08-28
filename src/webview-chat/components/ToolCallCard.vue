<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolCallView } from '../../protocol/host-protocol';
import { t } from '../i18n';
import LogViewer from './LogViewer.vue';

const props = defineProps<{ call: ToolCallView }>();

const PREVIEW_CAP = 4096; // preview 上限 4KB，超出一律截断

/** 默认折叠（P1-2）：单行摘要头，点击展开 preview / 错误详情。 */
const expanded = ref(false);

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

const duration = computed(() => {
  const ms = props.call.durationMs;
  if (ms === undefined || ms === null) {
    return '';
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
});

const preview = computed(() => (props.call.preview ?? '').slice(0, PREVIEW_CAP));
const clipped = computed(
  () => Boolean(props.call.truncated) || (props.call.preview ?? '').length > PREVIEW_CAP
);

const hasBody = computed(
  () =>
    Boolean(preview.value) ||
    Boolean(props.call.artifactUri) ||
    props.call.status === 'error'
);

const artifactHref = computed(() =>
  props.call.artifactUri
    ? 'command:atOpsAgent.openArtifact?' +
      encodeURIComponent(JSON.stringify([props.call.artifactUri]))
    : ''
);
</script>

<template>
  <section class="tool" :class="'tool--' + props.call.risk">
    <button
      type="button"
      class="tool__head"
      :aria-expanded="expanded"
      :aria-label="t('toolToggleAria')"
      :disabled="!hasBody"
      @click="expanded = !expanded"
    >
      <span
        class="codicon tool__chevron"
        :class="expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"
        aria-hidden="true"
      ></span>
      <span class="codicon codicon-tools tool__icon" aria-hidden="true"></span>
      <span class="tool__name ops-mono">{{ props.call.name }}</span>
      <span v-if="props.call.pluginId" class="tool__plugin ops-muted ops-mono">{{ props.call.pluginId }}</span>
      <span class="ops-badge" :class="'ops-risk-' + props.call.risk">{{ riskLabel }}</span>
      <span class="tool__spacer"></span>
      <span class="tool__status" :class="status.cls">
        <span class="codicon" :class="status.icon" aria-hidden="true"></span>{{ t(status.key) }}
      </span>
      <span v-if="duration" class="ops-muted ops-mono">{{ duration }}</span>
    </button>

    <template v-if="expanded">
      <!-- 截断结果统一走 LogViewer（自带「已截断 · 在编辑器打开」） -->
      <LogViewer
        v-if="clipped"
        class="tool__logv"
        :text="props.call.preview"
        :uri="props.call.artifactUri"
        :truncated="true"
      />
      <template v-else>
        <pre v-if="preview" class="ops-codeblock tool__preview">{{ preview }}</pre>
        <div v-if="artifactHref" class="tool__truncated">
          <a class="tool__artifact" :href="artifactHref">{{ t('toolOpenArtifact') }}</a>
        </div>
      </template>

      <div v-if="props.call.status === 'error'" class="tool__error">
        <span v-if="props.call.errorCode" class="ops-mono">{{ props.call.errorCode }}</span>
        <span v-if="props.call.errorMessage">{{ props.call.errorMessage }}</span>
        <span v-if="!props.call.errorCode && !props.call.errorMessage">{{ t('toolFailed') }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.tool {
  border: 1px solid var(--ops-border);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
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

.tool__head:disabled {
  cursor: default;
}

.tool__head:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.tool__chevron,
.tool__icon {
  flex: 0 0 auto;
  color: var(--ops-muted);
}

.tool__head:disabled .tool__chevron {
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

.tool__preview {
  margin-top: var(--ops-space-1);
  max-height: 180px;
}

.tool__logv {
  margin-top: var(--ops-space-1);
}

.tool__truncated {
  margin-top: var(--ops-space-1);
  font-size: var(--ops-font-xs);
  display: flex;
  gap: var(--ops-space-3);
}

.tool__artifact {
  color: var(--vscode-textLink-foreground, var(--ops-accent));
  text-decoration: none;
}

.tool__artifact:hover {
  text-decoration: underline;
}

.tool__error {
  margin-top: var(--ops-space-1);
  color: var(--ops-crit);
  font-size: var(--ops-font-sm);
  display: flex;
  gap: var(--ops-space-3);
  flex-wrap: wrap;
}
</style>
