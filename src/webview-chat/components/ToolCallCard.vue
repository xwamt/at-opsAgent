<script setup lang="ts">
import { computed } from 'vue';
import type { ToolCallView } from '../../protocol/host-protocol';

const props = defineProps<{ call: ToolCallView }>();

const PREVIEW_CAP = 4096; // preview 上限 4KB，超出一律截断

const RISK_LABEL: Record<ToolCallView['risk'], string> = {
  read: '只读',
  write: '写',
  exec: '执行'
};

const STATUS_META: Record<ToolCallView['status'], { icon: string; label: string; cls: string }> = {
  running: { icon: '●', label: '运行中', cls: 'tool__status--running' },
  ok: { icon: '✓', label: '成功', cls: 'tool__status--ok' },
  error: { icon: '✗', label: '失败', cls: 'tool__status--error' },
  cancelled: { icon: '⊘', label: '已取消', cls: 'tool__status--muted' },
  interrupted: { icon: '⏸', label: '被打断', cls: 'tool__status--muted' }
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

const artifactHref = computed(() =>
  props.call.artifactUri
    ? 'command:atOpsAgent.openArtifact?' +
      encodeURIComponent(JSON.stringify([props.call.artifactUri]))
    : ''
);
</script>

<template>
  <section class="tool" :class="'tool--' + props.call.risk">
    <header class="tool__head">
      <span aria-hidden="true">🔧</span>
      <span class="tool__name ops-mono">{{ props.call.name }}</span>
      <span v-if="props.call.pluginId" class="tool__plugin ops-muted ops-mono">{{ props.call.pluginId }}</span>
      <span class="ops-badge" :class="'ops-risk-' + props.call.risk">{{ RISK_LABEL[props.call.risk] }}</span>
      <span class="tool__spacer"></span>
      <span class="tool__status" :class="status.cls">
        <span aria-hidden="true">{{ status.icon }}</span>{{ status.label }}
      </span>
      <span v-if="duration" class="ops-muted ops-mono">{{ duration }}</span>
    </header>

    <pre v-if="preview" class="ops-codeblock tool__preview">{{ preview }}</pre>

    <div v-if="clipped" class="tool__truncated">
      <span class="ops-muted">已截断</span>
      <a v-if="artifactHref" class="tool__artifact" :href="artifactHref">在编辑器打开</a>
    </div>
    <div v-else-if="artifactHref" class="tool__truncated">
      <a class="tool__artifact" :href="artifactHref">在编辑器打开完整结果</a>
    </div>

    <div v-if="props.call.status === 'error'" class="tool__error">
      <span v-if="props.call.errorCode" class="ops-mono">{{ props.call.errorCode }}</span>
      <span v-if="props.call.errorMessage">{{ props.call.errorMessage }}</span>
      <span v-if="!props.call.errorCode && !props.call.errorMessage">工具调用失败</span>
    </div>
  </section>
</template>

<style scoped>
.tool {
  border: 1px solid var(--ops-border);
  border-left-width: 3px;
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
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

.tool__head {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 1.5);
  min-width: 0;
  font-size: calc(var(--ops-font-size) - 1px);
}

.tool__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool__plugin {
  font-size: calc(var(--ops-font-size) - 2px);
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
  margin-top: var(--ops-density);
  max-height: 180px;
}

.tool__truncated {
  margin-top: var(--ops-density);
  font-size: calc(var(--ops-font-size) - 2px);
  display: flex;
  gap: calc(var(--ops-density) * 2);
}

.tool__artifact {
  color: var(--vscode-textLink-foreground, var(--ops-accent));
  text-decoration: none;
}

.tool__artifact:hover {
  text-decoration: underline;
}

.tool__error {
  margin-top: var(--ops-density);
  color: var(--ops-crit);
  font-size: calc(var(--ops-font-size) - 1px);
  display: flex;
  gap: calc(var(--ops-density) * 2);
  flex-wrap: wrap;
}
</style>
