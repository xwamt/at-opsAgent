<script setup lang="ts">
const props = defineProps<{
  pluginId: string;
  label: string;
  connected: boolean;
}>();
</script>

<template>
  <span
    class="hchip"
    :class="props.connected ? 'hchip--ok' : 'hchip--off'"
    :title="props.pluginId + ' · ' + props.label + (props.connected ? ' 已连接' : ' 未连接')"
  >
    <span aria-hidden="true">{{ props.connected ? '⌁' : '⊘' }}</span>
    <span class="hchip__plugin ops-mono">{{ props.pluginId }}</span>
    <span class="hchip__label">{{ props.label }}</span>
    <span class="hchip__state">{{ props.connected ? '已连接' : '未连接' }}</span>
  </span>
</template>

<style scoped>
.hchip {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-density);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: 0 calc(var(--ops-density) + 2px);
  font-size: calc(var(--ops-font-size) - 2px);
  line-height: 1.7;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
}

/* 连接态不只靠颜色：图标 ⌁/⊘ + 「已连接/未连接」文字常显 */
.hchip--ok {
  color: var(--ops-healthy);
  border-color: var(--ops-healthy);
}

.hchip--off {
  color: var(--ops-pending);
  border-style: dashed;
}

.hchip__plugin {
  font-size: calc(var(--ops-font-size) - 3px);
  opacity: 0.85;
}

.hchip__label {
  color: var(--ops-fg);
  overflow: hidden;
  text-overflow: ellipsis;
}

.hchip__state {
  opacity: 0.9;
}
</style>
