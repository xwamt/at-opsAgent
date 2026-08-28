import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createOrchestrator,
  IllegalStageTransitionError,
  injectPayloadCaps,
  loadPlaybooks,
  mergeEvidence,
  type EvidenceNote,
  type Orchestrator,
  type OrchestratorEvent,
  type Playbook
} from '../src/orchestrator';
import { hashCommandSet } from '../src/policy';

const PLAYBOOK_ROOT = join(process.cwd(), 'skills', 'playbooks');

describe('orchestrator · loadPlaybooks', () => {
  it('从 skills/playbooks 加载至少 8 条链路，id 全部匹配 ^pb\\.', () => {
    const playbooks = loadPlaybooks(PLAYBOOK_ROOT);
    expect(playbooks.length).toBeGreaterThanOrEqual(8);
    const ids = playbooks.map((pb) => pb.id);
    for (const id of ids) {
      expect(id).toMatch(/^pb\.[a-z0-9-]+$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const expected of [
      'pb.incident',
      'pb.metric-anomaly',
      'pb.release',
      'pb.config-change',
      'pb.db',
      'pb.host-emergency',
      'pb.inspection',
      'pb.security-triage'
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('阶段 id 都在 schema 联合类型内（加载即校验，坏 yaml 会 throw）', () => {
    const playbooks = loadPlaybooks(PLAYBOOK_ROOT);
    for (const pb of playbooks) {
      expect(pb.stages.length).toBeGreaterThan(0);
      expect(pb.stages[0].id).toBe('triage');
      expect(pb.stages[pb.stages.length - 1].id).toBe('closed');
    }
  });
});

describe('orchestrator · 状态机与下发', () => {
  let playbooks: Playbook[];
  let events: OrchestratorEvent[];
  let orch: Orchestrator;

  beforeEach(() => {
    playbooks = loadPlaybooks(PLAYBOOK_ROOT);
    events = [];
    orch = createOrchestrator({ playbooks, onEvent: (evt) => events.push(evt) });
  });

  it('startPlaybook 进入 triage 并发 stage 事件；未知 id 抛错', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    expect(run.stage).toBe('triage');
    expect(run.playbookId).toBe('pb.incident');
    expect(run.selectCount).toBe(0);
    expect(events).toContainEqual({
      type: 'playbook/stage',
      runId: run.id,
      playbookId: 'pb.incident',
      stage: 'triage'
    });
    expect(() => orch.startPlaybook('pb.nope', 'sess-1')).toThrow(/Unknown playbook/);
  });

  it('triage → selecting → investigating 合法迁移成功', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    orch.advanceTo(run, 'selecting');
    expect(run.stage).toBe('selecting');
    orch.advanceTo(run, 'investigating');
    expect(run.stage).toBe('investigating');
    const stageEvents = events.filter(
      (e): e is Extract<OrchestratorEvent, { type: 'playbook/stage' }> =>
        e.type === 'playbook/stage'
    );
    expect(stageEvents.map((e) => e.stage)).toEqual(['triage', 'selecting', 'investigating']);
  });

  it('非法迁移 investigating → closed 抛 IllegalStageTransitionError，状态不变', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    expect(() => orch.advanceTo(run, 'closed')).toThrow(IllegalStageTransitionError);
    expect(run.stage).toBe('investigating');
    expect(() => orch.advanceTo(run, 'triage')).toThrow(/非法阶段迁移/);
  });

  it('pb.incident 在 selecting 的 desiredSelect 是 replace 且 pluginIds 含 at.grafana', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    expect(orch.desiredSelect(run)).toBeUndefined(); // triage 无 select
    orch.advanceTo(run, 'selecting');
    const select = orch.desiredSelect(run);
    expect(select).toBeDefined();
    expect(select!.mode).toBe('replace');
    expect(select!.pluginIds).toContain('at.grafana');
    expect(orch.recordSelect(run)).toBe(1);
  });

  it('investigating 阶段 spawnSubagentSpecs 产出符合 task-spec@1 的 Investigator 规格', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');

    const specs = orch.spawnSubagentSpecs(run);
    expect(specs).toHaveLength(3); // inv-metrics / inv-logs / inv-changes
    for (const spec of specs) {
      expect(spec.specVersion).toBe(1);
      expect(spec.sessionId).toBe('sess-1');
      expect(spec.playbookId).toBe('pb.incident');
      expect(spec.stage).toBe('investigating');
      expect(spec.role).toBe('investigator');
      expect(spec.toolPolicy.select.mode).toBe('inherit');
      expect(spec.toolPolicy.riskCeiling).toBe('read');
      expect(spec.toolPolicy.budget.maxToolCalls).toBeGreaterThan(0);
      expect(spec.toolPolicy.budget.maxWallMs).toBeGreaterThan(0);
      expect(spec.output.contract).toBe('evidence-note@1');
    }
    const metrics = specs.find((s) => s.taskId.endsWith('inv-metrics'));
    expect(metrics?.toolPolicy.allowTools).toContain('grafana_query_prometheus');
    expect(metrics?.toolPolicy.payloadCaps).toMatchObject({ lokiLimit: 100 });

    // 只构造卡片数据，不真正跑 LLM：卡片 queued + upsert 事件
    expect(run.subagents.size).toBe(3);
    const upserts = events.filter(
      (e): e is Extract<OrchestratorEvent, { type: 'subagent/upsert' }> =>
        e.type === 'subagent/upsert'
    );
    expect(upserts).toHaveLength(3);
    for (const evt of upserts) {
      expect(evt.card.status).toBe('queued');
      expect(evt.card.riskCeiling).toBe('read');
    }
  });

  it('maxParallel 上限截断 parallelGroup（硬顶 4）', () => {
    const capped = createOrchestrator({ playbooks, maxParallel: 2 });
    const run = capped.startPlaybook('pb.incident', 'sess-1');
    capped.advanceTo(run, 'selecting');
    capped.advanceTo(run, 'investigating');
    expect(capped.spawnSubagentSpecs(run)).toHaveLength(2);

    const huge = createOrchestrator({ playbooks, maxParallel: 99 });
    const run2 = huge.startPlaybook('pb.incident', 'sess-2');
    huge.advanceTo(run2, 'selecting');
    huge.advanceTo(run2, 'investigating');
    expect(huge.spawnSubagentSpecs(run2).length).toBeLessThanOrEqual(4);
  });

  it('审批流：requestApproval → awaitingApproval；approved → executing', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');

    const commandSet = ['systemctl restart app'];
    const brief = orch.requestApproval(run, { risk: 'exec', commandSet });
    expect(run.stage).toBe('awaitingApproval');
    expect(run.pendingBrief?.briefId).toBe(brief.briefId);
    expect(brief.commandSetSha256).toBe(hashCommandSet(commandSet));

    const { run: updated } = orch.applyApproval({ brief, decision: 'approved' });
    expect(updated.stage).toBe('executing');
  });

  it('审批流：rejected → reporting，pendingBrief 清空', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');
    const brief = orch.requestApproval(run, { risk: 'write', commandSet: ['publish config'] });

    orch.applyApproval({ brief, decision: 'rejected' });
    expect(run.stage).toBe('reporting');
    expect(run.pendingBrief).toBeUndefined();
  });

  it('escalated 分支：investigating → escalated → closed', () => {
    const run = orch.startPlaybook('pb.security-triage', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'escalated');
    orch.advanceTo(run, 'closed');
    expect(run.stage).toBe('closed');
  });

  it('pb.security-triage 阶段锁：executing / awaitingApproval 不在 yaml 阶段集合，advanceTo 抛错', () => {
    const run = orch.startPlaybook('pb.security-triage', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');

    // synthesizing → awaitingApproval 全局合法，但该 playbook 未声明该阶段 → 锁死
    expect(() => orch.advanceTo(run, 'awaitingApproval')).toThrow(IllegalStageTransitionError);
    expect(run.stage).toBe('synthesizing');
    // requestApproval 内部走 advanceTo(awaitingApproval)，同样进不去
    expect(() =>
      orch.requestApproval(run, { risk: 'write', commandSet: ['kill -9 1234'] })
    ).toThrow(IllegalStageTransitionError);
    expect(run.stage).toBe('synthesizing');

    // 即便状态被外部强改到 awaitingApproval，executing 也不在阶段集合内
    run.stage = 'awaitingApproval';
    expect(() => orch.advanceTo(run, 'executing')).toThrow(IllegalStageTransitionError);
    expect(run.stage).toBe('awaitingApproval');
  });

  it('reporting 阶段 spawnSubagentSpecs 产出 Writer（ops-doc、allowTools []、goal 指向 artifact）', () => {
    const run = orch.startPlaybook('pb.metric-anomaly', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');
    orch.advanceTo(run, 'reporting');

    const specs = orch.spawnSubagentSpecs(run);
    expect(specs).toHaveLength(1);
    const writer = specs[0];
    expect(writer.role).toBe('writer');
    expect(writer.output.contract).toBe('ops-doc');
    expect(writer.toolPolicy.allowTools).toEqual([]);
    expect(writer.toolPolicy.riskCeiling).toBe('read');
    expect(writer.goal).toContain('evidence-only');
    expect(run.subagents.get(writer.taskId)?.status).toBe('queued');
  });

  it('yaml 无 parallelGroup 但声明 artifact 时也合成 Writer（reporting 兜底）', () => {
    const fixture: Playbook = {
      id: 'pb.writer-synth',
      version: 1,
      triggers: [{ kind: 'nl', patterns: ['writer'] }],
      stages: [
        { id: 'triage' },
        { id: 'selecting', select: { mode: 'replace', pluginIds: ['at.grafana'] } },
        { id: 'investigating' },
        { id: 'synthesizing' },
        { id: 'reporting', artifact: 'troubleshooting-report' },
        { id: 'closed' }
      ]
    };
    const local = createOrchestrator({ playbooks: [fixture] });
    const run = local.startPlaybook('pb.writer-synth', 'sess-1');
    local.advanceTo(run, 'selecting');
    local.advanceTo(run, 'investigating');
    local.advanceTo(run, 'synthesizing');
    local.advanceTo(run, 'reporting');

    const specs = local.spawnSubagentSpecs(run);
    expect(specs).toHaveLength(1);
    expect(specs[0].role).toBe('writer');
    expect(specs[0].output.contract).toBe('ops-doc');
    expect(specs[0].toolPolicy.allowTools).toEqual([]);
    expect(specs[0].goal).toContain('troubleshooting-report');
  });

  it('pb.release：guidedManual → verifying 合法（docs/04 §2.2），verifying → reporting 收尾', () => {
    const run = orch.startPlaybook('pb.release', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');
    orch.advanceTo(run, 'guidedManual');
    orch.advanceTo(run, 'verifying');
    expect(run.stage).toBe('verifying');
    orch.advanceTo(run, 'reporting');
    orch.advanceTo(run, 'closed');
    expect(run.stage).toBe('closed');
  });

  it('pb.config-change：guidedManual → reporting（mermaid 原边）保留；verifying 未声明则锁死', () => {
    const run = orch.startPlaybook('pb.config-change', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    orch.advanceTo(run, 'synthesizing');
    orch.advanceTo(run, 'guidedManual');
    // 该 playbook 没有 verifying 阶段 → guidedManual → verifying 被阶段锁拒绝
    expect(() => orch.advanceTo(run, 'verifying')).toThrow(IllegalStageTransitionError);
    orch.advanceTo(run, 'reporting');
    expect(run.stage).toBe('reporting');
  });

  it('desiredEscalateSelect 读取当前阶段 yaml 的 escalateSelect（仅一次 add 扩面）', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    expect(orch.desiredEscalateSelect(run)).toBeUndefined(); // triage 无 escalateSelect
    orch.advanceTo(run, 'selecting');
    expect(orch.desiredEscalateSelect(run)).toEqual({
      mode: 'add',
      pluginIds: ['at.jumpserver', 'at.terminal', 'at.jenkins']
    });
  });

  it('重试阶梯：failed 且有额度 → clone spec 加 -retry 后缀；额度用尽 → undefined', () => {
    const run = orch.startPlaybook('pb.incident', 'sess-1');
    orch.advanceTo(run, 'selecting');
    orch.advanceTo(run, 'investigating');
    const specs = orch.spawnSubagentSpecs(run);
    const first = specs[0];

    const retry = orch.recordSubagentResult(first.taskId, 'failed');
    expect(retry).toBeDefined();
    expect(retry!.taskId).toBe(`${first.taskId}-retry`);
    expect(retry!.role).toBe(first.role);
    expect(retry!.goal).toBe(first.goal);
    expect(retry!.escalation?.retries).toBe(0);
    // 原卡片标 failed，重试卡片以 queued 登记
    expect(run.subagents.get(first.taskId)?.status).toBe('failed');
    expect(run.subagents.get(retry!.taskId)?.status).toBe('queued');

    // 重试再失败：额度用尽 → undefined（host 走 degrade）
    expect(orch.recordSubagentResult(retry!.taskId, 'failed')).toBeUndefined();

    // 成功结果只更新卡片，不产生重试
    expect(orch.recordSubagentResult(specs[1].taskId, 'ok')).toBeUndefined();
    expect(run.subagents.get(specs[1].taskId)?.status).toBe('ok');

    expect(() => orch.recordSubagentResult('no-such-task', 'failed')).toThrow(
      /Unknown subagent task/
    );
  });
});

describe('orchestrator · injectPayloadCaps', () => {
  const caps = { lokiLimit: 100, maxOutputBytes: 65536 };

  it('loki 工具缺 limit → 注入 lokiLimit，且不改传入 args', () => {
    const args = { query: '{app="web"} |= "error"' };
    const injected = injectPayloadCaps('grafana_query_loki', args, caps);
    expect(injected).toEqual({ query: '{app="web"} |= "error"', limit: 100 });
    expect(args).not.toHaveProperty('limit');
  });

  it('调用方已给 limit → 不覆盖', () => {
    const args = { query: 'x', limit: 10 };
    expect(injectPayloadCaps('grafana_query_loki', args, caps)).toBe(args);
  });

  it('非 loki 工具 / 无 caps / caps 缺 lokiLimit → 原样返回', () => {
    const args = { query: 'up' };
    expect(injectPayloadCaps('grafana_query_prometheus', args, caps)).toBe(args);
    expect(injectPayloadCaps('grafana_query_loki', args, undefined)).toBe(args);
    expect(injectPayloadCaps('grafana_query_loki', args, { maxOutputBytes: 1 })).toBe(args);
  });
});

describe('orchestrator · mergeEvidence', () => {
  const win = { from: '2026-08-28T07:00:00Z', to: '2026-08-28T07:30:00Z' };

  function note(overrides: Partial<EvidenceNote> & Pick<EvidenceNote, 'id' | 'taskId'>): EvidenceNote {
    return {
      confidence: 'confirmed',
      summary: `summary of ${overrides.id}`,
      timeWindow: win,
      ...overrides
    };
  }

  it('同 timeWindow 的对立结论互相登记 conflicts，不静默取舍', () => {
    const merged = mergeEvidence([
      note({ id: 'ev-1', taskId: 't-metrics', summary: '峰值由发布引起' }),
      note({ id: 'ev-2', taskId: 't-logs', summary: '峰值由批处理任务引起' })
    ]);
    expect(merged[0].conflicts).toContain('ev-2');
    expect(merged[1].conflicts).toContain('ev-1');
  });

  it('不同 timeWindow 不算冲突；同 taskId / 同结论不算冲突', () => {
    const merged = mergeEvidence([
      note({ id: 'ev-1', taskId: 't-a', summary: 'X' }),
      note({
        id: 'ev-2',
        taskId: 't-b',
        summary: 'Y',
        timeWindow: { from: '2026-08-28T09:00:00Z', to: '2026-08-28T09:30:00Z' }
      }),
      note({ id: 'ev-3', taskId: 't-a', summary: 'Z', confidence: 'hypothesis' }),
      note({ id: 'ev-4', taskId: 't-c', summary: 'X' })
    ]);
    for (const item of merged) {
      expect(item.conflicts).toEqual([]);
    }
  });

  it('hypothesis 与 confirmed 并存不算冲突（除非同 subject）', () => {
    const calm = mergeEvidence([
      note({ id: 'ev-1', taskId: 't-a', summary: 'X' }),
      note({ id: 'ev-2', taskId: 't-b', summary: 'Y', confidence: 'hypothesis' })
    ]);
    expect(calm[0].conflicts).toEqual([]);
    expect(calm[1].conflicts).toEqual([]);

    const clash = mergeEvidence([
      note({ id: 'ev-1', taskId: 't-a', summary: 'X', subject: 'root-cause', confidence: 'hypothesis' }),
      note({ id: 'ev-2', taskId: 't-b', summary: 'Y', subject: 'root-cause', confidence: 'hypothesis' })
    ]);
    expect(clash[0].conflicts).toContain('ev-2');
    expect(clash[1].conflicts).toContain('ev-1');
  });

  it('不修改输入便签（返回副本）', () => {
    const input = [
      note({ id: 'ev-1', taskId: 't-a', summary: 'X' }),
      note({ id: 'ev-2', taskId: 't-b', summary: 'Y' })
    ];
    const merged = mergeEvidence(input);
    expect(input[0].conflicts).toBeUndefined();
    expect(merged[0]).not.toBe(input[0]);
  });
});
