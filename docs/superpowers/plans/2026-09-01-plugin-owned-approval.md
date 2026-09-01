# Plugin-Owned Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 MCP 路径已经会弹确认的 AT 插件 write/exec，Agent 不再弹出 9 要素简报；Database / 第三方 MCP / `ops_write_ops_doc` 仍走人审；删掉名不副实的 `dedupePluginModal`。

**Architecture:** 纯函数 `toolConfirmsInPlugin(pluginId, toolName)` 做过渡 allowlist（本期不改各插件 catalog）。`evaluatePolicy` 在 write/exec 人审前若命中 allowlist 则 `allow()`；Executor 无 token 时同样放行这些工具，无窗工具仍 `OPS_APPROVAL_REQUIRED`。`buildTaskSpec` 不再强制 Executor 带 briefId。`approvalService` 只把 `pluginId` 继续传入（已有），policy 自己判。设置项删除；`dualConfirmHint` 恒为 false。

**Tech Stack:** TypeScript、Vitest、VS Code configuration contribution。

**Spec:** [`docs/superpowers/specs/2026-09-01-message-edit-and-plugin-owned-approval-design.md`](../specs/2026-09-01-message-edit-and-plugin-owned-approval-design.md) 需求 B。

**Working directory:** `at-opsAgent/`（所有命令在此目录执行）。

**Hub 描述符 `confirmsInPlugin`：** 本期不做。`toolConfirmsInPlugin` 已预留 `declared?: boolean`；插件 catalog 以后要标再接线。

**File map:**

| File | Responsibility |
|------|----------------|
| `src/policy/pluginConfirm.ts` | allowlist + `toolConfirmsInPlugin` |
| `src/policy/index.ts` | `evaluatePolicy` 跳过插件已确认工具的会话简报 |
| `src/runtime/subagents.ts` | Executor 派发不再强制 `approvalToken` |
| `src/host/services/approvalNotify.ts` | `dualConfirmHint: false` |
| settings / `package.json` / nls | 删除 `dedupePluginModal` |
| `src/prompts/layers.ts` / `roles.ts` | 模型不再被要求给 Terminal 出简报 |
| `docs/07-security.md` / `docs/05-ui-system.md` | 文档与代码一致 |

---

### Task 1: `toolConfirmsInPlugin` allowlist

