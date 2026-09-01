# Tool Call Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `run_remote_command` 按三行叠栏渲染（主机+Purpose / 命令 / 真实 stdout），并让 `list_ssh_servers` 等数据工具展示结构化结果，而不是把 Hub `{ok,result}` 信封整段丢进终端。

**Architecture:** 根因在解析层，不在缺组件。`parseToolOutputPreview` 必须拆 `result.*`（`serverLabel`/`command`/`stdout`），`tool/start` 的 args 冻结为 `inputPreview` 以免被 `tool/update|end` 覆盖。`ToolCallCard.vue` 用解析结果喂标题、可折叠命令行和现有 `TerminalViewer`；数据工具走 `classifyToolDataView`。单测夹具必须是生产信封。

**Tech Stack:** Vue 3、Pinia、TypeScript、Vitest（不 mount SFC）、VS Code webview tokens。

**Spec:** [`docs/superpowers/specs/2026-09-01-tool-call-card-redesign.md`](../specs/2026-09-01-tool-call-card-redesign.md)

**Working directory:** `at-opsAgent/`（所有命令在此目录执行）。

**Shared fixtures**（各任务复制，禁止改扁平成 `{command, stdout}` 当主路径）：

```typescript
const SCREENSHOT_ENVELOPE = JSON.stringify({
  ok: true,
  result: {
    serverId: '4d1fbefc-aeef-42e9-9008-62c04915affe',
    serverLabel: '99.90',
    host: '192.168.99.90',
    command: 'hostname',
    exitCode: 0,
    stdout: 'cl\n',
    stderr: '',
    durationMs: 258,
    timedOut: false,
    truncated: false
  },
  attemptCount: 1,
  durationMs: 261
});

const LIST_SSH_ENVELOPE = JSON.stringify({
  ok: true,
  result: {
    servers: [
      {
        id: '4d1fbefc-aeef-42e9-9008-62c04915affe',
        label: '99.90',
        host: '192.168.99.90',
        port: 22,
        username: 'root',
        authType: 'password',
        connected: true,
        agentCommandTrust: 'full',
        agentCommandAutoApprove: true
      },
      {
        id: 'af238298-adfa-4948-9aad-fa96e5aa17c3',
        label: '99.92',
        host: '192.168.99.92',
        port: 22,
        username: 'root',
        authType: 'password',
        connected: true,
        agentCommandTrust: 'full',
        agentCommandAutoApprove: true
      }
    ]
  },
  attemptCount: 1,
  durationMs: 11
});
```

---

### Task 1: 拆 Hub 信封 + Purpose + 生产夹具解析

**Files:**
- Modify: `src/webview-chat/store-helpers.ts`（`ParsedToolPreview`、`parseToolOutputPreview`；新增 `unwrapHubPayload`、`parseCommandPurpose`）
- Test: `test/webview-chat.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `test/webview-chat.test.ts` 现有 `parseToolOutputPreview` 那个 `it` **后面**追加 `describe`（保留旧扁平用例作回归）：

```typescript
describe('parseToolOutputPreview 生产信封（2026-09-01）', () => {
  const SCREENSHOT_ENVELOPE = JSON.stringify({
    ok: true,
    result: {
      serverId: '4d1fbefc-aeef-42e9-9008-62c04915affe',
      serverLabel: '99.90',
      host: '192.168.99.90',
      command: 'hostname',
      exitCode: 0,
      stdout: 'cl\n',
      stderr: '',
      durationMs: 258,
      timedOut: false,
      truncated: false
    },
    attemptCount: 1,
    durationMs: 261
  });

  it('截图夹具：从 result.* 取 host/command/stdout，不把信封当 stdout', () => {
    const parsed = parseToolOutputPreview(SCREENSHOT_ENVELOPE);
    expect(parsed.hostLabel).toBe('99.90');
    expect(parsed.hostAddr).toBe('192.168.99.90');
    expect(parsed.command).toBe('hostname');
    expect(parsed.commandBody).toBe('hostname');
    expect(parsed.stdout).toBe('cl\n');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).not.toContain('"ok"');
    expect(parsed.stdout).not.toContain('attemptCount');
  });

  it('Purpose：inputPreview 含 # Purpose: 时标题字段与正文分离；end 信封不冲掉 Purpose', () => {
    const input = JSON.stringify({
      serverId: 's1',
      command: '# Purpose: 检查磁盘\ndf -h'
    });
    const parsed = parseToolOutputPreview(SCREENSHOT_ENVELOPE.replace('"hostname"', '"df -h"'), input);
    expect(parsed.purpose).toBe('检查磁盘');
    expect(parsed.commandBody).toBe('df -h');
    expect(parsed.stdout).toBe('cl\n');
  });

  it('全角冒号 Purpose 也能解析', () => {
    expect(parseCommandPurpose('# Purpose：备份配置\ncp a b')).toEqual({
      purpose: '备份配置',
      body: 'cp a b'
    });
  });

  it('result 为对象且无 string stdout 时 stdout 为空，禁止 JSON.stringify(result)', () => {
    const parsed = parseToolOutputPreview(
      JSON.stringify({ ok: true, result: { servers: [{ label: '99.90' }] }, attemptCount: 1 })
    );
    expect(parsed.stdout).toBeUndefined();
    expect(parsed.payload).toEqual({ servers: [{ label: '99.90' }] });
  });
});
```

并从 `store-helpers` 的 import 列表加上 `parseCommandPurpose`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview-chat.test.ts -t "生产信封"`

