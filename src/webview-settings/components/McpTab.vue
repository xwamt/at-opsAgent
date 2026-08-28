<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();

const status = computed(() => store.status.mcp);
const parse = computed(() => store.mcpParse);
</script>

<template>
  <section>
    <h2 class="set-title">{{ t('mcpTitle') }}</h2>
    <p class="set-hint">
      {{ t('mcpHint') }}
      <template v-if="store.mcpPath"> · {{ store.mcpPath }}</template>
    </p>
    <p class="set-note">{{ t('mcpHubWarn') }}</p>
    <p class="set-hint mcp-redact">{{ t('mcpRedactHint') }}</p>

    <div class="set-card">
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
    </div>

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
.mcp-redact {
  margin-top: 8px;
}

.mcp-feedback {
  font-size: 12px;
  margin-top: 6px;
  min-height: 16px;
}

.mcp-skipped {
  font-size: 12px;
  color: var(--ops-warn);
  margin-top: 4px;
}
</style>
