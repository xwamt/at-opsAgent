# Message Edit / Rewind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可编辑或删除任意一条已发送的用户消息：pi JSONL 与 UI transcript 同时截到该点之前，原文回到 Composer；已在目标系统执行的命令不会撤销。

**Architecture:** 发送时用 `session.getUserMessagesForForking()` 把 JSONL `entryId` 回填到 `TranscriptItem.piEntryId`。编辑/删除走 `chat/edit`：abort → `session.navigateTree(piEntryId)` → `sessionStore.truncateFrom`（含该用户条）→ hydrate。Webview 把返回的 `editorText` 写入 Composer。不做新会话 fork，不还原远端状态。

**Tech Stack:** Vue 3、Pinia、TypeScript、Vitest、pi `AgentSession.navigateTree`（0.84.3）。

**Spec:** [`docs/superpowers/specs/2026-09-01-message-edit-and-plugin-owned-approval-design.md`](../specs/2026-09-01-message-edit-and-plugin-owned-approval-design.md) 需求 A。

**Out of scope（规格 3.1.5，不进本计划）：** Composer 上箭头回填最后一条用户原文且不截断。

**Depends on:** 无。可与 plugin-owned-approval 并行，但不要同一 PR。

**Working directory:** `at-opsAgent/`。

**File map:**

| File | Responsibility |
|------|----------------|
| `src/protocol/host-protocol.ts` | `piEntryId`、`ChatEditReq/Res`、`HostRequestType` |
| `src/host/sessionStore.ts` | `truncateFrom(itemId)` |
| `src/runtime/types.ts` / `session-factory.ts` / `fallback.ts` | `navigateToUserEntry` + `userMessagesForForking` |
| `src/runtime/session-events.ts` | `user_entry` 事件 |
| `src/host/services/chatService.ts` | `handleEdit`、回填 `piEntryId` |
| `src/host/hostController.ts` | 路由 `chat/edit` |
| `src/webview-chat/store.ts` / `ChatTranscript.vue` / `Composer.vue` | 按钮、预填、撤回 notice |

**`navigateTree` 语义（实现锁定）：** pi 对用户消息返回 `editorText` 表示「请重写这条」。UI 截断**包含**该用户条（它之后全部丢掉）。随后 `prompt(editorText)` 写入新的用户条。

---

### Task 1: 协议类型

**Files:**
- Modify: `src/protocol/host-protocol.ts`
- Test: `test/webview-chat.test.ts` 或新建 `test/host-protocol-edit.test.ts`（prefer 扩展现有协议相关测试；若无，用 session-store 测试在 Task 2 覆盖形状）

本期类型必须一次加对，后续任务都引用同一名字：

```typescript
// TranscriptItem 用户分支改为：
| { kind: 'user'; id: string; text: string; ts?: number; piEntryId?: string }

export type ChatEditReq = {
  itemId: string;
  action: 'edit' | 'delete';
};

export type ChatEditRes = {
  ok: boolean;
  editorText?: string;
  reason?: string;
  rewindExecuted?: boolean;
};
```

`HostRequestType` 联合类型增加 `'chat/edit'`。

- [ ] **Step 1: Add the types**（无独立运行时，下一步编译/测试会卡住缺类型）

按上面修改 `host-protocol.ts` 的 `TranscriptItem` 用户分支、`HostRequestType`，并在 `ChatPromptReq` 附近插入 `ChatEditReq` / `ChatEditRes`。

从 `src/protocol/index.ts` 确认这些类型被 re-export（若该文件是 `export * from './host-protocol'` 则不用改）。

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p .`（若仓库用 `npm run typecheck` 则用那个）

Expected: PASS（纯加可选字段与新类型，旧代码仍合法）。

- [ ] **Step 3: Commit**

```bash
git add src/protocol/host-protocol.ts src/protocol/index.ts
git commit -m "$(cat <<'EOF'
feat(protocol): add chat/edit and user piEntryId

