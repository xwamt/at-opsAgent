import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createOrchestrator,
  IllegalStageTransitionError,
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
