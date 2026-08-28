<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

const status = computed(() => store.status.mcp);
const parse = computed(() => store.mcpParse);
/** 卡片数据：编辑稿合法时用编辑稿，否则退回已保存文本（保证坏 JSON 时列表不消失）。 */
const cards = computed(() => parse.value.servers);
</script>

<template>
  <section>
    <h2 class="set-page-title">{{ t('mcpTitle') }}</h2>
    <p class="set-hint">
      {{ t('mcpHint') }}
      <template v-if="store.mcpPath"> · {{ store.mcpPath }}</template>
    </p>
    <p class="set-note">{{ t('mcpHubWarn') }}</p>

    <!-- server 卡片列表（P1-12：默认视图卡片化，JSON 收进「高级」折叠） -->
    <h3 class="set-title mcp-list-title">{{ t('mcpServers') }}</h3>
    <div v-if="cards.length === 0" class="set-empty">{{ t('mcpEmpty') }}</div>
    <div v-for="server in cards" :key="server.name" class="set-card mcp-card">
      <div class="mcp-card__head">
        <span class="mcp-card__name">{{ server.name }}</span>
        <span v-if="server.skipped" class="ops-badge ops-risk-write">{{ t('mcpSkippedBadge') }}</span>
      </div>
      <div v-if="server.summary" class="mcp-card__meta ops-mono">{{ server.summary }}</div>
    </div>

    <!-- 高级：直接编辑 mcp.json（默认折叠；敏感字段 ***） -->
    <details class="mcp-advanced">
      <summary class="mcp-advanced__summary">{{ t('mcpAdvanced') }}</summary>
      <p class="set-hint mcp-redact">{{ t('mcpRedactHint') }}</p>
      <textarea
        class="set-textarea"
        rows="14"
        v-model="store.mcpDraft"
        spellcheck="false"
        :aria-label="t('mcpTitle')"
        placeholder='{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] } } }'
      ></textarea>

      <div class="mcp-feedback">
        <span v-if="!parse.ok" class="set-status--err">{{ t('mcpInvalid') }}{{ parse.error }}</span>
        <span v-else class="ops-muted">{{ parse.serverNames.length }} {{ t('mcpServerCount') }}</span>
      </div>
      <div v-if="parse.ok && parse.skippedAtSeries.length > 0" class="mcp-skipped">
        {{ t('mcpSkipped') }}
        <span class="ops-mono">{{ parse.skippedAtSeries.join(', ') }}</span>
      </div>
    </details>

    <div class="set-actions">
      <button
        type="button"
        class="ops-btn"
        :disabled="!store.mcpDirty || !parse.ok"
        @click="store.saveMcp()"
      >
        {{ t('mcpSave') }}
      </button>
      <button type="button" class="ops-btn ops-btn--secondary" @click="store.openMcpJson()">
        {{ t('mcpOpen') }}
      </button>
    </div>
    <div
      v-if="status"
      class="set-status"
      :class="status.ok ? 'set-status--ok' : 'set-status--err'"
      role="status"
    >
      {{ status.text }}
    </div>
  </section>
</template>

<style scoped>
.mcp-list-title {
  margin-top: 12px;
}

.mcp-card {
  margin-bottom: 8px;
}

.mcp-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mcp-card__name {
  font-weight: 600;
}

.mcp-card__meta {
  margin-top: 4px;
  color: var(--ops-muted);
  overflow-wrap: anywhere;
}

.mcp-advanced {
  margin-top: 12px;
  border: 1px solid var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 8px 12px;
}

.mcp-advanced__summary {
  cursor: pointer;
  font-size: var(--set-font-sm, 12px);
  color: var(--ops-muted);
  user-select: none;
}

.mcp-advanced__summary:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, var(--ops-accent));
  outline-offset: -1px;
}

.mcp-advanced .set-textarea {
  margin-top: 8px;
}

.mcp-redact {
  margin-top: 8px;
}

.mcp-feedback {
  font-size: var(--set-font-sm, 12px);
  margin-top: 6px;
  min-height: 16px;
}

.mcp-skipped {
  font-size: var(--set-font-sm, 12px);
  color: var(--ops-warn);
  margin-top: 4px;
}
</style>