Edit/delete needs a stable pointer from the UI bubble to the pi JSONL
entry; randomUUID on the transcript item is not that pointer.
EOF
)"
```

---

### Task 2: `sessionStore.truncateFrom`

**Files:**
- Modify: `src/host/sessionStore.ts`
- Test: `test/session-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('truncateFrom', () => {
  it('从指定用户条起截断（含该条），留下更早的轮次', () => {
    const { store } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: '第一问' });
    store.appendItem({ kind: 'assistant', id: 'a1', text: '第一答' });
    store.appendItem({ kind: 'user', id: 'u2', text: '第二问' });
    store.appendItem({ kind: 'assistant', id: 'a2', text: '第二答' });
    store.appendItem({ kind: 'user', id: 'u3', text: '第三问' });

    const result = store.truncateFrom('u2');
    expect(result).toEqual({ ok: true, removed: 3, rewindExecuted: false });
    expect(store.items.map((i) => i.id)).toEqual(['u1', 'a1']);
  });

  it('截掉已成功的 write/exec 工具卡时 rewindExecuted=true', () => {
    const { store } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: '查主机' });
    store.appendItem({
      kind: 'tool',
      id: 't1',
      call: { name: 'run_remote_command', risk: 'exec', status: 'ok' }
    });
    store.appendItem({ kind: 'user', id: 'u2', text: '改命令' });
    const result = store.truncateFrom('u1');
    expect(result.ok).toBe(true);
    expect(result.rewindExecuted).toBe(true);
    expect(store.items).toEqual([]);
  });

  it('找不到 id → ok false，items 不变', () => {
    const { store } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: 'x' });
    expect(store.truncateFrom('missing')).toEqual({
      ok: false,
      removed: 0,
      rewindExecuted: false
    });
    expect(store.items).toHaveLength(1);
  });
});
```

把 `rewindExecuted` 判定限制为被删除区间里 `kind==='tool' && call.risk !== 'read' && call.status==='ok'`。只读工具成功不点亮 notice。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/session-store.test.ts -t truncateFrom`

Expected: FAIL — `truncateFrom` is not a function.

- [ ] **Step 3: Implement**

在 `sessionStore.ts` 的 `appendItem` 旁加入：

```typescript
  truncateFrom(
    itemId: string,
    sessionId?: string
  ): { ok: boolean; removed: number; rewindExecuted: boolean } {
    const sid = sessionId ?? this._activeSessionId;
    const items = this.itemsRef(sid);
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return { ok: false, removed: 0, rewindExecuted: false };
    const removedSlice = items.slice(index);
    const rewindExecuted = removedSlice.some(
      (item) =>
        item.kind === 'tool' && item.call.risk !== 'read' && item.call.status === 'ok'
    );
    const removed = items.length - index;
    items.splice(index);
    this.schedulePersist();
    return { ok: true, removed, rewindExecuted };
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/session-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host/sessionStore.ts test/session-store.test.ts
git commit -m "$(cat <<'EOF'
feat(session-store): truncate transcript from a user item

UI history must drop the edited bubble and everything after it in the
same step as the pi tree navigation.
EOF
)"
```

---

### Task 3: Runtime 暴露 `navigateToUserEntry`

**Files:**
- Modify: `src/runtime/types.ts`（`OpsRuntime` + `OpsRuntimeEvent`）
- Modify: `src/runtime/session-factory.ts`
- Modify: `src/runtime/fallback.ts`
- Modify: `src/runtime/session-events.ts`
- Test: `test/runtime.test.ts`（Fallback 的 navigate no-op；若有 session-factory 单测则补）

- [ ] **Step 1: Write the failing tests**

对 Fallback（`createFallbackRuntime` 已在 runtime.test 里用过）：

```typescript
it('Fallback navigateToUserEntry 返回 cancelled，不抛错', async () => {
  const runtime = createFallbackRuntime({ onEvent: () => {} });
  const result = await runtime.navigateToUserEntry('entry-1');
  expect(result).toEqual({ cancelled: true });
  expect(runtime.userMessagesForForking()).toEqual([]);
});
```

`OpsRuntime` 还没有这些方法 → 编译/测试失败。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/runtime.test.ts -t "Fallback navigateToUserEntry"`

Expected: FAIL — property does not exist.

- [ ] **Step 3: Implement**

`OpsRuntimeEvent` 增加：

```typescript
| { type: 'user_entry'; piEntryId: string; text: string }
```

`OpsRuntime` 增加：

```typescript
  navigateToUserEntry(entryId: string): Promise<{ editorText?: string; cancelled: boolean }>;
  userMessagesForForking(): Array<{ entryId: string; text: string }>;
