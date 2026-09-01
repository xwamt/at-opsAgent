# 子代理 Transcript Parity 实现计划（对标 Kilo Sub-Agent Viewer）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让子代理 Inspector 呈现与主代理一致的 mini-transcript（流式自然语言、默折叠思维链、ToolCallCard），数据由 runtime 捕获并经 `SubagentCard.transcript[]` 下发，Board 仍保持一行摘要。

**Architecture:** 方案 A（设计说明 §3）— 扩展 `SubagentCard.transcript: SubagentTranscriptItem[]`，runtime 在 `subagent-session.ts` 从 pi 事件构建 transcript，host 合批广播，webview 新增 `SubagentTranscript.vue` 复用 ThinkingBlock/ToolCallCard/MarkdownBlock。主 transcript 边界不变。

**Tech Stack:** TypeScript, pi-coding-agent events, host-protocol, Vue 3, Pinia, Vitest, 现有 StreamBatcher 模式。

**Spec:** [2026-08-31-subagent-transcript-parity-design.md](./2026-08-31-subagent-transcript-parity-design.md)

---

## Global Constraints

- **主 transcript 隔离**：子代理 inner 事件不得写入主 `TranscriptItem[]`（`subagent-session.ts` L152 纪律保持，改为写 card.transcript）。
- **组件复用**：禁止 fork ThinkingBlock/ToolCallCard/MarkdownBlock；Inspector 通过薄包装引用。
- **Payload 纪律**：tool preview ≤4KB；transcript 条目硬顶 500；`subagent/upsert` 40ms 合批。
- **安全**：thinking 默折叠可展开；preview 不脱敏外泄审批令牌。
- **测试**：新增 pure TS helper 必须有 vitest；改 protocol 同步 `docs/schemas/host-protocol.ts`。

---

## File Map

| 文件 | 职责 |
|------|------|
| `src/protocol/host-protocol.ts` | `SubagentTranscriptItem`、`SubagentCard.transcript` |
| `docs/schemas/host-protocol.ts` | zod 镜像 |
| `src/runtime/types.ts` | `OpsSubagentEvent.transcript` |
| `src/runtime/subagent-transcript.ts` | **新建** — pure 函数：pi 事件 → transcript 增量 |
| `src/runtime/subagent-session.ts` | 接入 transcript builder + 合批 emit |
| `src/runtime/tool-gate.ts` 或 execute 路径 | tool result cache（toolCallId → preview） |
| `src/host/services/subagentCards.ts` | `SubagentCardPatch.transcript` |
| `src/host/services/chatService.ts` | onSubagentEvent 映射 transcript |
| `src/host/sessionStore.ts` | 持久化 transcript 终态 |
| `src/host/streamBatcher.ts` 或 subagent batcher | 合批 subagent/upsert |
| `src/webview-chat/components/SubagentTranscript.vue` | **新建** — mini transcript 渲染 |
| `src/webview-chat/components/SubagentInspector.vue` | Tab 改造：对话/概览 |
| `src/webview-chat/components/SubagentBoard.vue` | 摘要 preview 取自 transcript |
| `src/webview-chat/store.ts` | upsertSubagent 合并 transcript |
| `src/webview-chat/i18n.ts` | 新 Tab 文案 |
| `test/subagent-transcript.test.ts` | **新建** — builder 单测 |
| `test/subagent-cards.test.ts` | patch/持久化回归 |
| `test/webview-chat.test.ts` | UI 结构断言 |

---

## Task 1: 协议与子类型定义

**Files:**
- Modify: `src/protocol/host-protocol.ts`
- Modify: `docs/schemas/host-protocol.ts`
- Modify: `src/runtime/types.ts`

- [ ] **Step 1: 编写失败测试 — transcript item 类型守卫**

