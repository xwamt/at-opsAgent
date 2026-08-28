<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import type { PromptAttachment } from '../store-helpers';
import { getVsCodeApi } from '../vscode-api';
import ModelSelector from './ModelSelector.vue';

const store = useOpsStore();
const draft = ref('');
const attachments = ref<PromptAttachment[]>([]);
const textarea = ref<HTMLTextAreaElement | null>(null);

const PLAYBOOK_RE = /^\/playbook(\s|$)/;

const placeholder = computed(() =>
  store.streaming ? t('composerPlaceholderStreaming') : t('composerPlaceholder')
);

// 发送按钮三态：流式中 Steer / 刚结束一轮 追问(followUp) / 其它 发送
const sendLabel = computed(() =>
  store.streaming ? t('composerSteer') : store.canFollowUp ? t('composerFollowUp') : t('composerSend')
);

// 输入井随内容长高：2–6 行（Cline/Continue 的 composer 手感）
const rows = computed(() => {
  const lines = draft.value.split('\n').length;
  return Math.min(6, Math.max(2, lines));
});

onMounted(() => {
  const state = getVsCodeApi().getState() as { draft?: string } | undefined;
  if (state?.draft) {
    draft.value = state.draft;
  }
});

function persistDraft(): void {
  const api = getVsCodeApi();
  const prev = (api.getState() as Record<string, unknown> | undefined) ?? {};
  api.setState({ ...prev, draft: draft.value });
}

// 输入 /playbook 时弹出 picker（只在刚敲出命令的瞬间触发一次）
watch(draft, (next, prev) => {
  persistDraft();
  const now = next.trimStart();
  const before = (prev ?? '').trimStart();
  if (PLAYBOOK_RE.test(now) && !PLAYBOOK_RE.test(before)) {
    store.activePicker = 'playbook';
  }
});

// picker 选中后清掉输入框里的 slash 命令
store.$onAction(({ name, after }) => {
  if (name !== 'startPlaybook') {
    return;
  }
  after(() => {
    if (PLAYBOOK_RE.test(draft.value.trimStart())) {
      draft.value = '';
    }
  });
});

/** @资产：window.prompt 输入 URI，作为 {kind:'file', uri} 附件随 chat/prompt 上行。 */
function addAsset(): void {
  const uri = window.prompt(t('composerAttachPrompt'));
  const trimmed = uri?.trim();
  if (!trimmed) {
    return;
  }
  attachments.value.push({ kind: 'file', uri: trimmed });
  textarea.value?.focus();
}

function removeAsset(index: number): void {
  attachments.value.splice(index, 1);
}

function send(): void {
  const text = draft.value.trim();
  if (!text) {
    return;
  }
  // slash 命令不发给 host，改为打开 picker
  if (PLAYBOOK_RE.test(text)) {
    store.activePicker = 'playbook';
    return;
  }
  store.sendPrompt(text, attachments.value.length > 0 ? [...attachments.value] : undefined);
  draft.value = '';
  attachments.value = [];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="composer">
    <div v-if="attachments.length > 0" class="composer__chips" aria-label="附件">
      <span v-for="(item, i) in attachments" :key="(item.uri ?? '') + i" class="composer__chip">
        <span class="ops-mono composer__chip-uri" :title="item.uri">@{{ item.uri }}</span>
        <button
          type="button"
          class="composer__chip-x"
          :aria-label="t('composerAttachRemove') + ' ' + (item.uri ?? '')"
          @click="removeAsset(i)"
        >
          ✕
        </button>
      </span>
    </div>
    <div class="composer__well">
      <textarea
        ref="textarea"
        v-model="draft"
        class="composer__input"
        :rows="rows"
        :placeholder="placeholder"
        :aria-label="t('composerInputAria')"
        @keydown="onKeydown"
      ></textarea>
      <div class="composer__toolbar">
        <div class="composer__tools">
          <ModelSelector />
          <button
            type="button"
            class="composer__tool ops-mono"
            :aria-label="t('composerAttachAria')"
            :title="t('composerAttachAria')"
            @click="addAsset"
          >
            @
          </button>
          <button
            type="button"
            class="composer__tool ops-mono"
            :aria-expanded="store.activePicker === 'playbook'"
            :aria-label="t('composerPlaybookHint')"
            :title="t('composerPlaybookHint')"
            @click="store.togglePicker('playbook')"
          >
            /playbook
          </button>
        </div>
        <div class="composer__actions">
          <button
            v-if="store.streaming"
            type="button"
            class="ops-btn ops-btn--secondary"
            :aria-label="t('composerStopAria')"
            @click="store.abortRun()"
          >
            ⏹ {{ t('composerStop') }}
          </button>
          <button
            type="button"
            class="ops-btn"
            :disabled="!draft.trim()"
            :aria-label="sendLabel"
            @click="send"
          >
            {{ sendLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--ops-density);
  padding: var(--ops-density) calc(var(--ops-density) * 2) calc(var(--ops-density) * 2);
  border-top: 1px solid var(--ops-border);
}

.composer__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-density);
}

.composer__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-density);
  border: 1px solid var(--ops-accent);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-density);
  font-size: calc(var(--ops-font-size) - 2px);
  color: var(--ops-accent);
  max-width: 100%;
}

.composer__chip-uri {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.composer__chip-x {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.composer__chip-x:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

/* 输入井：composer 是一块明确的输入区，不是贴边裸 textarea */
.composer__well {
  display: flex;
  flex-direction: column;
  gap: var(--ops-density);
  background: var(--ops-input-bg);
  border: 1px solid var(--ops-input-border);
  border-radius: var(--ops-radius);
  padding: 8px 10px;
}

.composer__well:focus-within {
  border-color: var(--ops-accent);
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.composer__input {
  width: 100%;
  resize: none;
  background: transparent;
  color: var(--ops-input-fg);
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: 1.45;
}

.composer__input:focus {
  outline: none;
}

/* 井内工具条：左 = 模型/@/playbook，右 = 停止/发送（Continue/Cline 布局） */
.composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-density);
  min-width: 0;
}

.composer__tools {
  display: flex;
  align-items: center;
  gap: var(--ops-density);
  min-width: 0;
  overflow: hidden;
}

.composer__tool {
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 1px var(--ops-density);
  font-size: calc(var(--ops-font-size) - 2px);
  white-space: nowrap;
}

.composer__tool:hover {
  background: var(--ops-hover-bg);
  color: var(--ops-fg);
}

.composer__tool:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.composer__actions {
  display: flex;
  align-items: center;
  gap: var(--ops-density);
  flex: 0 0 auto;
}
</style>