```

`session-factory.ts` 返回对象里：

```typescript
    async navigateToUserEntry(entryId: string) {
      try {
        const result = await session.navigateTree(entryId);
        return {
          cancelled: result.cancelled === true,
          ...(typeof result.editorText === 'string' ? { editorText: result.editorText } : {})
        };
      } catch {
        return { cancelled: true };
      }
    },
    userMessagesForForking() {
      try {
        return session.getUserMessagesForForking();
      } catch {
        return [];
      }
    },
```

`fallback.ts` 返回对象同样加上：

```typescript
    async navigateToUserEntry() {
      return { cancelled: true };
    },
    userMessagesForForking() {
      return [];
    },
```

`session-events.ts` 在 `message_start`：

```typescript
      case 'message_start': {
        const message = event.message as { role?: string; content?: unknown };
        const role = message.role;
        if (role === 'assistant') {
          currentMessageId = randomUUID();
        } else if (role === 'user') {
          const text = userMessageText(message);
          const match = session
            .getUserMessagesForForking()
            .find((row) => row.text === text);
          if (match) {
            emit({ type: 'user_entry', piEntryId: match.entryId, text: match.text });
          }
        }
        break;
      }
```

在同文件加：

```typescript
function userMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('');
  }
  return '';
}
```

`hostTypes.ts` 的 `RuntimeLike` 增加：

```typescript
  navigateToUserEntry?(entryId: string): Promise<{ editorText?: string; cancelled: boolean }>;
  userMessagesForForking?(): Array<{ entryId: string; text: string }>;
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/runtime.test.ts`

Expected: PASS. `createPiRuntime` 现有测试不 mock `navigateTree` 即可。

- [ ] **Step 5: Commit**

```bash
git add src/runtime/types.ts src/runtime/session-factory.ts src/runtime/fallback.ts \
  src/runtime/session-events.ts src/host/hostTypes.ts test/runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): expose pi navigateTree for user-message rewind

Same session file, not a fork. Fallback is a cancelled no-op so the
host can fail closed when no model is configured.
EOF
)"
```

---

### Task 4: 回填 `piEntryId` + `handleEdit`

**Files:**
- Modify: `src/host/services/runtimeEvents.ts`（消费 `user_entry`）
- Modify: `src/host/services/chatService.ts`
- Modify: `src/host/hostController.ts`
- Test: 新建 `test/chat-edit.test.ts`（mock vscode + 内存 store + fake runtime）

- [ ] **Step 1: Write the failing tests**

`test/chat-edit.test.ts` 用尽可能薄的 fake：直接测一个从 `chatService` 抽出来的纯函数会更稳。若 `handleEdit` 必须挂在 class 上，就 mock `HostContext` 最小集。

优先把截断+navigate 的编排写成 `src/host/services/chatEdit.ts` 纯函数（禁止 import vscode），单测不启 VS Code：

```typescript
// test/chat-edit.test.ts
import { describe, expect, it, vi } from 'vitest';
import { applyChatEdit } from '../src/host/services/chatEdit';
import type { TranscriptItem } from '../src/protocol';

function items(): TranscriptItem[] {
  return [
    { kind: 'user', id: 'u1', text: '第一问', piEntryId: 'e1' },
    { kind: 'assistant', id: 'a1', text: '答' },
    { kind: 'user', id: 'u2', text: '第二问', piEntryId: 'e2' },
    { kind: 'assistant', id: 'a2', text: '答2' }
  ];
}

