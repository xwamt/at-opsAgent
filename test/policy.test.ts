import { describe, expect, it } from 'vitest';

import {
  assertApproval,
  evaluatePolicy,
  hashCommandSet,
  issueApprovalToken,
  PolicyError,
  verifyApprovalToken,
  type PolicyContext
} from '../src/policy';
import { OPS_ERROR } from '../src/protocol';

function ctx(overrides: Partial<PolicyContext>): PolicyContext {
  return {
    toolName: 'grafana_query_prometheus',
    args: {},
    risk: 'read',
    sessionRequiredFor: 'write-exec',
    selectCountThisTask: 0,
    ...overrides
  };
}

function expectBlocked(decision: ReturnType<typeof evaluatePolicy>, code: string): void {
  expect(decision.block).toBe(true);
  if (decision.block) {
    expect(decision.code).toBe(code);
    expect(decision.reason.length).toBeGreaterThan(0);
  }
}

describe('policy · 工具选择纪律', () => {
  it('investigating 阶段 clear 被拒（OPS_SELECTION_FORBIDDEN）', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'ops_clear_tool_selection', stage: 'investigating' })
    );
    expectBlocked(decision, OPS_ERROR.SELECTION_FORBIDDEN);
  });

  it('selecting / synthesizing 阶段 clear 同样被拒，at_ 前缀等价', () => {
    for (const stage of ['selecting', 'synthesizing']) {
      expectBlocked(
        evaluatePolicy(ctx({ toolName: 'at_clear_tool_selection', stage })),
        OPS_ERROR.SELECTION_FORBIDDEN
      );
    }
  });

  it('reporting / closed 阶段 clear 放行', () => {
    for (const stage of ['reporting', 'closed', undefined]) {
      const decision = evaluatePolicy(ctx({ toolName: 'ops_clear_tool_selection', stage }));
      expect(decision).toEqual({ block: false, needSessionApproval: false });
    }
  });

  it('selecting 阶段第一次 replace 放行', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'ops_select_tools',
        args: { mode: 'replace', pluginIds: ['at.grafana'] },
        stage: 'selecting',
        selectCountThisTask: 0
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('调查中二次 replace 被拒（OPS_SELECTION_FORBIDDEN）', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'ops_select_tools',
        args: { mode: 'replace', pluginIds: ['at.terminal'] },
        stage: 'investigating',
        selectCountThisTask: 1
      })
    );
    expectBlocked(decision, OPS_ERROR.SELECTION_FORBIDDEN);
  });

  it('调查中 mode=add 扩面放行', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'at_select_tools',
        args: { mode: 'add', pluginIds: ['at.jumpserver'] },
        stage: 'investigating',
        selectCountThisTask: 1
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('任务边界（triage / closed）允许重新 replace', () => {
    for (const stage of ['triage', 'closed']) {
      const decision = evaluatePolicy(
        ctx({
          toolName: 'ops_select_tools',
          args: { mode: 'replace', pluginIds: ['at.jenkins'] },
          stage,
          selectCountThisTask: 2
        })
      );
      expect(decision).toEqual({ block: false, needSessionApproval: false });
    }
  });
});

describe('policy · 角色风险顶', () => {
  it('read 放行且不需会话审批', () => {
    const decision = evaluatePolicy(ctx({ role: 'investigator', risk: 'read' }));
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('investigator exec 被拒（OPS_RISK_CEILING，默认 read 硬顶）', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'terminal_run_command', role: 'investigator', risk: 'exec' })
    );
    expectBlocked(decision, OPS_ERROR.RISK_CEILING);
  });

  it('investigator / verifier write 也被拒', () => {
    for (const role of ['investigator', 'verifier'] as const) {
      expectBlocked(
        evaluatePolicy(ctx({ toolName: 'nacos_publish_config', role, risk: 'write' })),
        OPS_ERROR.RISK_CEILING
      );
    }
  });

  it('writer 调用任何业务工具（哪怕 read）被拒', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'grafana_list_dashboards', role: 'writer', risk: 'read' })
    );
    expectBlocked(decision, OPS_ERROR.RISK_CEILING);
  });

  it('子代理不能靠上抬 riskCeiling 绕过 writer 业务工具禁令', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'terminal_run_command', role: 'writer', risk: 'exec', riskCeiling: 'exec' })
    );
    expectBlocked(decision, OPS_ERROR.RISK_CEILING);
  });
});