Expected: FAIL（`parseCommandPurpose` 未导出，和/或 `hostLabel` 为 undefined，`stdout` 为整段 JSON）。

- [ ] **Step 3: Implement unwrap + parse**

在 `src/webview-chat/store-helpers.ts` 替换 `ParsedToolPreview` / `parseToolOutputPreview`，并新增两个导出。不要删旧扁平路径。

```typescript
export function unwrapHubPayload(raw: unknown): {
  payload: unknown;
  envelopeOk?: boolean;
  attemptCount?: number;
  envelopeDurationMs?: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { payload: raw };
  }
  const rec = asRecord(raw);
  if (typeof rec.ok === 'boolean' && 'result' in rec) {
    return {
      payload: rec.result,
      envelopeOk: rec.ok,
      attemptCount: typeof rec.attemptCount === 'number' ? rec.attemptCount : undefined,
      envelopeDurationMs: typeof rec.durationMs === 'number' ? rec.durationMs : undefined
    };
  }
  return { payload: raw };
}

const PURPOSE_LINE = /^\s*#\s*Purpose\s*[:：]\s*(.+?)\s*$/i;

export function parseCommandPurpose(command: string): { purpose?: string; body: string } {
  const lines = command.split('\n');
  let purpose: string | undefined;
  const body: string[] = [];
  for (const line of lines) {
    const m = line.match(PURPOSE_LINE);
    if (m) {
      if (!purpose) purpose = m[1].trim();
      continue;
    }
    body.push(line);
  }
  return { purpose, body: body.join('\n').trim() };
}

function pickStr(rec: AnyRecord, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function pickNum(rec: AnyRecord, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function fieldsFromPayload(payload: unknown): Partial<ParsedToolPreview> {
  if (typeof payload === 'string') {
    return { stdout: payload };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const rec = asRecord(payload);
  const command = pickStr(rec, ['command', 'script', 'query', 'cmd']);
  const stdout =
    typeof rec.stdout === 'string'
      ? rec.stdout
      : typeof rec.output === 'string'
        ? rec.output
        : undefined;
  const stderr = typeof rec.stderr === 'string' ? rec.stderr : undefined;
  return {
    command,
    hostLabel: pickStr(rec, ['serverLabel', 'serverName', 'label', 'server']),
    hostAddr: pickStr(rec, ['host', 'ip', 'target']),
    exitCode: pickNum(rec, ['exitCode', 'code']),
    stdout,
    stderr
  };
}

function parseJsonBlob(raw: string): unknown | undefined {
  const t = raw.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export interface ParsedToolPreview {
  command?: string;
  commandBody?: string;
  purpose?: string;
  hostLabel?: string;
  hostAddr?: string;
  /** @deprecated 等于 hostLabel，兼容旧调用 */
  serverName?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  rawText: string;
  payload?: unknown;
  envelopeOk?: boolean;
  attemptCount?: number;
}

export function parseToolOutputPreview(
  preview: string | undefined | null,
  inputPreview?: string | undefined | null
): ParsedToolPreview {
  const raw = String(preview ?? '').trim();
  const inputRaw = String(inputPreview ?? '').trim();
  const outJson = parseJsonBlob(raw);
  const inJson = parseJsonBlob(inputRaw);

  const outUnwrapped = outJson !== undefined ? unwrapHubPayload(outJson) : undefined;
  const inUnwrapped = inJson !== undefined ? unwrapHubPayload(inJson) : undefined;

  const fromInput = inUnwrapped ? fieldsFromPayload(inUnwrapped.payload) : {};
  const fromOutput = outUnwrapped ? fieldsFromPayload(outUnwrapped.payload) : {};

  // 非 JSON preview（tool/update 流式文本）当作 stdout
  const streamingStdout = outJson === undefined && raw ? raw : undefined;

  const command = fromOutput.command ?? fromInput.command;
  const purposeSource = [fromInput.command, fromOutput.command]
    .filter((s): s is string => Boolean(s))
    .join('\n');
  const parsedPurpose = purposeSource ? parseCommandPurpose(purposeSource) : undefined;
  const hostLabel = fromOutput.hostLabel ?? fromInput.hostLabel;
  const hostAddr = fromOutput.hostAddr ?? fromInput.hostAddr;
  const stdout = fromOutput.stdout ?? streamingStdout;
  const stderr = fromOutput.stderr ?? fromInput.stderr;
  const exitCode = fromOutput.exitCode ?? fromInput.exitCode;

  // 纯文本旧夹具：无 JSON 且无 inputPreview → 首行当命令（回归 toolCallHeadline）
  let fallbackCommand = command;
  if (!fallbackCommand && !inputRaw && raw && outJson === undefined) {
    fallbackCommand = raw.split('\n')[0].trim();
  }
  const commandForPurpose = fallbackCommand ?? '';
  const { purpose, body } = parsedPurpose ?? parseCommandPurpose(commandForPurpose);

  const payload = outUnwrapped?.payload ?? inUnwrapped?.payload;

  return {
    command: fallbackCommand,
    commandBody: body || undefined,
    purpose,
    hostLabel,
    hostAddr,
    serverName: hostLabel,
    exitCode,
    stdout,
    stderr,
    rawText: raw,
    payload,
    envelopeOk: outUnwrapped?.envelopeOk,
    attemptCount: outUnwrapped?.attemptCount
  };
}
```