describe('applyChatEdit', () => {
  it('edit：navigate + 截断含该用户条，返回 editorText', async () => {
    const transcript = items();
    const navigate = vi.fn(async () => ({ cancelled: false, editorText: '第二问' }));
    const abort = vi.fn();
    const truncateFrom = vi.fn((id: string) => {
      const index = transcript.findIndex((row) => row.id === id);
      const rewindExecuted = false;
      transcript.splice(index);
      return { ok: true, removed: 2, rewindExecuted };
    });

    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u2',
      streaming: true,
      items: transcript,
      abort,
      navigate,
      truncateFrom
    });

    expect(abort).toHaveBeenCalledWith('stop');
    expect(navigate).toHaveBeenCalledWith('e2');
    expect(res).toEqual({ ok: true, editorText: '第二问', rewindExecuted: false });
    expect(transcript.map((row) => row.id)).toEqual(['u1', 'a1']);
  });

  it('delete：截断且不返回 editorText', async () => {
    const transcript = items();
    const res = await applyChatEdit({
      action: 'delete',
      itemId: 'u2',
      streaming: false,
      items: transcript,
      abort: vi.fn(),
      navigate: async () => ({ cancelled: false, editorText: '第二问' }),
      truncateFrom: (id) => {
        const index = transcript.findIndex((row) => row.id === id);
        transcript.splice(index);
        return { ok: true, removed: 2, rewindExecuted: false };
      }
    });
    expect(res).toEqual({ ok: true, rewindExecuted: false });
    expect(res.editorText).toBeUndefined();
  });

  it('无 piEntryId → 拒绝，不 navigate', async () => {
    const navigate = vi.fn();
    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u1',
      streaming: false,
      items: [{ kind: 'user', id: 'u1', text: '旧会话' }],
      abort: vi.fn(),
      navigate,
      truncateFrom: vi.fn()
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('无法回溯');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigate cancelled → 不截 UI', async () => {
    const transcript = items();
    const truncateFrom = vi.fn();
    const res = await applyChatEdit({
      action: 'edit',
      itemId: 'u2',
      streaming: false,
      items: transcript,
      abort: vi.fn(),
      navigate: async () => ({ cancelled: true }),
      truncateFrom
    });
    expect(res.ok).toBe(false);
    expect(truncateFrom).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/chat-edit.test.ts`

Expected: FAIL — `applyChatEdit` not found.

- [ ] **Step 3: Implement `chatEdit.ts` + host 接线**

Create `src/host/services/chatEdit.ts`：

```typescript
import type { ChatEditRes, TranscriptItem } from '../../protocol';

export async function applyChatEdit(input: {
  action: 'edit' | 'delete';
  itemId: string;
  streaming: boolean;
  items: readonly TranscriptItem[];
  abort: (mode: 'stop') => void;
  navigate: (entryId: string) => Promise<{ editorText?: string; cancelled: boolean }>;
  truncateFrom: (itemId: string) => { ok: boolean; removed: number; rewindExecuted: boolean };
}): Promise<ChatEditRes> {
  const target = input.items.find((row) => row.id === input.itemId);
  if (!target || target.kind !== 'user') {
    return { ok: false, reason: '找不到这条用户消息' };
  }
  if (typeof target.piEntryId !== 'string' || target.piEntryId.length === 0) {
    return { ok: false, reason: '该条无法回溯（旧会话没有 pi 条目 id）' };
  }
  if (input.streaming) input.abort('stop');
  const nav = await input.navigate(target.piEntryId);
  if (nav.cancelled) {
    return { ok: false, reason: '无法回到这条消息（会话树导航失败）' };
  }
  const cut = input.truncateFrom(input.itemId);
  if (!cut.ok) return { ok: false, reason: '截断会话记录失败' };
  if (input.action === 'edit') {
    return {
      ok: true,
      editorText: nav.editorText ?? target.text,
      rewindExecuted: cut.rewindExecuted
    };
  }
  return { ok: true, rewindExecuted: cut.rewindExecuted };
}
```

`ChatService.handleEdit`：

```typescript
  async handleEdit(req: ChatEditReq): Promise<ChatEditRes> {
    const sessionId = this.ctx.store.activeSessionId;
    const runtime = this.pool.runtimeOf(sessionId);
    const result = await applyChatEdit({
      action: req.action,
      itemId: req.itemId,
      streaming: this.pool.isBusy(sessionId),
      items: this.ctx.store.itemsOf(sessionId),
      abort: () => this.abort('stop', sessionId),
      navigate: async (entryId) => {
        if (!runtime?.navigateToUserEntry) return { cancelled: true };
        return runtime.navigateToUserEntry(entryId);
      },
      truncateFrom: (itemId) => this.ctx.store.truncateFrom(itemId, sessionId)
    });
    if (result.ok) {
      this.ctx.approvals.clearSession(sessionId);
      this.ctx.broadcast('hydrate', this.snapshot());
      if (result.rewindExecuted) {
        this.ctx.emitAssistantNotice(
          '仅撤回了对话上下文。已在目标系统执行的操作不会自动撤销。',
          sessionId
        );
      }
    }
    return result;
  }
```

`RuntimeEventRouter` 收到 `user_entry`：在该 `sessionId` 的 items 里从后往前找 `kind==='user' && !piEntryId && text===event.text`，`patchItem` 写入 `piEntryId`，并 `broadcast('transcript/patch', { itemId, patch: { piEntryId } })`。

核对 `SessionRuntimePool` 是否已有 `isBusy` / `runtimeOf`；没有则用现有 `runtimeFor` 与 running context。`abort` 已按会话定向。

`hostController.handleRequest`：

```typescript
      case 'chat/edit':
        return this.chat.handleEdit(payload as ChatEditReq);
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/chat-edit.test.ts test/session-store.test.ts`

Expected: PASS. 再 `npx tsc --noEmit -p .`。

- [ ] **Step 5: Commit**

```bash
git add src/host/services/chatEdit.ts src/host/services/chatService.ts \
  src/host/services/runtimeEvents.ts src/host/hostController.ts test/chat-edit.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): rewind pi tree and UI together on edit/delete

Abort first, refuse bubbles without piEntryId, and never truncate the
transcript if navigateTree cancels.
EOF
)"
```

---

### Task 5: Webview 编辑/删除 + Composer 预填

**Files:**
- Modify: `src/webview-chat/store.ts`
- Modify: `src/webview-chat/components/ChatTranscript.vue`
- Modify: `src/webview-chat/components/Composer.vue`
- Modify: `src/webview-chat/i18n.ts`
- Modify: `src/webview-chat/mock-host.ts`
- Test: `test/webview-chat.test.ts`（读 Vue 源字符串断言按钮 + store 动作；现有文件已用此模式）

- [ ] **Step 1: Write the failing tests**

```typescript
describe('用户消息编辑入口', () => {
  it('ChatTranscript 为用户气泡提供编辑/删除按钮', () => {
    const src = readFileSync(path.join(dir, 'ChatTranscript.vue'), 'utf8');
    expect(src).toContain("entry.item.kind === 'user'");
    expect(src).toContain('editUserMessage');
    expect(src).toContain('deleteUserMessage');
    expect(src).toContain('codicon-edit');
    expect(src).toContain('codicon-trash');
  });

  it('store.editUserMessage 发送 chat/edit', () => {
    const posts: Array<{ type: string; payload: unknown }> = [];
    // 按文件里现有 mock post 的方式装配 store，调用 editUserMessage('u2')
    // expect(posts[0]).toEqual({ type: 'chat/edit', payload: { itemId: 'u2', action: 'edit' } })
  });
});
```

`store.editUserMessage` 的测试仿 `sendPrompt` 那组：看 `test/webview-chat.test.ts` 里如何 `setActivePinia`。若 pinia store 测起来重，至少保留 Vue 源字符串断言；store 用抽到 `store-helpers` 的 `buildChatEditPayload(itemId, action)`：

```typescript
export function buildChatEditPayload(
  itemId: string,
  action: 'edit' | 'delete'
): { itemId: string; action: 'edit' | 'delete' } | null {
  if (!itemId) return null;
  if (action !== 'edit' && action !== 'delete') return null;
  return { itemId, action };
}
```

单测这个纯函数即可。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/webview-chat.test.ts -t "用户消息编辑入口"`

