<script setup lang="ts">
import { computed } from 'vue';
import { t, tf } from '../i18n';
import {
  formatKvCell,
  type ToolDataView,
  type ToolProviderRow,
  type ToolServerRow
} from '../store-helpers';

defineOptions({ name: 'ToolDataViewBlock' });

const props = defineProps<{ view: ToolDataView }>();

const CHIP_SHOW = 24;
const PROVIDER_TOOL_SHOW = 10;

const chipItems = computed(() => (props.view.kind === 'chips' ? props.view.items : []));
const chipVisible = computed(() => chipItems.value.slice(0, CHIP_SHOW));
const chipMore = computed(() => Math.max(0, chipItems.value.length - CHIP_SHOW));

const kvHasBlock = computed(() => {
  if (props.view.kind !== 'kv') return false;
  return props.view.entries.some((e) => e.view.kind !== 'scalar');
});

function hostAddr(row: ToolServerRow): string {
  return row.port ? `${row.host}:${row.port}` : row.host;
}

function providerToolVisible(row: ToolProviderRow): string[] {
  return row.toolNames.slice(0, PROVIDER_TOOL_SHOW);
}

function providerToolMore(row: ToolProviderRow): number {
  return Math.max(0, row.toolNames.length - PROVIDER_TOOL_SHOW);
}

function isKvBlock(view: ToolDataView): boolean {
  return view.kind !== 'scalar';
}
</script>

<template>
  <span v-if="view.kind === 'scalar'" class="tool__kv-v ops-mono">{{ view.text }}</span>

  <div v-else-if="view.kind === 'chips'" class="tool__chips">
    <span v-for="(item, i) in chipVisible" :key="`${item}-${i}`" class="tool__chip ops-mono" :title="item">{{ item }}</span>
    <span v-if="chipMore" class="tool__chip tool__chip--more ops-muted">{{ tf('toolChipMore', { count: chipMore }) }}</span>
  </div>

  <div v-else-if="view.kind === 'servers'" class="tool__data-list">
    <div v-for="row in view.servers" :key="row.id || row.host" class="tool__host-row" :title="row.id">
      <div class="tool__host-row__top">
        <span class="tool__host-dot" :class="row.connected ? 'tool__host-dot--on' : 'tool__host-dot--off'"></span>
        <span class="tool__host-label ops-mono">{{ row.label }}</span>
        <span class="ops-mono">{{ hostAddr(row) }}</span>
        <span v-if="row.username" class="ops-muted">{{ row.username }}</span>
      </div>
      <div class="ops-muted tool__host-row__meta">
        {{ row.connected ? t('connected') : t('disconnected') }}
        <template v-if="row.focused"> · {{ t('toolFocused') }}</template>
        <template v-if="row.isDefault"> · {{ t('toolDefault') }}</template>
        <template v-if="row.trust"> · {{ tf('toolTrust', { trust: row.trust }) }}</template>
        <template v-if="row.autoApprove === true"> · {{ t('toolAutoApprove') }}</template>
        <template v-else-if="row.autoApprove === false"> · {{ t('toolNeedApprove') }}</template>
      </div>
    </div>
  </div>

  <div v-else-if="view.kind === 'providers'" class="tool__data-list">
    <div v-for="row in view.providers" :key="row.pluginId" class="tool__host-row">
      <div class="tool__host-row__top">
        <span class="tool__host-dot" :class="row.healthy ? 'tool__host-dot--on' : 'tool__host-dot--off'"></span>
        <span class="tool__host-label ops-mono">{{ row.displayName }}</span>
        <span class="ops-mono ops-muted">{{ row.pluginId }}</span>
      </div>
      <div class="ops-muted tool__host-row__meta">
        {{ row.healthy ? t('toolHealthy') : t('toolUnhealthy') }}
        <template v-if="row.pluginVersion"> · v{{ row.pluginVersion }}</template>
        <template v-if="row.liveToolCount !== undefined">
          · {{ tf('toolLiveTools', { count: row.liveToolCount }) }}
        </template>
        <template v-else-if="row.toolNames.length">
          · {{ tf('toolDeclaredTools', { count: row.toolNames.length }) }}
        </template>
        <template v-if="row.connectedTargets !== undefined">
          · {{ tf('toolServerCount', { count: row.connectedTargets }) }}
        </template>
      </div>
      <div v-if="row.toolNames.length" class="tool__chips tool__chips--nested">
        <span v-for="name in providerToolVisible(row)" :key="name" class="tool__chip ops-mono" :title="name">{{
          name
        }}</span>
        <span v-if="providerToolMore(row)" class="tool__chip tool__chip--more ops-muted">{{
          tf('toolChipMore', { count: providerToolMore(row) })
        }}</span>
      </div>
    </div>
  </div>

  <div v-else-if="view.kind === 'table'" class="tool__data-table-wrap">
    <table class="tool__data-table">
      <thead>
        <tr>
          <th v-for="col in view.columns" :key="col" class="ops-muted">{{ col }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in view.rows" :key="i">
          <td v-for="col in view.columns" :key="col" class="ops-mono">{{ formatKvCell(row[col]) }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-else-if="view.kind === 'kv'" class="tool__kv" :class="{ 'tool__kv--mixed': kvHasBlock }">
    <div
      v-for="e in view.entries"
      :key="e.key"
      class="tool__kv-row"
      :class="{ 'tool__kv-row--block': isKvBlock(e.view) }"
    >
      <span class="tool__kv-k ops-muted">{{ e.key }}</span>
      <ToolDataViewBlock :view="e.view" />
    </div>
  </div>

  <pre v-else-if="view.kind === 'json' && view.text" class="ops-codeblock tool__data-code ops-mono">{{ view.text }}</pre>
</template>

<style scoped>
.tool__data-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool__host-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 8px;
  background: var(--ops-code-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
}

.tool__host-row__top {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-width: 0;
}

.tool__host-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--ops-pending);
}

.tool__host-dot--on {
  background: var(--ops-healthy);
}

.tool__host-dot--off {
  background: var(--ops-pending);
}

.tool__host-label {
  font-weight: 600;
  color: var(--ops-accent);
}

.tool__host-row__meta {
  padding-left: 15px;
  font-size: var(--ops-font-xs);
}

.tool__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tool__chips--nested {
  padding: 4px 0 0 15px;
}

.tool__chip {
  max-width: 100%;
  padding: 1px 7px;
  border: 1px solid var(--ops-border);
  border-radius: 999px;
  background: var(--ops-bg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ops-font-xs);
}

.tool__chip--more {
  border-style: dashed;
}

.tool__kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--ops-code-bg);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
}

.tool__kv--mixed {
  gap: 8px;
  padding: 0;
  background: transparent;
  border: none;
}

.tool__kv-row {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 2px 10px;
  font-size: var(--ops-font-xs);
}

.tool__kv-row--block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool__kv-v {
  word-break: break-all;
}

.tool__data-table-wrap {
  overflow: auto;
  max-height: 200px;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius-ctl);
}

.tool__data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--ops-font-xs);
}

.tool__data-table th,
.tool__data-table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--ops-border);
}

.tool__data-code {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-size: var(--ops-font-xs);
}
</style>