删除（或改为转调 `parseToolOutputPreview`）旧的 `extractPreviewCommand` / `extractPreviewServer` 私有函数——下一任务 headline 改走 `parseToolOutputPreview`。本任务若仍被 headline 调用，先让它们改为：

```typescript
function extractPreviewCommand(preview: string | undefined | null): string {
  const p = parseToolOutputPreview(preview);
  return p.commandBody || p.command || '';
}
function extractPreviewServer(preview: string | undefined | null): string {
  return parseToolOutputPreview(preview).hostLabel || '';
}
```

注意：`fieldsFromPayload` **不要**再把对象型 `result` 当 `stdout`。`typeof rec.result === 'string'` 只应在 **未拆信封的扁平对象** 上作为 stdout 候选；拆完之后不要用。扁平 `{result:"ok"}` 仍走 `unwrap` 失败 → `fieldsFromPayload` 顶层：仅当 `result` 为 string 时当作 stdout。在 `fieldsFromPayload` 里可加：`typeof rec.result === 'string' && stdout === undefined` 则 `stdout = rec.result`。截图信封拆完 payload 没有顶层 `result`，不会误伤。

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/webview-chat.test.ts -t "parseToolOutputPreview"`

Expected: PASS（含旧扁平用例与新生产信封）。

- [ ] **Step 5: Commit**

```bash
git add src/webview-chat/store-helpers.ts test/webview-chat.test.ts
git commit -m "$(cat <<'EOF'
fix: unwrap hub envelope in tool preview parser

