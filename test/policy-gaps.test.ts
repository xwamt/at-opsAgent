/**
 * Edge cases not covered by test/policy.test.ts. The three headline rules
 * (investigating clear blocked, investigator exec blocked, Loki limit > 100
 * blocked) are already asserted there and are not duplicated here.
 */
import { describe, expect, it } from 'vitest';

import { evaluatePolicy, hashCommandSet, type PolicyContext } from '../src/policy';
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

describe('policy gaps · writer surface', () => {
  it('writer may call ops_* meta tools (only business tools are cut off)', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'ops_get_report_template', role: 'writer', risk: 'read' })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });
});

describe('policy gaps · executor and raised ceilings', () => {
  it('executor read tools pass without any approval', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'grafana_list_dashboards', role: 'executor', risk: 'read', approval: null })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('investigator with an explicitly raised riskCeiling=write passes the ceiling but still needs session approval', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'database_update_rows',
        role: 'investigator',
        risk: 'write',
        riskCeiling: 'write'
      })
    );
    expect(decision.block).toBe(false);
    if (!decision.block) {
      expect(decision.needSessionApproval).toBe(true);
    }
  });

  it('lead without a riskCeiling is not ceiling-blocked, but exec still needs approval', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'terminal_run_command', role: 'lead', risk: 'exec' })
    );
    expect(decision.block).toBe(false);
    if (!decision.block) {
      expect(decision.needSessionApproval).toBe(true);
    }
  });
});

describe('policy gaps · selection at no-playbook boundary', () => {
  it('stage undefined counts as a task boundary: a second replace select is allowed', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'ops_select_tools',
        args: { mode: 'replace', pluginIds: ['at.grafana'] },
        stage: undefined,
        selectCountThisTask: 3
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('at_clear_tool_selection at reporting is allowed (prefix parity with ops_)', () => {
    const decision = evaluatePolicy(
      ctx({ toolName: 'at_clear_tool_selection', stage: 'reporting' })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });
});

describe('policy gaps · command-set hash derivation from args.commands', () => {
  const commands = ['systemctl stop app', 'systemctl start app'];

  it('executor with an approval matching the commands array is allowed', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'terminal_run_commands',
        role: 'executor',
        risk: 'exec',
        args: { commands },
        approval: { briefId: 'brief-1', commandSetSha256: hashCommandSet(commands), token: 'tok' }
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('reordering the approved commands invalidates the token (OPS_APPROVAL_STALE)', () => {
    const decision = evaluatePolicy(
      ctx({
        toolName: 'terminal_run_commands',
        role: 'executor',
        risk: 'exec',
        args: { commands: [...commands].reverse() },
        approval: { briefId: 'brief-1', commandSetSha256: hashCommandSet(commands), token: 'tok' }
      })
    );
    expect(decision.block).toBe(true);
    if (decision.block) {
      expect(decision.code).toBe(OPS_ERROR.APPROVAL_STALE);
    }
  });
});

describe('policy gaps · payload cap boundary', () => {
  it('loki limit 101 blocks, 1 passes (boundary just above the cap)', () => {
    const over = evaluatePolicy(ctx({ toolName: 'grafana_query_loki', args: { limit: 101 } }));
    expect(over.block).toBe(true);
    if (over.block) {
      expect(over.code).toBe(OPS_ERROR.PAYLOAD_CAP);
    }
    expect(
      evaluatePolicy(ctx({ toolName: 'grafana_query_loki', args: { limit: 1 } }))
    ).toEqual({ block: false, needSessionApproval: false });
  });
});