Create `test/subagent-transcript.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  appendSubagentTextDelta,
  createEmptySubagentTranscript,
  startSubagentAssistant,
  startSubagentThinking,
  appendSubagentThinkingDelta,
  startSubagentTool,
  endSubagentTool
} from '../src/runtime/subagent-transcript';

describe('subagent-transcript builder', () => {
  it('text_delta 追加到 assistant 项而不新增条目', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentAssistant(t, 'a1');
    t = appendSubagentTextDelta(t, 'a1', 'hello');
    t = appendSubagentTextDelta(t, 'a1', ' world');
    const last = t[t.length - 1];
    expect(last.kind).toBe('assistant');
    if (last.kind === 'assistant') expect(last.text).toBe('hello world');
  });

  it('thinking_delta 累积 steps', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentThinking(t, 'th1');
    t = appendSubagentThinkingDelta(t, 'th1', 'step one');
    const item = t.find((i) => i.kind === 'thinking');
    expect(item && item.kind === 'thinking' ? item.steps.join('') : '').toContain('step one');
  });

  it('tool start/end 产生 ToolCallView 状态迁移', () => {
    let t = createEmptySubagentTranscript();
    t = startSubagentTool(t, 'tc1', { name: 'at.zabbix.query', risk: 'read' });
    t = endSubagentTool(t, 'tc1', { status: 'ok', preview: '{"hosts":1}', durationMs: 120 });
    const tool = t.find((i) => i.kind === 'tool');
    expect(tool && tool.kind === 'tool' ? tool.call.status : '').toBe('ok');
    expect(tool && tool.kind === 'tool' ? tool.call.preview : '').toContain('hosts');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd at-opsAgent && npx vitest run test/subagent-transcript.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: 添加协议类型**

In `host-protocol.ts` after `SubagentStep`:

```typescript
export type SubagentTranscriptItem =
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; ts?: number }
  | { kind: 'thinking'; id: string; steps: string[]; durationMs?: number; streaming?: boolean }
  | { kind: 'tool'; id: string; call: ToolCallView };

// SubagentCard 增加:
/** Inspector「对话」Tab：与主 agent 同构的 mini-transcript */
transcript?: SubagentTranscriptItem[];
```

Mirror in `docs/schemas/host-protocol.ts`. Add `transcript?: SubagentTranscriptItem[]` to `OpsSubagentEvent` in `types.ts`.

- [ ] **Step 4: 运行测试** — still fail until Task 2

- [ ] **Step 5: Commit**

```bash
git add src/protocol/host-protocol.ts docs/schemas/host-protocol.ts src/runtime/types.ts test/subagent-transcript.test.ts
git commit -m "feat(protocol): add SubagentTranscriptItem for inspector parity"
```

---

## Task 2: Transcript Builder 纯函数

**Files:**
- Create: `src/runtime/subagent-transcript.ts`
- Test: `test/subagent-transcript.test.ts`

- [ ] **Step 1: 实现 builder API**

```typescript
import type { SubagentTranscriptItem, ToolCallView } from '../protocol/host-protocol';

export type SubagentTranscript = SubagentTranscriptItem[];

const MAX_ITEMS = 500;
const PREVIEW_CAP = 4096;

export function createEmptySubagentTranscript(): SubagentTranscript {
  return [];
}

function clamp(items: SubagentTranscript): SubagentTranscript {
  return items.length > MAX_ITEMS ? items.slice(-MAX_ITEMS) : items;
}

export function startSubagentAssistant(items: SubagentTranscript, id: string): SubagentTranscript {
  return clamp([...items, { kind: 'assistant', id, text: '', streaming: true, ts: Date.now() }]);
}

export function appendSubagentTextDelta(items: SubagentTranscript, id: string, delta: string): SubagentTranscript {
  return clamp(
    items.map((it) =>
      it.kind === 'assistant' && it.id === id
        ? { ...it, text: it.text + delta }
        : it
    )
  );
}

export function finalizeSubagentAssistant(items: SubagentTranscript, id: string): SubagentTranscript {
  return items.map((it) =>
    it.kind === 'assistant' && it.id === id ? { ...it, streaming: false } : it
  );
}

// ... startSubagentThinking, appendSubagentThinkingDelta, finalizeSubagentThinking
// ... startSubagentTool, endSubagentTool (merge ToolCallView fields)
```

Implement thinking/tool variants mirroring main `runtimeEvents.ts` field naming.

- [ ] **Step 2: 运行测试**

Run: `npx vitest run test/subagent-transcript.test.ts`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/runtime/subagent-transcript.ts test/subagent-transcript.test.ts
git commit -m "feat(runtime): subagent transcript builder pure functions"
```

---

## Task 3: Runtime 接入 pi 事件

**Files:**
- Modify: `src/runtime/subagent-session.ts`
- Modify: `src/runtime/tool-gate.ts`（或 executeBusinessTool 返回路径）
- Test: `test/subagent-transcript.test.ts`（集成用例）

- [ ] **Step 1: tool result cache**

Add module-level or session-scoped `Map<toolCallId, { preview: string; error?: string }>` written in `executeBusinessTool` success/error paths. Export `takeToolPreview(toolCallId)` for subagent-session.

- [ ] **Step 2: 替换 emitProgress**

In `runSubagentSession`:

```typescript
let transcript = createEmptySubagentTranscript();
let assistantMsgId: string | null = null;
let thinkingId: string | null = null;

// message_start assistant → assistantMsgId = randomUUID(); transcript = startSubagentAssistant(...)
// text_delta → appendSubagentTextDelta
// thinking_delta → start/append thinking
// tool_execution_start → startSubagentTool with risk from descriptor lookup
// tool_execution_end → endSubagentTool with preview from cache

const emitProgress = throttle(() => {
  handlers.onSubagentEvent?.({
    taskId: spec.taskId,
    status: 'running',
    transcript: [...transcript],
    streamingText: getLastAssistantText(transcript), // optional helper for Board
    // keep steps/logs for backwards compat one release, then deprecate
    ...
  });
}, 40);
```

On session end: `finalizeSubagentAssistant` + finalize thinking; terminal event includes full transcript.

- [ ] **Step 3: 编写集成测试**

Extend `test/subagent-transcript.test.ts` or add `test/subagent-session-transcript.test.ts` mocking pi event sequence → expected transcript length and kinds.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/subagent-transcript.test.ts test/subagent-cards.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/subagent-session.ts src/runtime/tool-gate.ts test/
git commit -m "feat(runtime): capture subagent pi events into transcript"
```

---

## Task 4: Host 层合批与持久化

**Files:**
- Modify: `src/host/services/subagentCards.ts`
- Modify: `src/host/services/chatService.ts`
- Modify: `src/host/sessionStore.ts`
- Modify: `src/host/streamBatcher.ts`（或新建 subagentBatcher）
- Test: `test/subagent-cards.test.ts`

- [ ] **Step 1: SubagentCardPatch 扩展**

```typescript
export interface SubagentCardPatch {
  // existing...
  transcript?: SubagentCard['transcript'];
  /** Board 一行预览：末条 assistant 前 80 字 */
  streamingPreview?: string;
}
```

- [ ] **Step 2: chatService 映射**

```typescript
onSubagentEvent: (e) => {
  this.upsertSubagentCard(sessionId, e.taskId, {
    status: e.status,
    transcript: e.transcript,
    streamingPreview: deriveSubagentPreview(e.transcript, e.summary),
    latest: e.summary ?? e.error, // 终态仍用 summary
    // deprioritize currentActivity for Board when transcript exists
    ...
  });
}
```

Add `deriveSubagentPreview` in `subagentCards.ts` or `store-helpers.ts`.

- [ ] **Step 3: sessionStore 持久化**

In `upsertSubagent`, persist `transcript` on terminal status (`ok|degraded|failed|aborted`). Clear on reload for running (document in code comment).

- [ ] **Step 4: 合批**

Wrap `broadcastToSession(..., 'subagent/upsert', next)` in batcher keyed by `taskId`, flush 40ms — mirror main transcript batching.

- [ ] **Step 5: Tests + commit**

Run: `npx vitest run test/subagent-cards.test.ts test/session-store.test.ts`

```bash
git commit -m "feat(host): persist and batch subagent transcript upserts"
```

---

## Task 5: Webview — SubagentTranscript 组件

**Files:**
- Create: `src/webview-chat/components/SubagentTranscript.vue`
- Modify: `src/webview-chat/store-helpers.ts`
- Test: `test/webview-chat.test.ts`

- [ ] **Step 1: 编写渲染结构测试**

```typescript
describe('SubagentTranscript 结构', () => {
  it('源码引用 ThinkingBlock ToolCallCard MarkdownBlock', () => {
    const src = readFileSync('src/webview-chat/components/SubagentTranscript.vue', 'utf8');
    expect(src).toContain('ThinkingBlock');
    expect(src).toContain('ToolCallCard');
    expect(src).toContain('MarkdownBlock');
    expect(src).toContain('stickyTailSignature');
  });
});
```

- [ ] **Step 2: 实现 SubagentTranscript.vue**

```vue
<script setup lang="ts">
import type { SubagentTranscriptItem } from '../../protocol/host-protocol';
import { stickyTailSignature } from '../store-helpers';
// imports: MarkdownBlock, ThinkingBlock, ToolCallCard
const props = defineProps<{
  items: SubagentTranscriptItem[];
  streaming?: boolean;
}>();
// Reuse ChatTranscript scroll/pinned logic (extract composable useTranscriptScroll if needed)
</script>

<template>
  <div ref="scroller" class="sa-transcript" role="log">
    <template v-for="item in items" :key="item.id">
      <ThinkingBlock v-if="item.kind === 'thinking'" :item="item" />
      <ToolCallCard v-else-if="item.kind === 'tool'" :call="item.call" />
      <div v-else-if="item.kind === 'assistant'" class="sa-transcript__assistant">
        <MarkdownBlock :source="item.text" :streaming="!!item.streaming" />
      </div>
    </template>
  </div>