EOF
)"
```

---

### Task 2: 标题改为「主机 · Purpose/意图」

**Files:**
- Modify: `src/webview-chat/store-helpers.ts`（`toolCallHeadline`）
- Test: `test/webview-chat.test.ts`（`ToolCallCard 标题意图` describe）

新公式（spec §3.1）：`hostLabel · (purpose || intent)`；无主机则只显示 purpose/intent；两者都没有才回退 `call.name`。命令正文不再塞进标题（命令在第二行）。

- [ ] **Step 1: Update tests to the new formula (they should fail)**

改 `describe('ToolCallCard 标题意图…')` 中的期望：

```typescript
expect(toolCallHeadline({ name: 'run_remote_command', preview: 'df -h' })).toBe('磁盘');
expect(toolCallHeadline({
  name: 'run_remote_command',
  preview: JSON.stringify({ command: 'docker ps -a', serverName: 'prod-gw-01' })
})).toBe('prod-gw-01 · 容器');
expect(toolCallHeadline({ name: 'list_ssh_servers' })).toBe('SSH 目标');
expect(toolCallHeadline({ name: 'run_remote_command', preview: SCREENSHOT_ENVELOPE })).toBe(
  '99.90 · 主机'
);
expect(toolCallHeadline({
  name: 'run_remote_command',
  preview: SCREENSHOT_ENVELOPE,
  inputPreview: JSON.stringify({ command: '# Purpose: 检查磁盘\ndf -h' })
})).toBe('99.90 · 检查磁盘');
expect(toolCallHeadline({ name: 'run_remote_command', preview: '{"result":"ok"}' })).toBe(
  'run_remote_command'
);
```

把 `toolCallHeadline` 的参数类型改为 `Pick<ToolCallView, 'name' | 'preview' | 'inputPreview'>`（`inputPreview` 在 Task 3 才进类型——若 Task 2 先做，先在 Pick 里用可选交叉：`Pick<ToolCallView, 'name' | 'preview'> & { inputPreview?: string }`）。

同步改「工具卡复制文本是 headline」那个 it：`preview: 'df -h\nFilesystem...'` 时期望 headline 为 `'磁盘'`，且不含 `Filesystem`。

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/webview-chat.test.ts -t "标题意图"`

Expected: FAIL，实际仍是 `磁盘 · df -h` 或 `run_remote_command`。

- [ ] **Step 3: Implement headline**

```typescript
export function toolCallHeadline(
  call: Pick<ToolCallView, 'name' | 'preview'> & { inputPreview?: string }
): string {
  const parsed = parseToolOutputPreview(call.preview, call.inputPreview);
  const command = parsed.commandBody || parsed.command || '';
  const lead = leadingCommandWord(command) || call.name;
  const intent = COMMAND_INTENT_ZH[lead] ?? COMMAND_INTENT_ZH[call.name];
  const purposeOrIntent = parsed.purpose || intent;
  const host = parsed.hostLabel || '';
  if (host && purposeOrIntent) return `${host} · ${purposeOrIntent}`;
  if (host) return `${host} · ${call.name}`;
  if (purposeOrIntent) return purposeOrIntent;
  return call.name;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/webview-chat.test.ts -t "toolCallHeadline|标题意图|复制文本"`

Expected: PASS。全文件若有其它 headline 断言一并修好。

- [ ] **Step 5: Commit**

```bash
git add src/webview-chat/store-helpers.ts test/webview-chat.test.ts
git commit -m "$(cat <<'EOF'
feat: tool card headline uses host and purpose

EOF
)"
```

---

### Task 3: 冻结 `inputPreview`，update/end 不得覆盖

**Files:**
- Modify: `src/protocol/host-protocol.ts`（`ToolCallView`）
- Modify: `docs/schemas/host-protocol.ts`（同步）
- Modify: `src/host/services/runtimeEvents.ts`
- Modify: `src/webview-chat/store.ts`（`pickToolCall` keys）
- Modify: `src/runtime/subagent-transcript.ts`（start 写入 `inputPreview`，end 展开保留）
- Test: `test/runtime-events.test.ts`
- Test: `test/webview-chat.test.ts`（可选：parse 已覆盖 Purpose 冻结；本任务测 host 事件）

- [ ] **Step 1: Write failing runtime-events test**

在 `test/runtime-events.test.ts` 的 `tool_start 携带 preview…` 用例末尾（或新 it）断言：

```typescript
it('tool_start 冻结 inputPreview；update/end 只改 preview', () => {
  const { router, store, sid } = fakeRouter();
  const argsJson = JSON.stringify({
    command: '# Purpose: 查看负载\nuptime',
    serverId: 's1'
  });
  router.route(sid, {
    type: 'tool_start',
    id: 'tool-keep',
    name: 'run_remote_command',
    preview: argsJson
  });
  router.route(sid, {
    type: 'tool_update',
    id: 'tool-keep',
    name: 'run_remote_command',
    preview: '09:48 up 42 days'
  });
  router.route(sid, {
    type: 'tool_end',
    id: 'tool-keep',
    name: 'run_remote_command',
    ok: true,
    preview: SCREENSHOT_ENVELOPE
  });
  const item = store.findItem('tool-keep', sid);
  expect(item?.kind).toBe('tool');
  if (item?.kind === 'tool') {
    expect(item.call.inputPreview).toBe(argsJson);
    expect(item.call.preview).toBe(SCREENSHOT_ENVELOPE);
  }
});
```