Expected: FAIL — 源码无 `editUserMessage`。

- [ ] **Step 3: Implement UI**

`store-helpers.ts` 加入 `buildChatEditPayload`。

`store.ts`：

```typescript
    editUserMessage(itemId: string): void {
      const payload = buildChatEditPayload(itemId, 'edit');
      if (payload) this.post('chat/edit', payload);
    },
    deleteUserMessage(itemId: string): void {
      const payload = buildChatEditPayload(itemId, 'delete');
      if (payload) this.post('chat/edit', payload);
    },
    applyComposerDraft(text: string): void {
      this.pendingComposerDraft = text;
    },
```

`store.ts` 的 `handleResponse`（约 436 行）增加：

```typescript
        case 'chat/edit': {
          const res = asRecord(payload);
          if (res.ok === true && typeof res.editorText === 'string') {
            this.pendingComposerDraft = res.editorText;
          }
          break;
        }
```

`post()` 已经带 id，`chatView.ts` 会对每个 req 回 `envelope('res', message.type, payload, message.id)`。`handleEdit` 成功后还会 `broadcast('hydrate', this.snapshot())`；`handleEvent` 已有 `case 'hydrate'`，截断后的 items 会整表替换。

`Composer.vue` watch `pendingComposerDraft`：

```typescript
watch(
  () => store.pendingComposerDraft,
  (text) => {
    if (typeof text === 'string' && text.length > 0) {
      draft.value = text;
      store.pendingComposerDraft = '';
      persistDraft();
      textarea.value?.focus();
    }
  }
);
```