**Files:**
- Create: `src/policy/pluginConfirm.ts`
- Modify: `src/policy/index.ts`（re-export）
- Test: `test/policy.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `test/policy.test.ts` 现有 import 中增加 `toolConfirmsInPlugin`，文件末尾追加：

```typescript
describe('policy · toolConfirmsInPlugin', () => {
  it('at.terminal 远程命令与 SFTP 写命中；只读 SFTP 不命中', () => {
    expect(toolConfirmsInPlugin('at.terminal', 'run_remote_command')).toBe(true);
    expect(toolConfirmsInPlugin('at.terminal', 'at.terminal/run_remote_command')).toBe(true);
    expect(toolConfirmsInPlugin('at.terminal', 'sftp_write_file')).toBe(true);
    expect(toolConfirmsInPlugin('at.terminal', 'sftp_delete')).toBe(true);
    expect(toolConfirmsInPlugin('at.terminal', 'sftp_read_file')).toBe(false);
    expect(toolConfirmsInPlugin('at.terminal', 'list_ssh_servers')).toBe(false);
  });

  it('JumpServer 命令/SQL/Redis/SFTP 写命中', () => {
    expect(toolConfirmsInPlugin('at.jumpserver', 'jumpserver_run_terminal_command')).toBe(true);
    expect(toolConfirmsInPlugin('at.jumpserver', 'jumpserver_mysql_execute_sql')).toBe(true);
    expect(toolConfirmsInPlugin('at.jumpserver', 'jumpserver_redis_execute_command')).toBe(true);
    expect(toolConfirmsInPlugin('at.jumpserver', 'jumpserver_sftp_write_file')).toBe(true);
    expect(toolConfirmsInPlugin('at.jumpserver', 'jumpserver_list_assets')).toBe(false);
  });

  it('Nacos 写工具名命中；Database 永不命中', () => {
    expect(toolConfirmsInPlugin('at.nacos', 'nacos_publish_config')).toBe(true);
    expect(toolConfirmsInPlugin('at.nacos', 'nacos_delete_config')).toBe(true);
    expect(toolConfirmsInPlugin('at.database', 'database_update_rows')).toBe(false);
    expect(toolConfirmsInPlugin('at.database', 'run_remote_command')).toBe(false);
  });

  it('显式 flag 覆盖 allowlist', () => {
    expect(toolConfirmsInPlugin('unknown', 'weird_write', true)).toBe(true);
    expect(toolConfirmsInPlugin('at.terminal', 'run_remote_command', false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/policy.test.ts`

Expected: FAIL — `toolConfirmsInPlugin` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/policy/pluginConfirm.ts`:

```typescript
/** 工具名最后一段（容忍 `at.terminal/run_remote_command`）。 */
export function toolBareName(toolName: string): string {
  const slash = toolName.lastIndexOf('/');
  return slash >= 0 ? toolName.slice(slash + 1) : toolName;
}

/**
 * MCP 路径会由插件自己弹确认（或按信任档自动放行）的工具。
 * at.database 永不进入此表——其 MCP 写无弹窗，必须走 Agent 简报。
 */
const PLUGIN_CONFIRMED_TOOLS = new Set<string>([
  'run_remote_command',
  'sftp_write_file',
  'sftp_create_file',
  'sftp_create_directory',
  'sftp_rename',
  'sftp_delete',
  'jumpserver_run_terminal_command',
  'jumpserver_send_terminal_input',
  'jumpserver_sftp_write_file',
  'jumpserver_sftp_create_file',
  'jumpserver_sftp_create_directory',
  'jumpserver_sftp_rename',
  'jumpserver_sftp_delete',
  'jumpserver_mysql_execute_sql',
  'jumpserver_redis_execute_command',
  'nacos_publish_config',
  'nacos_delete_config',
  'nacos_rollback_config',
  'nacos_update_instance_health'
]);

/**
 * @param declared 来自 Hub 描述符的显式标记；true/false 覆盖 allowlist；缺省走表。
 */
export function toolConfirmsInPlugin(
  pluginId: string | undefined,
  toolName: string,
  declared?: boolean
): boolean {
  if (declared === true) return true;
  if (declared === false) return false;
  if (pluginId === 'at.database') return false;
  return PLUGIN_CONFIRMED_TOOLS.has(toolBareName(toolName));
}
```

在 `src/policy/index.ts` 顶部附近增加：

```typescript
export { toolBareName, toolConfirmsInPlugin } from './pluginConfirm';
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/policy.test.ts`

Expected: PASS（含新 describe）。

- [ ] **Step 5: Commit**

```bash
git add src/policy/pluginConfirm.ts src/policy/index.ts test/policy.test.ts
git commit -m "$(cat <<'EOF'
feat(policy): allowlist tools whose plugin already confirms

Agent should not add a second human gate for Terminal/JumpServer/Nacos
MCP writes; Database stays off the list because its MCP path has no modal.
EOF
)"
```

---

### Task 2: `evaluatePolicy` 跳过插件已确认工具的会话简报

**Files:**
- Modify: `src/policy/index.ts`（`evaluatePolicy` write/exec 段，约 575–618 行）
- Test: `test/policy.test.ts`（改现有「nacos 需要审批」用例 + 新增）

- [ ] **Step 1: Write the failing tests**

把 `policy · 会话审批` 里这一条：

```typescript
it('write-exec 策略下主会话 write 需要审批；exec-only 下普通 write 不需要', async () => {
  const write = ctx({ toolName: 'nacos_publish_config', pluginId: 'at.nacos', risk: 'write' });
```

改成用**不在 allowlist** 的写工具（否则 Task 3 落地后这条会绿错语义）：

```typescript
it('write-exec 策略下主会话 write 需要审批；exec-only 下普通 write 不需要', async () => {
  const write = ctx({ toolName: 'unknown_write_tool', pluginId: 'third.party', risk: 'write' });
  const underWriteExec = await evaluatePolicy(write);
  expect(!underWriteExec.block && underWriteExec.needSessionApproval).toBe(true);

  const underExecOnly = await evaluatePolicy({ ...write, sessionRequiredFor: 'exec-only' });
  expect(underExecOnly).toEqual({ block: false, needSessionApproval: false });
});
```

在同一 describe 追加：

```typescript
it('插件会确认的 write/exec 在 write-exec 下也不要会话简报', async () => {
  expect(
    await evaluatePolicy(
      ctx({
        toolName: 'run_remote_command',
        pluginId: 'at.terminal',
        risk: 'exec',
        args: { command: 'systemctl restart nginx' },
        sessionRequiredFor: 'write-exec',
        approval: null
      })
    )
  ).toEqual({ block: false, needSessionApproval: false });

  expect(
    await evaluatePolicy(
      ctx({
        toolName: 'nacos_publish_config',
        pluginId: 'at.nacos',
        risk: 'write',
        sessionRequiredFor: 'write-exec',
        approval: null
      })
    )
  ).toEqual({ block: false, needSessionApproval: false });
});

it('at.database write 仍强制简报（插件 MCP 无窗）', async () => {
  const decision = await evaluatePolicy(
    ctx({
      toolName: 'database_update_rows',
      pluginId: 'at.database',
      risk: 'write',
      sessionRequiredFor: 'never',
      approval: null
    })
  );
  expect(decision.block).toBe(false);
  if (!decision.block) expect(decision.needSessionApproval).toBe(true);
});
```

保留已有 `at.database write 即使 sessionRequiredFor=exec-only 也强制会话审批`。

- [ ] **Step 2: Run tests — new skip cases fail**

Run: `npm test -- test/policy.test.ts`

Expected: FAIL on「插件会确认的 write/exec…」because `run_remote_command` still `needSessionApproval: true`.

- [ ] **Step 3: Implement skip in `evaluatePolicy`**

在 `src/policy/index.ts` 已有 `import` 区确保 `toolConfirmsInPlugin` 从 `./pluginConfirm` 引入（Task 1 已 re-export，本文件内直接 import 避免循环也可：

```typescript
import { toolConfirmsInPlugin } from './pluginConfirm';
```

在「规则 7：Executor 无 approval 一律拒绝」**之前**、`approval === null` 分支里，插入插件确认短路。完整 write/exec 尾段改为：

```typescript
  // ── write / exec：审批链 ─────────────────────────────────────────────
  const approval = ctx.approval ?? null;
  const pluginConfirms = toolConfirmsInPlugin(ctx.pluginId, ctx.toolName);

  if (approval !== null) {
    if (approval.token.length === 0) {
      return block(OPS_ERROR.APPROVAL_REQUIRED, 'approvalToken 为空，需重新走审批简报');
    }
    const derived = deriveCommandSetHash(ctx.args, ctx.toolName);
    if (derived !== undefined && derived !== approval.commandSetSha256) {
      return block(
        OPS_ERROR.APPROVAL_STALE,
        `命令集哈希与已批简报 ${approval.briefId} 不一致，令牌作废，需重新审批`
      );
    }
    return allow();
  }

  if (ctx.role === 'executor' && !pluginConfirms) {
    return block(
      OPS_ERROR.APPROVAL_REQUIRED,
      `Executor 调用 ${risk} 级工具必须携带有效 approvalToken`
    );
  }

  if (ctx.pluginId === 'at.database' && risk === 'write') {
    return needApproval('at.database 写操作无插件弹窗，强制 9 要素审批简报');
  }

  if (pluginConfirms) {
    return allow();
  }

  switch (ctx.sessionRequiredFor) {
    case 'write-exec':
      return needApproval(`${risk} 级操作需要 9 要素审批简报（sessionRequiredFor=write-exec）`);
    case 'exec-only':
      return risk === 'exec'
        ? needApproval('exec 级操作需要 9 要素审批简报（sessionRequiredFor=exec-only）')
        : allow();
    case 'never':
      return allow();
  }
```

Investigator 的 riskCeiling 仍在本段之前执行，write 会被 block，不会走到 skip。

- [ ] **Step 4: Run tests**

Run: `npm test -- test/policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy/index.ts test/policy.test.ts
git commit -m "$(cat <<'EOF'
feat(policy): skip session briefs when the plugin already confirms

Terminal, JumpServer, and Nacos MCP writes go straight to execute;
the plugin modal remains the human gate. Database writes still require
the nine-element brief.
EOF
)"
```

---

### Task 3: Executor 无 token 可派发；policy 拦住无窗写

**Files:**
- Modify: `src/runtime/subagents.ts`（`buildTaskSpec` 约 188–205 行）
- Modify: `src/prompts/roles.ts`（executor 段）
- Test: `test/runtime.test.ts`（executor 必须带 token 那条）
- Test: `test/policy.test.ts`（已有 executor 无 approval → 改 toolName 为未知工具）

- [ ] **Step 1: Write the failing tests**

`test/runtime.test.ts` 把：

```typescript
it('executor 必须携带 approvalToken.briefId；commandSetSha256 可选（host 绑定）', () => {
  const bare = buildTaskSpec({ role: 'executor', goal: '重启实例', riskCeiling: 'exec' });
  expect(bare.ok).toBe(false);
```

改成：

```typescript
it('executor 可以不带 approvalToken；带了 briefId 则透传', () => {
  const bare = buildTaskSpec({ role: 'executor', goal: '重启实例', riskCeiling: 'exec' });
  expect(bare.ok).toBe(true);
  if (bare.ok) {
    expect(bare.spec.approvalToken).toBeUndefined();
    expect(bare.spec.output.contract).toBe('exec-report@1');
  }

  const briefOnly = buildTaskSpec({
    role: 'executor',
    goal: '重启实例',
    riskCeiling: 'exec',
    approvalToken: { briefId: 'brief-1' }
  });
  expect(briefOnly.ok).toBe(true);
  if (briefOnly.ok) {
    expect(briefOnly.spec.approvalToken).toEqual({ briefId: 'brief-1' });
  }

  const withToken = buildTaskSpec({
    role: 'executor',
    goal: '重启实例',
    riskCeiling: 'exec',
    approvalToken: { briefId: 'brief-1', commandSetSha256: 'abc123' }
  });
  expect(withToken.ok).toBe(true);
  if (withToken.ok) {
    expect(withToken.spec.approvalToken).toEqual({ briefId: 'brief-1', commandSetSha256: 'abc123' });
  }

  const emptyBrief = buildTaskSpec({
    role: 'executor',
    goal: '重启实例',
    riskCeiling: 'exec',
    approvalToken: { briefId: '' }
  });
  expect(emptyBrief.ok).toBe(false);
  if (!emptyBrief.ok) expect(emptyBrief.error).toContain('approvalToken');
});
```

`test/policy.test.ts` 把 executor 无 approval 用例的 toolName 改为不在 allowlist 的名字，并新增命中 allowlist 的放行：

```typescript
it('executor 无 approval 调无窗 write/exec → OPS_APPROVAL_REQUIRED', async () => {
  for (const risk of ['write', 'exec'] as const) {
    expectBlocked(
      await evaluatePolicy(
        ctx({ toolName: 'unknown_write_tool', role: 'executor', risk, approval: null })
      ),
      OPS_ERROR.APPROVAL_REQUIRED
    );
  }
});

it('executor 无 approval 调插件会确认的工具 → 放行', async () => {
  expect(
    await evaluatePolicy(
      ctx({
        toolName: 'run_remote_command',
        pluginId: 'at.terminal',
        role: 'executor',
        risk: 'exec',
        args: { command: 'hostname' },
        approval: null
      })
    )
  ).toEqual({ block: false, needSessionApproval: false });
});
```

原先那条 `executor 无 approval 调 write/exec` 用的是 `terminal_run_command`（不在 allowlist），改名后语义更清楚；若保留旧 it 标题也会在 Task 2 后失败，必须改。

- [ ] **Step 2: Run tests — dispatch still requires token**

Run: `npm test -- test/runtime.test.ts test/policy.test.ts`

Expected: FAIL — `bare.ok` is false.

- [ ] **Step 3: Relax `buildTaskSpec`**

`src/runtime/subagents.ts` 把 executor 段换成：

```typescript
  let approvalToken = input.approvalToken ?? undefined;
  if (input.role === 'executor') {
    if (approvalToken !== undefined && approvalToken !== null) {
      if (typeof approvalToken.briefId !== 'string' || approvalToken.briefId.length === 0) {
        return {
          ok: false,
          error:
            'Executor 的 approvalToken.briefId 不能为空（无窗写工具仍要引用已批简报；' +
            '插件会确认的工具可以不带 token）'
        };
      }
    } else {
      approvalToken = undefined;
    }
  } else {
    approvalToken = undefined;
  }
```

更新函数注释：删掉「Executor 必须携带 approvalToken.briefId」；写成「Executor 的 token 可选；无窗写工具由 policy 在调用时拒绝」。

`src/prompts/roles.ts` executor 段改为：

```typescript
  executor: `# L3' Executor（审批执行）
插件会自己弹确认的工具（远程命令、SFTP 写、Nacos 发布等）直接按 TaskSpec.plan 执行，不要向用户再要一轮会话简报。
at.database 写或未在插件确认的第三方写工具：必须持有 approvalToken.briefId（commandSetSha256 由 host 批准时绑定，你不要自行计算哈希）。
只执行 TaskSpec.plan 列出的命令，顺序 backup → verifyBackup → change → readback → verify，
任何偏离计划命令集的动作都不允许。
任一 step 失败：停止后续 step、保留现场、不自动回滚；命中回滚触发只上报，等待新的计划。
exit 0 ≠ 恢复；verified 只能来自 readback/verify step 的证据。
输出契约 exec-report@1：消息末尾必须附一个 fenced json 块：
{"contract":"exec-report@1","taskId":"…","status":"ok|failed|aborted","steps":[{"step":1,"kind":"backup","tool":"…","ok":true,"preview":"…"}],"verified":false,"notes":"…"}`,
```

- [ ] **Step 4: Run tests**

Run: `npm test -- test/runtime.test.ts test/policy.test.ts`

Expected: PASS. 若还有 `expect(executor).toContain('approvalToken')` 之类 prompt 快照测试失败，把断言改成包含「插件会自己弹确认」而不是「必须持有 approvalToken」。

- [ ] **Step 5: Commit**

```bash
git add src/runtime/subagents.ts src/prompts/roles.ts test/runtime.test.ts test/policy.test.ts
git commit -m "$(cat <<'EOF'
feat(subagents): allow executor dispatch without a session brief token

Plugin-confirmed tools are gated at execute time by the plugin modal.
Token remains required in policy for Database and unknown writes.
EOF
)"
```

---

### Task 4: 删除 `dedupePluginModal`；简报不再提示双确认

**Files:**
- Modify: `package.json`（删 `atOpsAgent.approval.dedupePluginModal`）
- Modify: `package.nls.json` / `package.nls.zh-cn.json`
- Modify: `src/host/services/configService.ts`（`KNOWN_CONFIG_KEYS`）
- Modify: `src/webview-settings/helpers.ts`（类型、默认值、SETTING_FIELDS、parse）
- Modify: `src/webview-settings/i18n.ts` / `mock-host.ts`
- Modify: `src/host/services/approvalNotify.ts`
- Modify: `src/webview-chat/i18n.ts`（`dualConfirmText` 可保留函数，生产路径不再喂 true）
- Test: `test/settings-ui.test.ts`
- Test: `test/webview-chat.test.ts`（双确认文案用例保留：函数仍按 hint 工作）

- [ ] **Step 1: Write the failing tests**

`test/settings-ui.test.ts` 里列出 `'approval.dedupePluginModal'` 的数组**删掉该字符串**（精确搜索该字面量，通常在 hydrate 白名单快照）。新增：

```typescript
it('hydrate 配置不含 approval.dedupePluginModal', () => {
  const keys = Object.keys(CONFIG_DEFAULTS);
  expect(keys).not.toContain('approval.dedupePluginModal');
});
```

若 `CONFIG_DEFAULTS` 未从 helpers 导出，改为：从 `SETTING_FIELDS` 断言 `every(f => f.key !== 'approval.dedupePluginModal')`。看 `test/settings-ui.test.ts` 现有 import，用已经在测的那份对象。

在 `test/` 里搜 `toBriefView` / `dualConfirmHint`。给 `approvalNotify` 加用例（已有文件则追加，否则写在现有 approval 测试里）：

```typescript
it('toBriefView 不再宣称插件会再弹一次', () => {
  const view = toBriefView({
    briefId: 'b1',
    runId: 'r1',
    risk: 'exec',
    elements: { goal: '重启' }
  });
  expect(view.dualConfirmHint).toBe(false);
});
```

`toBriefView` 今天在 `dedupePluginModal===false` 时返回 `dualConfirmHint: true`，此测试会红。

- [ ] **Step 2: Run tests — fail on leftover key / hint true**

Run: `npm test -- test/settings-ui.test.ts`

Expected: FAIL if you already deleted the key from the expected list but implementation still has it, **or** the new `not.toContain` fails until Step 3. Order: first change tests to expect absence, run, see FAIL because defaults still contain the key.

- [ ] **Step 3: Remove the setting and force hint false**

1. `package.json` 删除整个 `"atOpsAgent.approval.dedupePluginModal": { ... }` 块。
2. `package.nls.json` 与 `package.nls.zh-cn.json` 删除 `config.approval.dedupePluginModal`。
3. `configService.ts` 的 `KNOWN_CONFIG_KEYS` 删 `'approval.dedupePluginModal'`。
4. `helpers.ts`：从 `AgentConfig` 类型、`CONFIG_DEFAULTS`、`SETTING_FIELDS`、`parse` 映射四处删除该键。
5. `webview-settings/i18n.ts` 删除 `cfgDedupePluginModal` / `cfgDedupePluginModalDesc`（中英）。
6. `mock-host.ts` 删除该默认。
7. `approvalNotify.ts` 的 `toBriefView`：

```typescript
  return {
    id: brief.briefId,
    risk: brief.risk,
    targetLabel: brief.elements?.goal ?? `${brief.risk} 变更（run ${brief.runId}）`,
    elements,
    dualConfirmHint: false
  };
```

删掉对 `dedupePluginModal` 的 `getConfiguration` 读取。

8. 全仓 grep `dedupePluginModal`：测试夹具、docs 以外的 src 不得再出现。`docs/05-ui-system.md` §3.1 放到 Task 5。

- [ ] **Step 4: Run tests**

Run: `npm test -- test/settings-ui.test.ts test/webview-chat.test.ts`

Expected: PASS. 再跑一遍 `npx vitest run` 看有无残留引用编译失败。

- [ ] **Step 5: Commit**

```bash
git add package.json package.nls.json package.nls.zh-cn.json \
  src/host/services/configService.ts src/host/services/approvalNotify.ts \
  src/webview-settings/helpers.ts src/webview-settings/i18n.ts src/webview-settings/mock-host.ts \
  test/settings-ui.test.ts
git commit -m "$(cat <<'EOF'
fix(settings): drop dedupePluginModal; it never skipped any gate

The switch only hid a dual-confirm hint. Plugin modals stay authoritative;
session briefs no longer warn about a second dialog.
EOF
)"
```

---

### Task 5: 提示词与安全文档

**Files:**
- Modify: `src/prompts/layers.ts`（`L3_OUTPUT_FORMAT` 审批段）
- Modify: `docs/07-security.md` §1–2
- Modify: `docs/05-ui-system.md` §3.1
- Test: `test/runtime.test.ts` 中断言 L3 含 `approvalToken` 的用例（搜 `L3_OUTPUT_FORMAT`）

- [ ] **Step 1: Write the failing test**

`test/runtime.test.ts` 现有：

```typescript
    expect(L3_OUTPUT_FORMAT).toContain('不要自行计算任何哈希');
    expect(L3_OUTPUT_FORMAT).toContain('host 会计算 commandSetSha256');
    expect(L3_OUTPUT_FORMAT).toContain('approvalToken');
```

这三条**保留**（无窗写路径仍要）。在紧挨着的位置追加：

```typescript
    expect(L3_OUTPUT_FORMAT).toContain('插件确认');
    expect(L3_OUTPUT_FORMAT).toContain('at.database');
    expect(L3_OUTPUT_FORMAT).not.toContain('仅 write/exec 前出 9 要素审批简报');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/runtime.test.ts -t "不要求模型计算"`

Expected: FAIL — 旧 L3 没有「插件确认」，且仍含「仅 write/exec 前出 9 要素审批简报」。

- [ ] **Step 3: Update copy**

`L3_OUTPUT_FORMAT` 把 9 要素那 4 行换成：

```
- 人审在插件：run_remote_command / SFTP 写 / JumpServer 命令与 SQL / Nacos 发布等，插件会弹确认或按主机信任档自动放行。不要再出 9 要素会话简报，也不要等用户在聊天里回复「批准」。
- 无插件弹窗的写操作才出 9 要素简报（at.database 写、第三方 mcp_call_tool 写、ops_write_ops_doc）：1 目标与理由；2 支持证据；3 影响；4 前置检查；5 备份；6 确切命令；7 成功判据；8 回滚；9 不确定性。批准后 host 会计算 commandSetSha256 并把 approvalToken 附给执行——你不要自行计算任何哈希。
```

`docs/07-security.md` §1 在三道闸图下改为：

```
① 仍做 block / riskCeiling / payload caps / command-policy 风险分类，但**不再**对「插件 MCP 已确认」的 write/exec 等人审。
③ 是 Terminal / JumpServer / Nacos 的权威人审。Agent 不能替插件点同意，也不能压掉插件弹窗。
at.database 写、第三方 MCP 写、ops_write_ops_doc：仍走 ① 的 9 要素简报。
```

§2 表「write / exec | 主会话」单元格改为：「插件已确认 → 放行；否则审批简报」。Executor 单元格改为：「插件已确认 → 可无 token；否则需 token + 哈希」。

`docs/05-ui-system.md` §3.1 整段换成：写操作由对应插件确认；Agent ApprovalBar 只出现在无插件弹窗的写路径。删除 `dedupePluginModal` 与 `brief-only` 描述。

- [ ] **Step 4: Run tests**

Run: `npm test -- test/runtime.test.ts test/policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/layers.ts docs/07-security.md docs/05-ui-system.md test/runtime.test.ts
git commit -m "$(cat <<'EOF'
docs: record plugin-owned human gates in prompts and security spec

Stop asking the model for a nine-element brief on tools the plugin
already confirms.
EOF
)"
```

---

### Task 6: 全量回归

- [ ] **Step 1: Run the full suite**

Run: `npm test`

Expected: PASS（当前仓库基线为 vitest run 全绿）。若 `test/approval-loop.test.ts` / `test/policy-gaps.test.ts` 仍假定 `nacos_publish_config` 或 `run_remote_command` 要会话审批，按 Task 2 同一语义改夹具（无窗工具才 `needSessionApproval`）。

- [ ] **Step 2: Commit only if you had to fix leftover tests**

```bash
git add test/
git commit -m "$(cat <<'EOF'
test: align approval-loop fixtures with plugin-owned gates
EOF
)"
```