（把 `SCREENSHOT_ENVELOPE` 常量写在该 describe 内。）

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/runtime-events.test.ts -t "inputPreview"`

Expected: FAIL，`inputPreview` undefined。

- [ ] **Step 3: Protocol + host + store + subagent**

`ToolCallView` 增加：

```typescript
  preview?: string;
  /** tool/start 的 args JSON；update/end 不得覆盖。 */
  inputPreview?: string;
```

`docs/schemas/host-protocol.ts` 同样加 `inputPreview?: string`。

`runtimeEvents.ts` `tool_start`：

```typescript
const call: ToolCallView = {
  name: e.name,
  pluginId: descriptor?.pluginId,
  risk: resolveToolRisk(e.name, descriptor),
  status: 'running',
  preview: e.preview,
  inputPreview: e.preview,
  startedAt
};
```

`tool_update` / `tool_end` 继续只补 `preview`（spread `item.call` 会保留 `inputPreview`）。**不要**写 `inputPreview: e.preview` 或 `inputPreview: undefined`。

`store.ts` `pickToolCall` 的 keys 数组加入 `'inputPreview'`。

`subagent-transcript.ts` `startSubagentTool`：

```typescript
const toolCall: ToolCallView = {
  name: initial.name,
  pluginId: initial.pluginId,
  risk: initial.risk ?? 'exec',
  status: 'running',
  preview: initial.preview,
  inputPreview: initial.preview,
  startedAt: initial.startedAt ?? Date.now()
};
```

`endSubagentTool` 已 `...it.call`，会保留 `inputPreview`，不要在新 `call` 里显式清空。

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/runtime-events.test.ts test/subagent-transcript.test.ts test/webview-chat.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/protocol/host-protocol.ts docs/schemas/host-protocol.ts \
  src/host/services/runtimeEvents.ts src/webview-chat/store.ts \
  src/runtime/subagent-transcript.ts test/runtime-events.test.ts
git commit -m "$(cat <<'EOF'
feat: freeze tool inputPreview across update and end

EOF
)"
```

---

### Task 4: 数据工具结构化视图（纯函数）

**Files:**
- Modify: `src/webview-chat/store-helpers.ts`（新增 `classifyToolDataView` 等）
- Test: `test/webview-chat.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('classifyToolDataView', () => {
  it('list_ssh_servers 信封 → servers 视图，含两台 label', () => {
    const parsed = parseToolOutputPreview(LIST_SSH_ENVELOPE);
    const view = classifyToolDataView(parsed.payload);
    expect(view.kind).toBe('servers');
    if (view.kind === 'servers') {
      expect(view.servers.map((s) => s.label)).toEqual(['99.90', '99.92']);
      expect(view.servers[0].host).toBe('192.168.99.90');
      expect(view.servers[0].port).toBe(22);
      expect(view.servers[0].connected).toBe(true);
      expect(view.servers[0].trust).toBe('full');
      expect(view.servers[0].autoApprove).toBe(true);
    }
  });

  it('普通对象 → kv，不含 ok/attemptCount 外壳', () => {
    const parsed = parseToolOutputPreview(
      JSON.stringify({ ok: true, result: { job: 'api', build: 12 }, attemptCount: 1 })
    );
    const view = classifyToolDataView(parsed.payload);
    expect(view.kind).toBe('kv');
    if (view.kind === 'kv') {
      expect(view.entries.map((e) => e.key)).toEqual(['job', 'build']);
    }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/webview-chat.test.ts -t "classifyToolDataView"`

Expected: FAIL，`classifyToolDataView` is not a function。

- [ ] **Step 3: Implement**

