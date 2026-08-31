/**
 * P0 审批闭环（vscode-free）：
 * - approvalGate 纯函数：commandSet 推导必须与 policy.deriveCommandSetHash 对齐，
 *   否则批准后重试同一调用会永远命中 OPS_APPROVAL_STALE；
 * - policy + orchestrator 集成：needSessionApproval → requestApproval（9 要素简报）
 *   → applyApproval → issueApprovalToken → 同一命令集重试放行 / 篡改命令集拒绝。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_ELEMENT_KEYS,
  buildApprovalCommandSet,
  buildApprovalElements
} from '../src/host/approvalGate';
import {
  createOrchestrator,
  type OrchestratorEvent,
  type Playbook
} from '../src/orchestrator';
import {
  evaluatePolicy,
  hashCommandSet,
  issueApprovalToken,
  verifyApprovalToken,
  type ApprovalRef,
  type PolicyContext
} from '../src/policy';
import { OPS_ERROR } from '../src/protocol';

const SECRET = 'test-secret-not-a-real-hmac-key';
const SESSION = 'session-1';

function execCtx(overrides: Partial<PolicyContext>): PolicyContext {
  return {
    toolName: 'terminal_run_command',
    args: { command: 'systemctl restart nginx' },
    risk: 'exec',
    sessionRequiredFor: 'write-exec',
    selectCountThisTask: 1,
    ...overrides
  };
}

function approvalFor(briefId: string, commandSet: unknown): ApprovalRef {
  const commandSetSha256 = hashCommandSet(commandSet);
  return {
    briefId,
    commandSetSha256,
    token: issueApprovalToken(briefId, commandSetSha256, SESSION, SECRET)
  };
}

function testPlaybook(): Playbook {
  return {
    id: 'pb.approval-loop',
    version: 1,
    triggers: [{ kind: 'nl', patterns: ['审批闭环'] }],
    stages: [
      { id: 'triage' },
      { id: 'selecting', select: { mode: 'replace', pluginIds: ['at.terminal'] } },
      { id: 'investigating' },
      { id: 'synthesizing' },
      { id: 'awaitingApproval' },
      {
        id: 'executing',
        parallelGroup: [{ id: 'exec-1', role: 'executor', riskCeiling: 'exec', goal: '执行已批变更' }]
      },
      { id: 'verifying' },
      { id: 'reporting' },
      { id: 'closed' }
    ]
  };
}

describe('approvalGate · commandSet 推导与 policy 对齐', () => {
  it('单条 command 字符串 → [command]，批准后同一调用放行', async () => {
    const args = { command: 'systemctl restart nginx' };
    const commandSet = buildApprovalCommandSet('terminal_run_command', args);
    expect(commandSet).toEqual(['systemctl restart nginx']);

    const decision = await evaluatePolicy(
      execCtx({ args, approval: approvalFor('brief-1', commandSet) })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('sql / query 字符串同样对齐（含 LIMIT 通过 payload 闸）', async () => {
    const args = { sql: 'DELETE FROM t WHERE id = 1 LIMIT 1' };
    const commandSet = buildApprovalCommandSet('db_execute_sql', args);
    expect(commandSet).toEqual([args.sql]);

    const decision = await evaluatePolicy(
      execCtx({
        toolName: 'db_execute_sql',
        risk: 'write',
        args,
        approval: approvalFor('brief-sql', commandSet)
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('args.commands 数组原样成为命令集', async () => {
    const args = { commands: ['cp a b', 'rm a'] };
    const commandSet = buildApprovalCommandSet('terminal_run_script', args);
    expect(commandSet).toEqual(args.commands);

    const decision = await evaluatePolicy(
      execCtx({ toolName: 'terminal_run_script', args, approval: approvalFor('brief-2', commandSet) })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('结构化入参（无 command/sql/query）→ {tool,args}；policy 推导不出哈希也放行', async () => {
    const args = { dataId: 'app.yaml', content: 'a: 1' };
    const commandSet = buildApprovalCommandSet('nacos_publish_config', args);
    expect(commandSet).toEqual({ tool: 'nacos_publish_config', args });

    const decision = await evaluatePolicy(
      execCtx({
        toolName: 'nacos_publish_config',
        risk: 'write',
        args,
        approval: approvalFor('brief-3', commandSet)
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('批准后篡改命令 → OPS_APPROVAL_STALE', async () => {
    const approved = buildApprovalCommandSet('terminal_run_command', {
      command: 'systemctl restart nginx'
    });
    const decision = await evaluatePolicy(
      execCtx({
        args: { command: 'rm -rf /data' },
        approval: approvalFor('brief-4', approved)
      })
    );
    expect(decision.block).toBe(true);
    if (decision.block) expect(decision.code).toBe(OPS_ERROR.APPROVAL_STALE);
  });

  it('9 要素齐全且非空；commands 含确切命令', async () => {
    const args = { command: 'systemctl restart nginx' };
    const commandSet = buildApprovalCommandSet('terminal_run_command', args);
    const elements = buildApprovalElements({
      toolName: 'terminal_run_command',
      args,
      risk: 'exec',
      commandSet,
      pluginId: 'at.terminal',
      stage: 'synthesizing'
    });
    expect(Object.keys(elements).sort()).toEqual([...APPROVAL_ELEMENT_KEYS].sort());
    for (const key of APPROVAL_ELEMENT_KEYS) {
      expect(elements[key].length).toBeGreaterThan(0);
    }
    expect(elements.commands).toContain('systemctl restart nginx');
    expect(elements.goal).toContain('terminal_run_command');
  });
});

describe('approval loop · policy + orchestrator 集成', () => {
  it('needSessionApproval → 简报 → 批准 → 令牌 → 同一调用放行；executor spec 可合并审批引用', async () => {
    const events: OrchestratorEvent[] = [];
    const orch = createOrchestrator({
      playbooks: [testPlaybook()],
      onEvent: (e) => events.push(e)
    });
    const run = orch.startPlaybook('pb.approval-loop', SESSION);
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');

    // 1. 无审批时 exec 工具要求会话审批（host 闸门此时应发简报并 block）。
    const before = await evaluatePolicy(execCtx({ approval: null }));
    expect(before).toMatchObject({ block: false, needSessionApproval: true });

    // 2. host 装配命令集与 9 要素并请求简报 → awaitingApproval。
    const args = { command: 'systemctl restart nginx' };
    const commandSet = buildApprovalCommandSet('terminal_run_command', args);
    const brief = orch.requestApproval(run.id, {
      risk: 'exec',
      commandSet,
      elements: buildApprovalElements({
        toolName: 'terminal_run_command',
        args,
        risk: 'exec',
        commandSet
      })
    });
    expect(orch.getRun(run.id)?.stage).toBe('awaitingApproval');
    expect(brief.commandSetSha256).toBe(hashCommandSet(commandSet));
    expect(events.some((e) => e.type === 'approval/request')).toBe(true);

    // 3. 会话内批准 → executing，host 签发 HMAC 令牌（只存 host 内存）。
    orch.applyApproval({ brief: { briefId: brief.briefId, runId: run.id }, decision: 'approved' });
    expect(orch.getRun(run.id)?.stage).toBe('executing');
    const token = issueApprovalToken(brief.briefId, brief.commandSetSha256, SESSION, SECRET);
    expect(verifyApprovalToken(token, brief.briefId, brief.commandSetSha256, SESSION, SECRET)).toBe(
      true
    );
    // 换会话 / 换秘钥即失效。
    expect(
      verifyApprovalToken(token, brief.briefId, brief.commandSetSha256, 'session-2', SECRET)
    ).toBe(false);
    expect(
      verifyApprovalToken(token, brief.briefId, brief.commandSetSha256, SESSION, 'other-secret')
    ).toBe(false);

    // 4. 模型重试同一调用：闸门带 approval → 放行。
    const approval: ApprovalRef = {
      briefId: brief.briefId,
      commandSetSha256: brief.commandSetSha256,
      token
    };
    expect(await evaluatePolicy(execCtx({ args, approval }))).toEqual({
      block: false,
      needSessionApproval: false
    });

    // 5. executing 阶段的 executor spec 可合并 {briefId, commandSetSha256}（无 hmac token）。
    const specs = orch.spawnSubagentSpecs(run.id);
    expect(specs).toHaveLength(1);
    expect(specs[0].role).toBe('executor');
    expect(specs[0].output.contract).toBe('exec-report@1');
    const merged = {
      ...specs[0],
      approvalToken: { briefId: approval.briefId, commandSetSha256: approval.commandSetSha256 }
    };
    expect(merged.taskId).toBe(specs[0].taskId);
    expect(merged.approvalToken).not.toHaveProperty('token');
  });

  it('拒绝路径：executing 中的回滚简报被拒 → reporting，且 executor 无令牌一律被拒', async () => {
    const events: OrchestratorEvent[] = [];
    const orch = createOrchestrator({
      playbooks: [testPlaybook()],
      onEvent: (e) => events.push(e)
    });
    const run = orch.startPlaybook('pb.approval-loop', SESSION);
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');
    const brief = orch.requestApproval(run.id, {
      risk: 'exec',
      commandSet: ['systemctl restart nginx']
    });
    orch.applyApproval({ brief: { briefId: brief.briefId, runId: run.id }, decision: 'approved' });
    expect(orch.getRun(run.id)?.stage).toBe('executing');

    // executing → 二次简报（如回滚）→ 拒绝 → reporting。
    const rollback = orch.requestApproval(run.id, {
      risk: 'exec',
      commandSet: ['systemctl stop nginx']
    });
    orch.applyApproval({
      brief: { briefId: rollback.briefId, runId: run.id },
      decision: 'rejected'
    });
    expect(orch.getRun(run.id)?.stage).toBe('reporting');
    expect(
      events.filter((e) => e.type === 'approval/resolved').map((e) => e.decision)
    ).toEqual(['approved', 'rejected']);

    // 拒绝后（host 清空 currentApproval）：executor 无 approval 一律拒 write/exec。
    const denied = await evaluatePolicy(execCtx({ role: 'executor', approval: null }));
    expect(denied.block).toBe(true);
    if (denied.block) expect(denied.code).toBe(OPS_ERROR.APPROVAL_REQUIRED);
  });

  it('主会话上一条审批通过后，后续执行只读巡检（如 du）或新命令不被误报 OPS_APPROVAL_STALE', async () => {
    const approvedCommand = 'systemctl restart nginx';
    const approvedToken = approvalFor('brief-local-1', [approvedCommand]);

    // 1. 已批命令自身：放行
    const matched = await evaluatePolicy(
      execCtx({
        toolName: 'run_remote_command',
        args: { command: approvedCommand },
        approval: approvedToken
      })
    );
    expect(matched).toEqual({ block: false, needSessionApproval: false });

    // 2. 后续只读命令（如 du / find / lsof）：无论是否附带旧审批，均推断为 read 并直接放行
    const readCmd = await evaluatePolicy(
      execCtx({
        toolName: 'run_remote_command',
        args: { command: 'du -sh /var' },
        approval: null
      })
    );
    expect(readCmd).toEqual({ block: false, needSessionApproval: false });

    // 3. 后续新的 exec 命令（非 Executor 角色）：在无对应审批时正常触发新一轮 needSessionApproval，而不是误报 OPS_APPROVAL_STALE 错误
    const newExecCmd = await evaluatePolicy(
      execCtx({
        toolName: 'run_remote_command',
        args: { command: 'systemctl reload app' },
        approval: null
      })
    );
    expect(newExecCmd.block).toBe(false);
    if (!newExecCmd.block) {
      expect(newExecCmd.needSessionApproval).toBe(true);
    }
  });
});

describe('approval timeout · 配置默认', () => {
  it('package.json 生产默认 900000ms（15min），测试不得改此默认', async () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    ) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    expect(pkg.contributes.configuration.properties['atOpsAgent.approval.timeoutMs']?.default).toBe(
      900000
    );
  });
});