`ChatTranscript.vue` 用户气泡改成与 assistant 类似的 who-row（流式中也显示，点击时 host 会先 abort）：

```vue
        <div v-if="entry.item.kind === 'user'" class="transcript__msg transcript__msg--user">
          <span class="transcript__who-row">
            <span class="transcript__who">{{ t('roleUser') }}</span>
            <button
              type="button"
              class="ops-copy-btn transcript__copy-msg"
              :disabled="!entry.item.piEntryId"
              :title="entry.item.piEntryId ? t('editUserMessage') : t('editUserMessageUnavailable')"
              :aria-label="t('editUserMessage')"
              @click.stop="store.editUserMessage(entry.item.id)"
            >
              <span class="codicon codicon-edit" aria-hidden="true"></span>
            </button>
            <button
              type="button"
              class="ops-copy-btn transcript__copy-msg"
              :disabled="!entry.item.piEntryId"
              :title="entry.item.piEntryId ? t('deleteUserMessage') : t('editUserMessageUnavailable')"
              :aria-label="t('deleteUserMessage')"
              @click.stop="store.deleteUserMessage(entry.item.id)"
            >
              <span class="codicon codicon-trash" aria-hidden="true"></span>
            </button>
          </span>
          <div class="transcript__text transcript__well">{{ entry.item.text }}</div>
        </div>
```

`i18n.ts` 中英：

```
editUserMessage: '编辑' / 'Edit'
deleteUserMessage: '删除' / 'Delete'
editUserMessageUnavailable: '旧会话无法回溯' / 'Cannot rewind this message'
```

`mock-host.ts`：`chat/edit` 回 `{ ok: true, editorText: '…' }` 并把 items 截断，便于本地预览。

- [ ] **Step 4: Run tests**

Run: `npm test -- test/webview-chat.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview-chat test/webview-chat.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-ui): edit and delete user bubbles back into the composer

Clicking edit asks the host to rewind; the restored text lands in the
composer. Bubbles without piEntryId stay disabled.
EOF
)"
```

---

### Task 6: 文档 + 全量回归

**Files:**
- Modify: `docs/05-ui-system.md`（Composer / ChatTranscript 表）
- Modify: `docs/03-agent-runtime.md` §4 补一句 navigateTree 用于用户编辑，不是 coding rewind

- [ ] **Step 1: Docs**

`docs/05-ui-system.md` 组件表为 `ChatTranscript` 增加：用户气泡编辑/删除 → `chat/edit`。Composer 增加：可被 host 预填 `editorText`。

`docs/03-agent-runtime.md` §4 后加：用户编辑走 `AgentSession.navigateTree`，同文件截断；禁止只改 UI；不调用 git checkpoint。

- [ ] **Step 2: Full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/05-ui-system.md docs/03-agent-runtime.md
git commit -m "$(cat <<'EOF'
docs: describe user-message rewind via pi navigateTree
EOF
)"
```