describe('policy · 会话审批', () => {
  it('at.database write 即使 sessionRequiredFor=exec-only 也强制会话审批', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'database_update_rows',
        pluginId: 'at.database',
        risk: 'write',
        sessionRequiredFor: 'exec-only',
        approval: null
      })
    );
    expect(decision.block).toBe(false);
    if (!decision.block) {
      expect(decision.needSessionApproval).toBe(true);
    }
  });

  it('write-exec 策略下主会话 write 需要审批；exec-only 下普通 write 不需要', () => {
    const write = ctx({ toolName: 'nacos_publish_config', pluginId: 'at.nacos', risk: 'write' });
    const underWriteExec = evaluatePolicy(write);
    expect(!underWriteExec.block && underWriteExec.needSessionApproval).toBe(true);

    const underExecOnly = evaluatePolicy({ ...write, sessionRequiredFor: 'exec-only' });
    expect(underExecOnly).toEqual({ block: false, needSessionApproval: false });
  });

  it('exec-only 下 exec 仍需审批；never 下不需要', () => {
    const exec = ctx({ toolName: 'terminal_run_command', risk: 'exec' });
    const underExecOnly = evaluatePolicy({ ...exec, sessionRequiredFor: 'exec-only' });
    expect(!underExecOnly.block && underExecOnly.needSessionApproval).toBe(true);

    const underNever = evaluatePolicy({ ...exec, sessionRequiredFor: 'never' });
    expect(underNever).toEqual({ block: false, needSessionApproval: false });
  });

  it('executor 无 approval 调 write/exec → OPS_APPROVAL_REQUIRED', () => {
    for (const risk of ['write', 'exec'] as const) {
      expectBlocked(
        evaluatePolicy(
          ctx({ toolName: 'terminal_run_command', role: 'executor', risk, approval: null })
        ),
        OPS_ERROR.APPROVAL_REQUIRED
      );
    }
  });

  it('executor 携带的 approval 与命令哈希不一致 → OPS_APPROVAL_STALE', () => {
    const approved = hashCommandSet(['systemctl restart app']);
    const decision = evaluatePolicy(
      ctx({
        toolName: 'terminal_run_command',
        role: 'executor',
        risk: 'exec',
        args: { command: 'rm -rf /data' },
        approval: { briefId: 'brief-1', commandSetSha256: approved, token: 'tok' }
      })
    );
    expectBlocked(decision, OPS_ERROR.APPROVAL_STALE);
  });

  it('executor 携带匹配的 approval 放行，且不再要求会话审批', () => {
    const command = 'systemctl restart app';
    const decision = evaluatePolicy(
      ctx({
        toolName: 'terminal_run_command',
        role: 'executor',
        risk: 'exec',
        args: { command },
        approval: {
          briefId: 'brief-1',
          commandSetSha256: hashCommandSet([command]),
          token: 'tok'
        }
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('空 token 的 approval 视为无效 → OPS_APPROVAL_REQUIRED', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'terminal_run_command',
        role: 'executor',
        risk: 'exec',
        approval: { briefId: 'brief-1', commandSetSha256: hashCommandSet([]), token: '' }
      })
    );
    expectBlocked(decision, OPS_ERROR.APPROVAL_REQUIRED);
  });
});

describe('policy · payload 上限', () => {
  it('loki limit>100 → OPS_PAYLOAD_CAP；≤100 放行', () => {
    expectBlocked(
      evaluatePolicy(ctx({ toolName: 'grafana_query_loki', args: { limit: 500 } })),
      OPS_ERROR.PAYLOAD_CAP
    );
    expect(
      evaluatePolicy(ctx({ toolName: 'grafana_query_loki', args: { limit: 100 } }))
    ).toEqual({ block: false, needSessionApproval: false });
  });

  it('SQL 类无 LIMIT 且无 limit 字段 → OPS_PAYLOAD_CAP', () => {
    expectBlocked(
      evaluatePolicy(
        ctx({ toolName: 'database_execute_sql', args: { sql: 'SELECT * FROM orders' } })
      ),
      OPS_ERROR.PAYLOAD_CAP
    );
    expectBlocked(
      evaluatePolicy(
        ctx({ toolName: 'jumpserver_execute_query', args: { query: 'SELECT 1 FROM dual' } })
      ),
      OPS_ERROR.PAYLOAD_CAP
    );
  });

  it('带 LIMIT 子句或 limit 字段的 SQL 放行', () => {
    expect(
      evaluatePolicy(
        ctx({ toolName: 'database_execute_sql', args: { sql: 'SELECT * FROM orders LIMIT 50' } })
      )
    ).toEqual({ block: false, needSessionApproval: false });
    expect(
      evaluatePolicy(
        ctx({ toolName: 'database_execute_sql', args: { sql: 'SELECT * FROM orders', limit: 50 } })
      )
    ).toEqual({ block: false, needSessionApproval: false });
  });
});

describe('policy · 哈希与令牌', () => {
  it('hashCommandSet 是 canonical 的：对象 key 顺序无关，数组顺序有关', () => {
    const a = hashCommandSet([{ cmd: 'restart', target: 'app' }]);
    const b = hashCommandSet([{ target: 'app', cmd: 'restart' }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCommandSet(['x', 'y'])).not.toBe(hashCommandSet(['y', 'x']));
  });

  it('issueApprovalToken / verifyApprovalToken 往返成立，篡改任一要素失败', () => {
    const sha = hashCommandSet(['systemctl restart app']);
    const token = issueApprovalToken('brief-9', sha, 'sess-1', 'top-secret');
    expect(verifyApprovalToken(token, 'brief-9', sha, 'sess-1', 'top-secret')).toBe(true);
    expect(verifyApprovalToken(token, 'brief-9', sha, 'sess-1', 'wrong')).toBe(false);
    expect(verifyApprovalToken(token, 'brief-8', sha, 'sess-1', 'top-secret')).toBe(false);
    expect(verifyApprovalToken(token, 'brief-9', sha, 'sess-2', 'top-secret')).toBe(false);
    expect(verifyApprovalToken(`${token}00`, 'brief-9', sha, 'sess-1', 'top-secret')).toBe(false);
  });

  it('assertApproval：命令集一致通过，不一致抛 OPS_APPROVAL_STALE，缺失抛 OPS_APPROVAL_REQUIRED', () => {
    const plan = ['systemctl restart app', 'systemctl status app'];
    const approval = {
      briefId: 'brief-1',
      commandSetSha256: hashCommandSet(plan),
      token: 'tok'
    };
    expect(() => assertApproval(plan, approval)).not.toThrow();

    try {
      assertApproval(['rm -rf /data'], approval);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyError);
      expect((err as PolicyError).code).toBe(OPS_ERROR.APPROVAL_STALE);
    }

    try {
      assertApproval(plan, null);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as PolicyError).code).toBe(OPS_ERROR.APPROVAL_REQUIRED);
    }
  });
});