```typescript
export type ToolServerRow = {
  id?: string;
  label: string;
  host: string;
  port?: number;
  username?: string;
  connected: boolean;
  trust?: string;
  autoApprove?: boolean;
};

export type ToolDataView =
  | { kind: 'servers'; servers: ToolServerRow[] }
  | { kind: 'table'; columns: string[]; rows: Record<string, unknown>[] }
  | { kind: 'kv'; entries: { key: string; value: unknown }[] }
  | { kind: 'json'; text: string };

function asServerRow(raw: unknown): ToolServerRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = asRecord(raw);
  const label = pickStr(rec, ['label', 'serverLabel', 'name']) ?? '';
  const host = pickStr(rec, ['host', 'ip']) ?? '';
  if (!label && !host) return undefined;
  return {
    id: pickStr(rec, ['id']),
    label: label || host,
    host: host || label,
    port: pickNum(rec, ['port']),
    username: pickStr(rec, ['username', 'user']),
    connected: rec.connected === true,
    trust: pickStr(rec, ['agentCommandTrust', 'trust']),
    autoApprove: rec.agentCommandAutoApprove === true
  };
}

export function classifyToolDataView(payload: unknown): ToolDataView {
  if (Array.isArray(payload) && payload.length && payload.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    const rows = payload.map((x) => asRecord(x));
    const colSet = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) colSet.add(k);
    const columns = [...colSet].filter((c) => !/^id$|^uuid$/i.test(c));
    return { kind: 'table', columns, rows };
  }
  if (payload && typeof payload === 'object') {
    const rec = asRecord(payload);
    if (Array.isArray(rec.servers)) {
      const servers = rec.servers.map(asServerRow).filter((s): s is ToolServerRow => Boolean(s));
      if (servers.length) return { kind: 'servers', servers };
    }
    return { kind: 'kv', entries: Object.keys(rec).map((key) => ({ key, value: rec[key] })) };
  }
  try {
    return { kind: 'json', text: JSON.stringify(payload, null, 2) ?? '' };
  } catch {
    return { kind: 'json', text: String(payload) };
  }
}

export function formatKvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
```

`formatDataOutputPreview` 保留给 JSON 回退；数据卡主路径改走 `classifyToolDataView`。普通对象一律 kv，嵌套值用 `formatKvCell` 压成字符串。

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/webview-chat.test.ts -t "classifyToolDataView"`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/webview-chat/store-helpers.ts test/webview-chat.test.ts
git commit -m "$(cat <<'EOF'
feat: classify unwrapped tool payloads into structured views

EOF
)"
```

---

### Task 5: ToolCallCard 三行叠栏 + 数据面板

**Files:**
- Modify: `src/webview-chat/components/ToolCallCard.vue`
- Modify: `src/webview-chat/i18n.ts`
- Test: `test/webview-chat.test.ts`（源码引用断言；vitest 不 mount Vue）

- [ ] **Step 1: Write failing source + i18n tests**

```typescript
it('ToolCallCard：三行叠栏 class 与 inputPreview 解析', () => {
  const card = readFileSync(
    path.join(process.cwd(), 'src/webview-chat/components/ToolCallCard.vue'),
    'utf8'
  );
  expect(card).toContain('inputPreview');
  expect(card).toContain('commandBody');
  expect(card).toContain('cmdExpanded');
  expect(card).toContain('tool__cmd-toggle');
  expect(card).toContain('classifyToolDataView');
  expect(card).toContain('tool__host-row');
  expect(card).not.toContain('props.call.pluginId');
});

it('数据工具 i18n zh/en 齐备', () => {
  setLocale('zh-cn');
  expect(t('toolTrust')).toBe('信任 {trust}');
  expect(t('toolAutoApprove')).toBe('自动批准');
  expect(t('toolNeedApprove')).toBe('需批准');
  expect(tf('toolServerCount', { count: 2 })).toBe('2 台');
  setLocale('en');
  expect(t('toolAutoApprove')).toBe('auto-approve');
  expect(tf('toolServerCount', { count: 2 })).toBe('2 hosts');
});
```

把旧的 `ToolCallCard：分离命令卡` it 里对 `tool__cmd-bar` 的断言保留（命令行还在）。

`expect(card).not.toContain('props.call.pluginId')` 太脆（注释/title 可能仍引用）。改为：

```typescript
expect(card).not.toMatch(/class="tool__plugin[^"]*"[^>]*>\{\{\s*props\.call\.pluginId/);
```

