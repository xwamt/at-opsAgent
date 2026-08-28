/**
 * 轻量 playbook 评测（不跑 LLM）：真实 skills/playbooks 的 pb.inspection
 * 走 orchestrator 全生命周期 triage → … → closed，并把 select 指令对照
 * test/fixtures/bridges 的桥目录校验——选中的插件必须真实存在且带工具，
 * 保证 playbook yaml 与插件桥形状不脱节。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createOrchestrator,
  loadPlaybooks,
  type OrchestratorEvent
} from '../src/orchestrator';
import { listBridgeFixturePluginIds, loadBridgeFixture } from './fixtures/bridges';

const PLAYBOOK_ROOT = join(process.cwd(), 'skills', 'playbooks');

describe('playbook eval · pb.inspection 全生命周期（orchestrator，无 LLM）', () => {
  it('triage → selecting → investigating → synthesizing → reporting → closed，select 可被 fixture 桥满足', () => {
    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      playbooks: loadPlaybooks(PLAYBOOK_ROOT),
      onEvent: (event) => events.push(event)
    });

    const run = orchestrator.startPlaybook('pb.inspection', 'sess-eval');
    expect(run.stage).toBe('triage');

    // selecting：orchestrator 代发 select；目标插件必须在 fixture 桥目录里且有工具。
    orchestrator.advanceTo(run, 'selecting');
    const select = orchestrator.desiredSelect(run);
    expect(select?.mode).toBe('replace');
    // 巡检实录回归（docs/12）：首轮 select 必须精确等于 [at.terminal]
    // （客户端优先），不是 Grafana、也不接受「非空即可」。
    expect(select?.pluginIds).toEqual(['at.terminal']);
    const fixtureIds = new Set(listBridgeFixturePluginIds());
    for (const pluginId of select?.pluginIds ?? []) {
      expect(fixtureIds.has(pluginId)).toBe(true);
      const record = loadBridgeFixture(pluginId);
      expect(record.tools.length).toBeGreaterThan(0);
      for (const tool of record.tools) {
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
      }
    }
    expect(orchestrator.recordSelect(run)).toBe(1);

    // escalateSelect 只声明一次 add 扩面，host 不自动应用；
    // 扩面必须点名 Grafana/Nacos/Jenkins（首轮不选，升级时才加）。
    const escalate = orchestrator.desiredEscalateSelect(run);
    expect(escalate?.mode).toBe('add');
    expect(escalate?.pluginIds).toEqual(
      expect.arrayContaining(['at.grafana', 'at.nacos', 'at.jenkins'])
    );

    // investigating：3 个只读 investigator，evidence-note@1 契约、预算齐全。
    orchestrator.advanceTo(run, 'investigating');
    const specs = orchestrator.spawnSubagentSpecs(run);
    expect(specs).toHaveLength(3);
    for (const spec of specs) {
      expect(spec.specVersion).toBe(1);
      expect(spec.sessionId).toBe('sess-eval');
      expect(spec.role).toBe('investigator');
      expect(spec.toolPolicy.riskCeiling).toBe('read');
      expect(spec.toolPolicy.budget.maxToolCalls).toBeGreaterThan(0);
      expect(spec.output.contract).toBe('evidence-note@1');
    }

    // synthesizing → reporting：advanceStage 缺省走主路径；writer 产出 ops-doc。
    orchestrator.advanceTo(run, 'synthesizing');
    expect(orchestrator.advanceStage(run).stage).toBe('reporting');
    const writers = orchestrator.spawnSubagentSpecs(run);
    expect(writers).toHaveLength(1);
    expect(writers[0]!.role).toBe('writer');
    expect(writers[0]!.output.contract).toBe('ops-doc');
    expect(writers[0]!.toolPolicy.allowTools).toEqual([]);

    // closeRun 收尾；阶段事件序列完整、逐步发出。
    expect(orchestrator.closeRun(run).stage).toBe('closed');
    expect(orchestrator.getRun(run.id)?.stage).toBe('closed');
    const stageSeq = events
      .filter(
        (event): event is Extract<OrchestratorEvent, { type: 'playbook/stage' }> =>
          event.type === 'playbook/stage'
      )
      .map((event) => event.stage);
    expect(stageSeq).toEqual([
      'triage',
      'selecting',
      'investigating',
      'synthesizing',
      'reporting',
      'closed'
    ]);
  });
});
