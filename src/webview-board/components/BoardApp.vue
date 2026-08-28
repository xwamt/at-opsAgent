<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../../webview-chat/i18n';
import { bt } from '../i18n';
import { useBoardStore, type BoardSeverityFilter } from '../store';
import IncidentTimeline from './IncidentTimeline.vue';

const store = useBoardStore();

interface SeverityPill {
  value: BoardSeverityFilter;
  label: string;
  count: number;
  cls: string;
}

const pills = computed<SeverityPill[]>(() => {
  const counts = store.severityCounts;
  return [
    { value: 'all', label: bt('filterAll'), count: store.events.length, cls: 'board__pill--all' },
    { value: 'info', label: 'info', count: counts.info, cls: 'board__pill--info' },
    { value: 'warn', label: 'warn', count: counts.warn, cls: 'board__pill--warn' },
    { value: 'crit', label: 'crit', count: counts.crit, cls: 'board__pill--crit' }
  ];
});

const countText = computed(() => {
  const total = store.events.length;
  const shown = store.filtered.length;
  const unit = t('boardCountUnit');
  return shown === total ? `${total} ${unit}` : `${shown} / ${total} ${unit}`;
});

function onQueryInput(event: Event): void {
  store.setQuery((event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="board" data-surface="editor">
    <header class="board__head">
      <span class="board__title">{{ t('boardTitle') }}</span>
      <span class="ops-muted">{{ countText }}</span>
      <span v-if="store.mock" class="board__mock" :title="bt('mockBadgeTitle')">mock</span>
    </header>
    <div class="board__toolbar" role="toolbar" :aria-label="bt('filterToolbarAria')">
      <div class="board__pills" role="group" :aria-label="bt('severityFilterAria')">
        <button
          v-for="pill in pills"
          :key="pill.value"
          type="button"
          class="board__pill"
          :class="[pill.cls, { 'board__pill--active': store.severity === pill.value }]"
          :aria-pressed="store.severity === pill.value"
          @click="store.setSeverity(pill.value)"
        >
          {{ pill.label }}
          <span class="board__pill-count">{{ pill.count }}</span>
        </button>
      </div>
      <input
        class="board__search"
        type="search"
        :value="store.query"
        :placeholder="bt('searchPlaceholder')"
        :aria-label="bt('searchAria')"
        @input="onQueryInput"
      />
    </div>
    <IncidentTimeline class="board__timeline" />
  </div>
</template>

<!-- 编辑器页 surface 切换（ui.md §token ③）：board/settings 用 editor 背景，
     chat 侧边栏保持 sideBar 背景。三入口共用 ops-tokens.css，这里按容器局部覆盖。 -->
<style>
[data-surface='editor'] {
  --ops-bg: var(--vscode-editor-background, var(--vscode-sideBar-background));
}
</style>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--ops-bg);
}

.board__head {
  display: flex;
  align-items: center;
  gap: calc(var(--ops-density) * 2);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-bottom: 1px solid var(--ops-border);
  font-size: calc(var(--ops-font-size) - 1px);
}

.board__title {
  font-weight: 600;
}

.board__mock {
  margin-left: auto;
  border: 1px dashed var(--ops-warn);
  color: var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
  font-size: calc(var(--ops-font-size) - 2px);
}

.board__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: calc(var(--ops-density) * 2);
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-bottom: 1px solid var(--ops-border);
}

.board__pills {
  display: inline-flex;
  gap: var(--ops-density);
}

.board__pill {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--ops-density) - 2px);
  border: 1px solid var(--ops-border);
  border-radius: 999px;
  padding: 1px calc(var(--ops-density) * 1.5);
  background: transparent;
  color: var(--ops-muted);
  font-size: calc(var(--ops-font-size) - 2px);
  cursor: pointer;
  white-space: nowrap;
}

.board__pill:hover {
  background: var(--ops-hover-bg);
}

.board__pill:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

/* 风险三色只在激活态点亮，避免 pill 常态就是三彩装饰 */
.board__pill--active {
  color: var(--ops-fg);
  border-color: currentColor;
  background: var(--ops-hover-bg);
  font-weight: 600;
}

.board__pill--info.board__pill--active {
  color: var(--ops-pending);
}

.board__pill--warn.board__pill--active {
  color: var(--ops-warn);
}

.board__pill--crit.board__pill--active {
  color: var(--ops-crit);
}

.board__pill-count {
  font-size: calc(var(--ops-font-size) - 3px);
  border-radius: 999px;
  padding: 0 calc(var(--ops-density) - 1px);
  background: var(--vscode-badge-background, var(--ops-hover-bg));
  color: var(--vscode-badge-foreground, var(--ops-muted));
  line-height: 1.5;
}

.board__search {
  flex: 1 1 160px;
  max-width: 320px;
  margin-left: auto;
  border: 1px solid var(--ops-input-border);
  border-radius: var(--ops-radius);
  background: var(--ops-input-bg);
  color: var(--ops-input-fg);
  font-family: inherit;
  font-size: calc(var(--ops-font-size) - 1px);
  padding: calc(var(--ops-density) - 2px) var(--ops-density);
}

.board__search:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.board__timeline {
  flex: 1;
  min-height: 0;
}
</style>