</template>
```

Extract `usePinnedScroll(scroller, tailSignature)` from ChatTranscript if duplication >30 lines.

- [ ] **Step 3: store upsertSubagent 合并 transcript**

In `store.ts` `subagent/upsert` handler: replace `transcript` array when payload includes it (full snapshot from host).

- [ ] **Step 4: Run tests + commit**

---

## Task 6: SubagentInspector Tab 改造

**Files:**
- Modify: `src/webview-chat/components/SubagentInspector.vue`
- Modify: `src/webview-chat/i18n.ts`

- [ ] **Step 1: Tab 结构调整**

- Default tab: `'transcript'` (was `'steps'`)
- Tabs: **对话** (`subagentTranscriptTab`) | **概览**
- Remove Steps tab; move raw `logs` to Overview collapsible `<details>` 「调试日志」
- Body:

```vue
<SubagentTranscript
  v-if="activeTab === 'transcript'"
  :items="inspected.transcript ?? []"
  :streaming="inspected.status === 'running'"
/>
```

- [ ] **Step 2: i18n**

```typescript
subagentTranscriptTab: '对话',
subagentDebugLogs: '调试日志',
```

- [ ] **Step 3: 测试 + commit**

Update webview-chat tests for tab names and SubagentTranscript presence.

---

## Task 7: SubagentBoard 摘要增强

**Files:**
- Modify: `src/webview-chat/components/SubagentBoard.vue`
- Modify: `src/webview-chat/store-helpers.ts`

- [ ] **Step 1: deriveSubagentBoardPreview helper**

```typescript
export function deriveSubagentBoardPreview(card: SubagentCard): string {
  const fromTranscript = [...(card.transcript ?? [])]
    .reverse()
    .find((i) => i.kind === 'assistant' && i.text.trim());
  if (fromTranscript && fromTranscript.kind === 'assistant') {
    const t = fromTranscript.text.trim();
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  }
  return card.currentActivity ?? card.latest ?? '';
}
```

- [ ] **Step 2: Board 模板使用 helper**

Replace raw `currentActivity`/`latest` display with `deriveSubagentBoardPreview(agent)`.

- [ ] **Step 3: Tests + commit**

---

## Task 8: ThinkingBlock 适配 SubagentTranscriptItem

**Files:**
- Modify: `src/webview-chat/components/ThinkingBlock.vue`（或 wrapper props）

- [ ] **Step 1: 类型兼容**

ThinkingBlock currently expects `TranscriptItem & { kind:'thinking' }`. Either:
- widen prop to `{ kind:'thinking'; steps: string[]; durationMs?; streaming? }`, or
- map in SubagentTranscript before pass-through

Prefer minimal widen + default `showThinking=true`.

- [ ] **Step 2: Verify untrustedQuotes path** — subagent thinking unlikely has quotes; pass empty array

- [ ] **Step 3: Run vitest + manual smoke**

---

## Task 9: 回归与文档

**Files:**
- Modify: `docs/plans/2026-08-31-subagent-transcript-parity-design.md`（状态 → 已实施）
- Modify: `docs/plans/2026-08-31-chat-ui-recommendations.md`（交叉引用）

- [ ] **Step 1: 全量测试**

Run: `cd at-opsAgent && npx vitest run`  
Expected: all pass

- [ ] **Step 2: 手动验收清单**（设计 §5）

- [ ] **Step 3: 更新设计文档状态**

---

## Verification Commands

```bash
cd at-opsAgent

# 单元测试
npx vitest run test/subagent-transcript.test.ts
npx vitest run test/subagent-cards.test.ts
npx vitest run test/webview-chat.test.ts

# 全量
npx vitest run

# 类型检查（如有）
npm run compile 2>/dev/null || npx tsc -p . --noEmit
```

---

## Implementation Order Summary

```
Task 1  协议类型
Task 2  transcript builder（TDD）
Task 3  runtime pi 事件接入
Task 4  host 合批 + 持久化
Task 5  SubagentTranscript.vue
Task 6  Inspector Tab 改造
Task 7  Board 摘要
Task 8  ThinkingBlock 适配
Task 9  回归 + 文档
```

**Estimated effort:** 3–5 天（1 人），或 subagent-driven 9 任务并行波次。

---

## 明确不做

1. 子代理 inner 事件写入主 `TranscriptItem[]`
2. 子代理独立 editor tab / 终端 emulator（Kilo Agent Manager 全量）
3. 子 agent 异步 deliverToMain 回灌（阻塞 dispatch 语义不变）
4. transcript 条目 >500 时不落盘历史（仅保留尾部 + summary）

---

*Plan complete. Execute with subagent-driven-development or executing-plans.*
