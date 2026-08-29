<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import { usagePercent } from '../store-helpers';
import { getVsCodeApi } from '../vscode-api';
import ModelSelector from './ModelSelector.vue';

const store = useOpsStore();
const draft = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
/** 未配置时按了发送 ⇒ 显示内联提示条（P0-B 拦截，不静默走 fallback）。 */
const blockedHint = ref(false);

const PLAYBOOK_RE = /^\/playbook(\s|$)/;

const placeholder = computed(() =>
  !store.configured
    ? t('composerPlaceholderNoModel')
    : store.streaming
      ? t('composerPlaceholderStreaming')
      : t('composerPlaceholder')
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

// context 水位（P1-4）：usage evt 驱动的细进度条 + hover 详情
const contextPct = computed(() => usagePercent(store.usage));
const usageTitle = computed(() => {
  const usage = store.usage;
  if (!usage) {
    return '';
  }
  const parts: string[] = [];
  if (contextPct.value !== null) {
    parts.push(
      `${t('usageContext')} ${contextPct.value}%（${usage.contextUsed}/${usage.contextWindow}）`
    );
  }
  if (usage.inputTokens !== undefined) {
    parts.push(`${t('usageInput')} ${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`${t('usageOutput')} ${usage.outputTokens}`);
  }
  return parts.join(' · ');
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

// 配好模型后自动收起拦截提示
watch(
  () => store.configured,
  (ok) => {
    if (ok) {
      blockedHint.value = false;
    }
  }
);

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

/** @资产：host QuickPick（asset/pick req）；res 由 store 回填 attachments。 */
function addAsset(): void {
  store.pickAsset();
  textarea.value?.focus();
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
  // 未配置模型 ⇒ 拦截并出内联 CTA（P0-B），不清空草稿
  if (!store.configured) {
    blockedHint.value = true;
    return;
  }
  store.sendPrompt(text);
  draft.value = '';
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
    <!-- 未配置拦截提示条：一句原因 + 直达设置的 CTA -->
    <div v-if="blockedHint && !store.configured" class="composer__blocked" role="alert">
      <span class="codicon codicon-warning" aria-hidden="true"></span>
      <span class="composer__blocked-text">{{ t('composerNotConfigured') }}</span>
      <button type="button" class="ops-btn composer__blocked-btn" @click="store.openSettings('models')">
        {{ t('composerConfigureModel') }}
      </button>
    </div>

    <div v-if="store.attachments.length > 0" class="composer__chips" :aria-label="t('composerAttachments')">
      <span v-for="(item, i) in store.attachments" :key="(item.uri ?? item.label ?? '') + i" class="composer__chip">
        <span class="ops-mono composer__chip-uri" :title="item.uri ?? item.label">@{{ item.label ?? item.uri }}</span>
        <button
          type="button"
          class="composer__chip-x"
          :aria-label="t('composerAttachRemove') + ' ' + (item.label ?? item.uri ?? '')"
          @click="store.removeAttachment(i)"
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
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
            class="composer__tool"
            :aria-label="t('composerAttachAria')"
            :title="t('composerAttachAria')"
            @click="addAsset"
          >
            <span class="codicon codicon-mention" aria-hidden="true"></span>
          </button>
          <button
            type="button"
            class="composer__tool"
            :aria-expanded="store.activePicker === 'playbook'"
            :aria-label="t('composerPlaybookHint')"
            :title="t('composerPlaybookHint')"
            @click="store.togglePicker('playbook')"
          >
            <span class="codicon codicon-book" aria-hidden="true"></span>
          </button>
          <button
            type="button"
            class="composer__tool"
            :class="{ 'composer__tool--on': store.conclusionMode }"
            :aria-pressed="store.conclusionMode"
            :aria-label="t('conclusionModeAria')"
            :title="t('conclusionMode')"
            @click="store.toggleConclusionMode()"
          >
            <span class="codicon codicon-filter" aria-hidden="true"></span>
          </button>
          <!-- context 水位细条（P1-4）：hover 显示 token 详情 -->
          <div
            v-if="contextPct !== null"
            class="composer__usage"
            role="progressbar"
            :aria-label="t('usageAria')"
            :aria-valuenow="contextPct"
            aria-valuemin="0"
            aria-valuemax="100"
            :title="usageTitle"
          >
            <span class="composer__usage-fill" :style="{ width: contextPct + '%' }"></span>
          </div>
        </div>
        <div class="composer__actions">
          <!-- 软停 / 硬停两档（P2）：Cancel 等当前工具结束；Stop 立即 abort -->
          <template v-if="store.streaming">
            <button
              type="button"
              class="ops-btn ops-btn--secondary"
              :aria-label="t('composerCancelAria')"
              :title="t('composerCancelAria')"
              @click="store.abortRun('cancel')"
            >
              <span class="codicon codicon-stop-circle" aria-hidden="true"></span> {{ t('composerCancel') }}
            </button>
            <button
              type="button"
              class="ops-btn ops-btn--danger"
              :aria-label="t('composerStopAria')"
              :title="t('composerStopAria')"
              @click="store.abortRun('stop')"
            >
              <span class="codicon codicon-debug-stop" aria-hidden="true"></span> {{ t('composerStop') }}
            </button>
          </template>
          <button
            type="button"
            class="ops-btn"
            :disabled="!draft.trim()"
            :aria-label="sendLabel"
            @click="send"
          >
            <span class="codicon codicon-send" aria-hidden="true"></span> {{ sendLabel }}
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
  gap: var(--ops-space-1);
  padding: var(--ops-space-1) var(--ops-space-3) var(--ops-space-3);
  border-top: 1px solid var(--ops-border);
}

.composer__blocked {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  border: 1px solid var(--ops-border);
  border-left: 3px solid var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
  font-size: var(--ops-font-sm);
  min-width: 0;
}

.composer__blocked .codicon {
  color: var(--ops-warn);
  flex: 0 0 auto;
}

.composer__blocked-text {
  flex: 1;
  min-width: 0;
}

.composer__blocked-btn {
  padding: 1px var(--ops-space-2);
  font-size: var(--ops-font-sm);
  white-space: nowrap;
}

.composer__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-1);
}

/* 附件 chip：中性边框（不比内容抢眼），codicon 关闭钮 */
.composer__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-space-1);
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: 0 var(--ops-space-1);
  font-size: var(--ops-font-xs);
  color: var(--ops-muted);
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

.composer__chip-x .codicon {
  font-size: var(--ops-font-xs);
}

.composer__chip-x:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

/* 输入井：composer 是一块明确的输入区，不是贴边裸 textarea */
.composer__well {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-1);
  background: var(--ops-input-bg);
  border: 1px solid var(--ops-input-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-2);
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

/* 井内工具条：左 = 模型/@/playbook/水位，右 = 取消/停止/发送（Continue/Cline 布局） */
.composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ops-space-1);
  min-width: 0;
}

.composer__tools {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  min-width: 0;
  overflow: hidden;
  flex: 1 1 auto;
}

.composer__tool {
  background: transparent;
  border: none;
  border-radius: var(--ops-radius-ctl);
  color: var(--ops-muted);
  cursor: pointer;
  padding: 2px var(--ops-space-1);
  font-size: var(--ops-font-sm);
  white-space: nowrap;
}

.composer__tool .codicon {
  font-size: var(--ops-font-md);
}

.composer__tool:hover {
  background: var(--ops-toolbar-hover-bg);
  color: var(--ops-fg);
}

.composer__tool:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: 1px;
}

.composer__tool--on {
  color: var(--ops-accent);
  background: var(--ops-toolbar-hover-bg);
}

/* context 水位细条：4px 高，accent 填充 */
.composer__usage {
  flex: 0 1 72px;
  min-width: 32px;
  height: 4px;
  border-radius: 2px;
  background: var(--ops-hover-bg);
  overflow: hidden;
  align-self: center;
}

.composer__usage-fill {
  display: block;
  height: 100%;
  background: var(--ops-accent);
  border-radius: 2px;
}

.composer__actions {
  display: flex;
  align-items: center;
  gap: var(--ops-space-1);
  flex: 0 0 auto;
}

.composer__actions .ops-btn {
  white-space: nowrap;
}
</style>
