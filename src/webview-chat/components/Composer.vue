<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useOpsStore } from '../store';
import { getVsCodeApi } from '../vscode-api';

const store = useOpsStore();
const draft = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);

const PLAYBOOK_RE = /^\/playbook(\s|$)/;
const SKILL_RE = /^\/skill(\s|$)/;

const placeholder = computed(() =>
  store.streaming ? '正在运行 · 输入将作为 steer 引导当前任务…' : '描述运维问题… @资产 /playbook /skill'
);

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

// 输入 /playbook 或 /skill 时弹出对应 picker（只在刚敲出命令的瞬间触发一次）
watch(draft, (next, prev) => {
  persistDraft();
  const now = next.trimStart();
  const before = (prev ?? '').trimStart();
  if (PLAYBOOK_RE.test(now) && !PLAYBOOK_RE.test(before)) {
    store.activePicker = 'playbook';
  } else if (SKILL_RE.test(now) && !SKILL_RE.test(before)) {
    store.activePicker = 'skill';
  }
});

// picker 选中后清掉输入框里的 slash 命令
store.$onAction(({ name, after }) => {
  if (name !== 'startPlaybook' && name !== 'runSkill') {
    return;
  }
  after(() => {
    const trimmed = draft.value.trimStart();
    if (PLAYBOOK_RE.test(trimmed) || SKILL_RE.test(trimmed)) {
      draft.value = '';
    }
  });
});

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
  if (SKILL_RE.test(text)) {
    store.activePicker = 'skill';
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
    <textarea
      ref="textarea"
      v-model="draft"
      class="composer__input"
      rows="2"
      :placeholder="placeholder"
      aria-label="消息输入"
      @keydown="onKeydown"
    ></textarea>
    <div class="composer__actions">
      <button
        v-if="store.streaming"
        type="button"
        class="ops-btn ops-btn--secondary"
        aria-label="停止当前运行"
        @click="store.abortRun()"
      >
        ⏹ 停止
      </button>
      <button
        type="button"
        class="ops-btn"
        :disabled="!draft.trim()"
        :aria-label="store.streaming ? '发送 steer' : '发送'"
        @click="send"
      >
        {{ store.streaming ? 'Steer' : '发送' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  gap: var(--ops-density);
  align-items: flex-end;
  padding: var(--ops-density) calc(var(--ops-density) * 2);
  border-top: 1px solid var(--ops-border);
}

.composer__input {
  flex: 1;
  resize: none;
  min-height: 34px;
  max-height: 120px;
  background: var(--ops-input-bg);
  color: var(--ops-input-fg);
  border: 1px solid var(--ops-input-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-density) calc(var(--ops-density) * 1.5);
  font-family: inherit;
  font-size: inherit;
  line-height: 1.4;
}

.composer__input:focus {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.composer__actions {
  display: flex;
  gap: var(--ops-density);
}
</style>
