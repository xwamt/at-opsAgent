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
import SkillsTab from './SkillsTab.vue';

const store = useSettingsStore();

const PANELS = {
  general: GeneralTab,
  models: ModelsTab,
  capabilities: CapabilitiesTab,
  mcp: McpTab,
  skills: SkillsTab,
  sessions: SessionsTab
} as const;

const activePanel = computed(() => PANELS[store.activeTab]);
</script>

<template>
  <div class="settings">
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

<!-- 全局共享样式：卡片 / 表单 / 状态行（scoped 无法穿透子组件）。 -->
<style>
.set-card {
  border: 1px solid var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 10px 12px;
  margin: 0 0 12px;
}

.set-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ops-muted);
  margin: 0 0 8px;
}

.set-hint {
  font-size: 12px;
  color: var(--ops-muted);
  margin: 0 0 10px;
}

.set-field {
  margin: 0 0 10px;
}

.set-label {
  display: block;
  font-size: 12px;
  margin: 0 0 3px;
}

.set-desc {
  display: block;
  font-size: 11px;
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
  font-size: 12px;
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
  font-size: 12px;
  min-height: 16px;
  margin-top: 8px;
}

.set-status--ok {
  color: var(--ops-healthy);
}

.set-status--err {
  color: var(--vscode-errorForeground, var(--ops-crit));
}

.set-note {
  font-size: 12px;
  color: var(--ops-muted);
  background: var(--vscode-textBlockQuote-background, transparent);
  border-left: 3px solid var(--vscode-focusBorder, var(--ops-accent));
  border-radius: 0 3px 3px 0;
  padding: 6px 10px;
  margin: 10px 0 0;
}

.set-empty {
  font-size: 12px;
  color: var(--ops-muted);
  border: 1px dashed var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 14px 12px;
  text-align: center;
}
</style>

<style scoped>
.settings {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--vscode-sideBar-background, var(--ops-bg));
  color: var(--vscode-sideBar-foreground, var(--ops-fg));
}

.settings__nav {
  flex: 0 0 auto;
  width: 132px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  overflow-y: auto;
  background: var(--vscode-sideBar-background, var(--ops-bg));
  border-right: 1px solid var(--vscode-sideBar-border, var(--ops-border));
}

.settings__tab {
  text-align: left;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-sideBar-foreground, var(--ops-fg));
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
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
  color: var(--vscode-list-activeSelectionForeground, var(--ops-fg));
  border-left-color: var(--vscode-focusBorder, var(--ops-accent));
}

.settings__mock {
  margin-top: auto;
  align-self: flex-start;
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 11px;
}

.settings__content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 16px 24px;
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
    border-bottom: 1px solid var(--vscode-sideBar-border, var(--ops-border));
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
