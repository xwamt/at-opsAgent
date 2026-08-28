<script setup lang="ts">
import { computed } from 'vue';
import { SETTINGS_TABS } from '../helpers';
import { t } from '../i18n';
import { useSettingsStore } from '../store';
import CapabilitiesTab from './CapabilitiesTab.vue';
import GeneralTab from './GeneralTab.vue';
import McpTab from './McpTab.vue';
import ModelsTab from './ModelsTab.vue';
import SessionsTab from './SessionsTab.vue';

const store = useSettingsStore();

const PANELS = {
  general: GeneralTab,
  models: ModelsTab,
  capabilities: CapabilitiesTab,
  mcp: McpTab,
  sessions: SessionsTab
} as const;

const activePanel = computed(() => PANELS[store.activeTab]);
</script>

<template>
  <!-- 编辑器区页面：surface = editor（P1-12，不用 sideBar 背景） -->
  <div class="settings" data-surface="editor">
    <nav class="settings__nav" role="tablist" :aria-label="t('settingsTitle')">
      <button
        v-for="tab in SETTINGS_TABS"
        :key="tab.id"
        type="button"
        role="tab"
        class="settings__tab"
        :class="{ 'settings__tab--active': store.activeTab === tab.id }"
        :aria-selected="store.activeTab === tab.id"
        @click="store.setTab(tab.id)"
      >
        {{ t(tab.labelKey) }}
      </button>
      <span v-if="store.mock" class="settings__mock" :title="t('mockBadge')">{{ t('mockBadge') }}</span>
    </nav>
    <main class="settings__content" role="tabpanel">
      <component :is="activePanel" />
    </main>
  </div>
</template>

<!-- 全局共享样式：卡片 / 表单 / 状态行（scoped 无法穿透子组件）。
     字号层级（P1-12 typography）：页标题 16 > 卡片标题 13 > 正文 12 > 说明 11（最小 11px）。 -->
<style>
[data-surface='editor'] {
  --set-surface-bg: var(--vscode-editor-background, var(--ops-bg));
  --set-surface-fg: var(--vscode-editor-foreground, var(--ops-fg));
  --set-font-lg: 16px;
  --set-font-md: 13px;
  --set-font-sm: 12px;
  --set-font-xs: 11px;
}

.set-card {
  border: 1px solid var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 12px 14px;
  margin: 0 0 16px;
}

/* 页级标题（每个页签一处） */
.set-page-title {
  font-size: var(--set-font-lg, 16px);
  font-weight: 600;
  color: var(--set-surface-fg, var(--ops-fg));
  margin: 0 0 4px;
}

/* 卡片 / 分区标题 */
.set-title {
  font-size: var(--set-font-md, 13px);
  font-weight: 600;
  color: var(--set-surface-fg, var(--ops-fg));
  margin: 0 0 8px;
}

.set-hint {
  font-size: var(--set-font-sm, 12px);
  color: var(--ops-muted);
  margin: 0 0 10px;
}

/* 向导步骤行（ux.md §5 首跑 2 分钟文案） */
.set-step {
  font-size: var(--set-font-sm, 12px);
  font-weight: 600;
  color: var(--set-surface-fg, var(--ops-fg));
  border-left: 3px solid var(--vscode-focusBorder, var(--ops-accent));
  padding: 2px 8px;
  margin: 12px 0 8px;
}

.set-step--muted {
  font-weight: 400;
  color: var(--ops-muted);
}

.set-field {
  margin: 0 0 10px;
}

.set-label {
  display: block;
  font-size: var(--set-font-sm, 12px);
  margin: 0 0 3px;
}

.set-desc {
  display: block;
  font-size: var(--set-font-xs, 11px);
  color: var(--ops-muted);
  margin: 3px 0 0;
}

.set-input,
.set-select,
.set-textarea {
  width: 100%;
  padding: 4px 8px;
  color: var(--ops-input-fg);
  background: var(--ops-input-bg);
  border: 1px solid var(--ops-input-border);
  border-radius: 3px;
  font-family: inherit;
  font-size: inherit;
}

.set-select {
  color: var(--vscode-dropdown-foreground, var(--ops-input-fg));
  background: var(--vscode-dropdown-background, var(--ops-input-bg));
}

.set-textarea {
  font-family: var(--ops-mono);
  font-size: calc(var(--ops-font-size) - 1px);
  resize: vertical;
  white-space: pre;
}

.set-input:focus,
.set-select:focus,
.set-textarea:focus {
  outline: 1px solid var(--vscode-focusBorder, var(--ops-accent));
  outline-offset: -1px;
}

.set-check {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--set-font-sm, 12px);
}

.set-check input {
  margin-top: 2px;
  flex: 0 0 auto;
}

.set-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 12px;
}

.set-status {
  font-size: var(--set-font-sm, 12px);
  min-height: 16px;
  margin-top: 8px;
}

.set-status--ok {
  color: var(--ops-healthy);
}

.set-status--err {
  color: var(--vscode-errorForeground, var(--ops-crit));
}

/* 黄字警告（缺 key 等「保存成功但不可用」态） */
.set-status--warn {
  color: var(--ops-warn);
}

.set-note {
  font-size: var(--set-font-sm, 12px);
  color: var(--ops-muted);
  background: var(--vscode-textBlockQuote-background, transparent);
  border-left: 3px solid var(--vscode-focusBorder, var(--ops-accent));
  border-radius: 0 3px 3px 0;
  padding: 6px 10px;
  margin: 10px 0 0;
}

.set-empty {
  font-size: var(--set-font-sm, 12px);
  color: var(--ops-muted);
  border: 1px dashed var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 14px 12px;
  text-align: center;
}
</style>

<style scoped>
/* 设置是编辑器区页面：用 editor 背景（不是 sideBar），对齐 VS Code 原生设置页。 */
.settings {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--set-surface-bg);
  color: var(--set-surface-fg);
}

.settings__nav {
  flex: 0 0 auto;
  width: 148px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  overflow-y: auto;
  background: var(--set-surface-bg);
  border-right: 1px solid var(--vscode-widget-border, var(--ops-border));
}

.settings__tab {
  text-align: left;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--set-surface-fg);
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
  font-size: var(--set-font-md, 13px);
}

.settings__tab:hover {
  background: var(--ops-hover-bg);
}

.settings__tab:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, var(--ops-accent));
  outline-offset: -1px;
}

.settings__tab--active {
  background: var(--vscode-list-activeSelectionBackground, var(--ops-hover-bg));
  color: var(--vscode-list-activeSelectionForeground, var(--set-surface-fg));
  border-left-color: var(--vscode-focusBorder, var(--ops-accent));
}

.settings__mock {
  margin-top: auto;
  align-self: flex-start;
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: 3px;
  padding: 0 4px;
  font-size: var(--set-font-xs, 11px);
}

.settings__content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 24px 32px;
}

/* 编辑器区宽度大：限制表单列宽保证可读性 */
.settings__content > :deep(section) {
  max-width: 680px;
}

/* 窄视图（<420px）：导航折到顶部横排（Roo 式响应） */
@media (max-width: 419px) {
  .settings {
    flex-direction: column;
  }

  .settings__nav {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--vscode-widget-border, var(--ops-border));
    padding: 6px 8px;
  }

  .settings__tab {
    border-left: none;
    border-bottom: 2px solid transparent;
    border-radius: 3px 3px 0 0;
  }

  .settings__tab--active {
    border-bottom-color: var(--vscode-focusBorder, var(--ops-accent));
  }

  .settings__mock {
    margin-top: 0;
    margin-left: auto;
    align-self: center;
  }
}
</style>
