/**
 * Edge cases not covered by test/policy.test.ts. The three headline rules
 * (investigating clear blocked, investigator exec blocked, Loki limit > 100
 * blocked) are already asserted there and are not duplicated here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue
    })
  }
}));

import { evaluatePolicy, hashCommandSet, type PolicyContext } from '../src/policy';
import { OPS_ERROR } from '../src/protocol';
import { RISK_BY_PROXY_TOOL } from '../src/mcp-client/external';
import { resolveToolRisk } from '../src/mcp-client/riskLookup';
import { ApprovalService } from '../src/host/services/approvalService';
import type { HostContext } from '../src/host/services/context';

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
  it('writer may call ops_* meta tools (only business tools are cut off)', async () => {
    const decision = await evaluatePolicy(
      ctx({ toolName: 'ops_get_report_template', role: 'writer', risk: 'read' })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });
});

describe('policy gaps · executor and raised ceilings', () => {
  it('executor read tools pass without any approval', async () => {
    const decision = await evaluatePolicy(
      ctx({ toolName: 'grafana_list_dashboards', role: 'executor', risk: 'read', approval: null })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('investigator with an explicitly raised riskCeiling=write passes the ceiling but still needs session approval', async () => {
    const decision = await evaluatePolicy(
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

  it('lead without a riskCeiling is not ceiling-blocked, but exec still needs approval', async () => {
    const decision = await evaluatePolicy(
      ctx({ toolName: 'terminal_run_command', role: 'lead', risk: 'exec' })
    );
    expect(decision.block).toBe(false);
    if (!decision.block) {
      expect(decision.needSessionApproval).toBe(true);
    }
  });
});

describe('policy gaps · selection at no-playbook boundary', () => {
  it('stage undefined counts as a task boundary: a second replace select is allowed', async () => {
    const decision = await evaluatePolicy(
      ctx({
        toolName: 'ops_select_tools',
        args: { mode: 'replace', pluginIds: ['at.grafana'] },
        stage: undefined,
        selectCountThisTask: 3
      })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });

  it('at_clear_tool_selection at reporting is allowed (prefix parity with ops_)', async () => {
    const decision = await evaluatePolicy(
      ctx({ toolName: 'at_clear_tool_selection', stage: 'reporting' })
    );
    expect(decision).toEqual({ block: false, needSessionApproval: false });
  });
});

describe('policy gaps · command-set hash derivation from args.commands', () => {
  const commands = ['systemctl stop app', 'systemctl start app'];

  it('executor with an approval matching the commands array is allowed', async () => {
    const decision = await evaluatePolicy(
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

  it('reordering the approved commands invalidates the token (OPS_APPROVAL_STALE)', async () => {
    const decision = await evaluatePolicy(
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
  it('loki limit 101 blocks, 1 passes (boundary just above the cap)', async () => {
    const over = await evaluatePolicy(ctx({ toolName: 'grafana_query_loki', args: { limit: 101 } }));
    expect(over.block).toBe(true);
    if (over.block) {
      expect(over.code).toBe(OPS_ERROR.PAYLOAD_CAP);
    }
    expect(
      await evaluatePolicy(ctx({ toolName: 'grafana_query_loki', args: { limit: 1 } }))
    ).toEqual({ block: false, needSessionApproval: false });
  });
});

function makeApprovals(listAllTools: () => readonly { name: string; risk?: string }[] = () => []): ApprovalService {
  const ctx = {
    hub: { listAllTools },
    store: { playbookOf: () => undefined },
    playbooks: { selectCount: () => 0, bumpSelectCount: () => {} },
    core: { evaluatePolicy },
    log: () => {}
  } as unknown as HostContext;
  return new ApprovalService(ctx);
}

describe('policy gaps · MCP proxy risk (P0-F)', () => {
  it('resolveToolRisk matches RISK_BY_PROXY_TOOL; unknown non-ops_ is exec', async () => {
    expect(resolveToolRisk('mcp_list_servers')).toBe(RISK_BY_PROXY_TOOL.mcp_list_servers);
    expect(resolveToolRisk('mcp_search_tools')).toBe(RISK_BY_PROXY_TOOL.mcp_search_tools);
    expect(resolveToolRisk('mcp_call_tool')).toBe(RISK_BY_PROXY_TOOL.mcp_call_tool);
    expect(resolveToolRisk('ops_list_providers')).toBe('read');
    expect(resolveToolRisk('unknown_tool')).toBe('exec');
    expect(resolveToolRisk('grafana_query_prometheus', { risk: 'read' })).toBe('read');
  });

  it('mcp_list_servers / mcp_search_tools skip the 9-element brief when sessionRequiredFor=write-exec', async () => {
    const svc = makeApprovals();
    for (const name of ['mcp_list_servers', 'mcp_search_tools'] as const) {
      const viaPolicy = await evaluatePolicy(
        ctx({
          toolName: name,
          risk: resolveToolRisk(name),
          sessionRequiredFor: 'write-exec'
        })
      );
      expect(viaPolicy, name).toEqual({ block: false, needSessionApproval: false });
      const gated = await svc.gateToolCall('sess-1', name, {});
      expect(gated.block, name).toBe(false);
      expect(gated.needSessionApproval ?? false, name).toBe(false);
    }
  });

  it('mcp_call_tool still needs session approval as write', async () => {
    const svc = makeApprovals();
    const risk = resolveToolRisk('mcp_call_tool');
    expect(risk).toBe('write');
    const viaPolicy = await evaluatePolicy(
      ctx({ toolName: 'mcp_call_tool', risk, sessionRequiredFor: 'write-exec' })
    );
    expect(viaPolicy.block).toBe(false);
    if (!viaPolicy.block) {
      expect(viaPolicy.needSessionApproval).toBe(true);
    }
    const gated = await svc.gateToolCall('sess-1', 'mcp_call_tool', { server: 'docs', name: 'get' });
    expect(gated.block).toBe(false);
    expect(gated.needSessionApproval).toBe(true);
    expect(gated.risk).toBe('write');
  });

  it('unknown_tool remains exec and needs approval', async () => {
    const svc = makeApprovals();
    expect(resolveToolRisk('unknown_tool')).toBe('exec');
    const viaPolicy = await evaluatePolicy(
      ctx({ toolName: 'unknown_tool', risk: 'exec', sessionRequiredFor: 'write-exec' })
    );
    expect(viaPolicy.block).toBe(false);
    if (!viaPolicy.block) {
      expect(viaPolicy.needSessionApproval).toBe(true);
    }
    const gated = await svc.gateToolCall('sess-1', 'unknown_tool', {});
    expect(gated.block).toBe(false);
    expect(gated.needSessionApproval).toBe(true);
    expect(gated.risk).toBe('exec');
  });
});