或直接断言标题区不再渲染 `{{ props.call.pluginId }}`：`expect(card).not.toContain('class="tool__plugin')`。

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/webview-chat.test.ts -t "三行叠栏|数据工具 i18n"`

Expected: FAIL。

- [ ] **Step 3: i18n keys**

在 `src/webview-chat/i18n.ts` 的 `zhCN` 与 `en` **同一位置**（`toolDataPreview` 旁）增加：

```typescript
  toolTrust: '信任 {trust}',
  toolAutoApprove: '自动批准',
  toolNeedApprove: '需批准',
  toolServerCount: '{count} 台',
```

```typescript
  toolTrust: 'trust {trust}',
  toolAutoApprove: 'auto-approve',
  toolNeedApprove: 'approval required',
  toolServerCount: '{count} hosts',
```

两份对象键必须齐全，否则 `OpsMessageKey` 对不上。

- [ ] **Step 4: ToolCallCard.vue**

**script：**

- import 增加 `classifyToolDataView`, `formatKvCell`, `parseCommandPurpose`（若只需 parsed 则不必）。
- `parseToolOutputPreview(props.call.preview, props.call.inputPreview)`。
- `commandText` = `parsed.command`（原始，供复制）。
- `commandBody` = `parsed.commandBody || parsed.command || ''`（展示）。
- `hostLabel` / `purpose` 来自 parsed。
- `headline` 仍走 `toolCallHeadline(props.call)`（已含 inputPreview）。
- `cmdExpanded = ref(true)`（方案 A）。
- `displayOutput`：**命令类**只用 stdout/stderr，禁止 fallback 整段 `rawText`：

```typescript
const displayOutput = computed(() => {
  if (isCommand.value) {
    const out = parsed.value.stdout ?? '';
    const err = (parsed.value.stderr ?? '').trim();
    const merged = err ? (out ? `${out.replace(/\n$/, '')}\n\n${err}` : err) : out;
    return merged.slice(0, PREVIEW_CAP);
  }
  const content = parsed.value.stdout ?? (parsed.value.rawText !== parsed.value.command ? parsed.value.rawText : '');
  return content.slice(0, PREVIEW_CAP);
});
```

- `dataView = computed(() => classifyToolDataView(parsed.value.payload))`。
- `copyCommand` 复制 `commandText`（原始命令，含 Purpose 行）。
- `tool__head` 的 `:title` 设为 `[pluginId, hostAddr].filter(Boolean).join(' · ')`。
- 去掉模板里 `tool__plugin` 那一 span。
- 标题 `{{ headline }}` 已是「99.90 · 主机」；不要再单独塞命令。

**template 命令分支：**

```vue
<template v-if="isCommand">
  <div v-if="commandBody" class="tool__cmd-bar">
    <button
      type="button"
      class="tool__cmd-toggle"
      :aria-expanded="cmdExpanded"
      @click.stop="cmdExpanded = !cmdExpanded"
    >
      <span class="codicon" :class="cmdExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'"></span>
    </button>
    <span class="tool__cmd-prompt ops-mono">$</span>
    <span
      class="tool__cmd-text ops-mono"
      :class="{ 'tool__cmd-text--wrap': cmdExpanded }"
      :title="commandText"
    >{{ commandBody }}</span>
    <!-- 现有 copy 按钮，@click.stop="copyCommand" -->
  </div>
  <TerminalViewer
    class="tool__term-viewer"
    :text="displayOutput"
    :is-running="isRunning"
    :running-hint="runningHint"
    :exit-code="parsed.exitCode"
    :uri="props.call.artifactUri"
    :truncated="clipped"
  />
</template>
```

`runningHint` 继续用 `hostLabel`。

**template 数据分支（替换 `formattedDataOutput` 的单一 `<pre>`）：**

```vue
<div v-if="dataView.kind === 'servers'" class="tool__data-list">
  <div
    v-for="row in dataView.servers"
    :key="row.id || row.host"
    class="tool__host-row"
    :title="row.id"
  >
    <div class="tool__host-row__top">
      <span class="tool__host-dot" :class="row.connected ? 'tool__host-dot--on' : 'tool__host-dot--off'"></span>
      <span class="tool__host-label ops-mono">{{ row.label }}</span>
      <span class="ops-mono">{{ row.host }}<template v-if="row.port">:{{ row.port }}</template></span>
      <span class="ops-muted">{{ row.username }}</span>
    </div>
    <div class="ops-muted tool__host-row__meta">
      {{ row.connected ? t('connected') : t('disconnected') }}
      <template v-if="row.trust"> · {{ tf('toolTrust', { trust: row.trust }) }}</template>
      · {{ row.autoApprove ? t('toolAutoApprove') : t('toolNeedApprove') }}
    </div>
  </div>
