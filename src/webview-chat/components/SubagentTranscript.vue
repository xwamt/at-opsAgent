<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import type { SubagentTranscriptItem } from '../../protocol/host-protocol';
import { t } from '../i18n';
import {
  distanceFromBottom,
  isPinnedToBottom as elementPinnedToBottom,
  stickyTailSignature
} from '../store-helpers';
import MarkdownBlock from './MarkdownBlock.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCallCard from './ToolCallCard.vue';

const props = defineProps<{
  items: SubagentTranscriptItem[];
  streaming?: boolean;
}>();

const scroller = ref<HTMLElement | null>(null);
const isPinnedToBottom = ref(true);

function onScroll(): void {
  const el = scroller.value;
  if (el) {
    const dist = distanceFromBottom(el);
    if (dist > 80) {
      isPinnedToBottom.value = false;
    } else if (elementPinnedToBottom(el)) {
      isPinnedToBottom.value = true;
    }
  }
}

function scrollToBottom(smooth = false): void {
  const el = scroller.value;
  if (!el) return;
  isPinnedToBottom.value = true;
  if (smooth) {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    return;
  }
  window.requestAnimationFrame(() => {
    const target = scroller.value;
    if (target) {
      target.scrollTop = target.scrollHeight;
    }
  });
}

watch(
  () => [stickyTailSignature(props.items), props.streaming, props.items?.length],
  async () => {
    if (isPinnedToBottom.value) {
      await nextTick();
      scrollToBottom();
    }
  }
);

onMounted(() => {
  scrollToBottom();
});
</script>

<template>
  <div ref="scroller" class="sa-transcript" role="log" @scroll="onScroll">
    <div v-if="!items || items.length === 0" class="sa-transcript__empty">
      <span v-if="streaming" class="sa-transcript__streaming-placeholder">
        <span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
        {{ t('subagentTranscriptEmptyStreaming') || '正在分析推导与执行…' }}
      </span>
      <span v-else class="sa-transcript__empty-text">
        {{ t('subagentTranscriptEmpty') || '暂无对话记录' }}
      </span>
    </div>

    <template v-else>
      <div v-for="item in items" :key="item.id" class="sa-transcript__entry">
        <!-- 思考链 -->
        <ThinkingBlock v-if="item.kind === 'thinking'" :item="item" />

        <!-- 工具调用卡 -->
        <ToolCallCard v-else-if="item.kind === 'tool'" :call="item.call" />

        <!-- 助理自然语言回复（MarkdownBlock） -->
        <div v-else-if="item.kind === 'assistant'" class="sa-transcript__assistant">
          <MarkdownBlock :source="item.text" :streaming="!!item.streaming" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sa-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sa-transcript__entry {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sa-transcript__assistant {
  padding: 8px 12px;
  background: var(--vscode-editor-background, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
  border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
  line-height: 1.5;
}

.sa-transcript__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.sa-transcript__streaming-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