</div>
<div v-else-if="dataView.kind === 'table'" class="tool__data-table-wrap">
  <!-- table: columns / rows, cells via formatKvCell -->
</div>
<div v-else-if="dataView.kind === 'kv'" class="tool__kv">
  <div v-for="e in dataView.entries" :key="e.key" class="tool__kv-row">
    <span class="tool__kv-k ops-muted">{{ e.key }}</span>
    <span class="tool__kv-v ops-mono">{{ formatKvCell(e.value) }}</span>
  </div>
</div>
<pre v-else class="ops-codeblock tool__data-code ops-mono">{{ dataView.text }}</pre>
```

数据标题旁可显示 `tf('toolServerCount', { count: dataView.servers.length })`（仅 servers）。

**style：**

- `.tool__cmd-text--wrap { white-space: pre-wrap; word-break: break-all; overflow: visible; }`
- 默认 `.tool__cmd-text` 去掉强制 nowrap ellipsis，或仅在 `!cmdExpanded` 时 ellipsis（class 绑定）。
- `.tool__host-row` 对齐现有密度：padding 6–8px，border `var(--ops-border)`，圆点 7px，`--ops-healthy` / `--ops-pending`。
- `.tool__cmd-toggle` 透明按钮，勿嵌套在整卡 head 的 click 里（已在 body）。

错误面板保持在 `expanded` 模板底部，不动。

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/webview-chat.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/webview-chat/components/ToolCallCard.vue src/webview-chat/i18n.ts test/webview-chat.test.ts
git commit -m "$(cat <<'EOF'
feat: render command cards in three stacked rows

EOF
)"
```

---

### Task 6: 类型检查、全量测试、webview bundle

**Files:** 本特性全部改动。

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`

Expected: 0 errors。`ToolCallView` 的 `inputPreview` 若还有构造点漏加，按可选字段处理即可。

- [ ] **Step 2: full unit tests**

Run: `npm test`

Expected: 全部绿。若旧测试仍期望 `磁盘 · df -h`，回到 Task 2 修期望，不要把解析改回扁平假数据。

- [ ] **Step 3: compile webview**

Run: `npm run compile:webview`

Expected: `esbuild.webview.mjs` 成功写出 chat webview bundle（无 error）。**不跑这一步，扩展里仍是旧 JS，界面会再表现为「没生效」。**

- [ ] **Step 4: 对照 spec §9 自检**

用截图信封在脑中过一遍（或 mock-host）：

- 标题是 `99.90 · 主机`（或带 Purpose），不是 `run_remote_command`
- 展开后第二行 `$ hostname`
- 终端是 `cl`，不是 1 行 JSON
- `list_ssh_servers` 是两行主机卡

- [ ] **Step 5: Commit**（若 Step 1–3 还改了文件）

```bash
git add -u
git commit -m "$(cat <<'EOF'
chore: typecheck and compile webview after tool card redesign

EOF
)"
```

无改动则跳过空提交。

---

## Spec coverage (self-review)

| Spec | Task |
|------|------|
| §1 生产信封 / 禁止扁平主路径 | Task 1 夹具 |
| §3.1 标题主机+Purpose，pluginId 不进正文 | Task 2 + Task 5 |
| §3.2 命令可折、默认展开、复制原始命令 | Task 5 |
| §3.3 终端只吃 stdout/stderr | Task 1 + Task 5 `displayOutput` |
| §3.4 整卡折叠默认 | 不改现有 `expanded` 逻辑 |
| §4.1 inputPreview | Task 3 |
| §4.2 unwrap | Task 1 |
| §4.3 Purpose 正则 | Task 1 |
| §5.1 list_ssh_servers 卡片 | Task 4 + 5 |
| §5.2 kv/table/json 回退 | Task 4 + 5 |
| §6 协议双份 | Task 3 |
| §7 错误条保留 | Task 5 不删 `tool__error` |
| §8 测试合同 | Task 1–4 |
| §9 `compile:webview` | Task 6 |

无 TBD。`classifyToolDataView`：先识别对象数组表格，再识别 `servers`，其余对象走 kv。
