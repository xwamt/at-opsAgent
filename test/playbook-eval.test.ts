/**
 * 轻量 playbook 评测（不跑 LLM）：真实 skills/playbooks 的 pb.inspection
 * 走 orchestrator 全生命周期 triage → … → closed，并把 select 指令对照
 * test/fixtures/bridges 的桥目录校验——选中的插件必须真实存在且带工具，
 * 保证 playbook yaml 与插件桥形状不脱节。
 *
 * Plan 03：host PlaybookService.closePlaybook 必须走 closeRun（不能两步
 * tryAdvance reporting→closed），所以这里用真 orchestrator + 窄 HostContext
 * 替身覆盖 investigating 一次 close。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue
    })
  },
  commands: { executeCommand: () => Promise.resolve() }
}));

import { createOpsCore } from '../src/core';
import type { HostContext } from '../src/host/services/context';
import { PlaybookService } from '../src/host/services/playbookService';
import { SessionStore } from '../src/host/sessionStore';
import {
  createOrchestrator,
  loadPlaybooks,
  STAGE_TRANSITIONS,
  type OrchestratorEvent
} from '../src/orchestrator';
import { listBridgeFixturePluginIds, loadBridgeFixture } from './fixtures/bridges';

const PLAYBOOK_ROOT = join(process.cwd(), 'skills', 'playbooks');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  it('investigating 一次 closeRun → synthesizing → reporting → closed', () => {
    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      playbooks: loadPlaybooks(PLAYBOOK_ROOT),
      onEvent: (event) => events.push(event)
    });
    const run = orchestrator.startPlaybook('pb.inspection', 'sess-close');
    orchestrator.advanceTo(run, 'selecting');
    orchestrator.advanceTo(run, 'investigating');
    events.length = 0;
    expect(orchestrator.closeRun(run).stage).toBe('closed');
    const stageSeq = events
      .filter(
        (event): event is Extract<OrchestratorEvent, { type: 'playbook/stage' }> =>
          event.type === 'playbook/stage'
      )
      .map((event) => event.stage);
    expect(stageSeq).toEqual(['synthesizing', 'reporting', 'closed']);
  });
});

function createPlaybookServiceHarness(): {
  svc: PlaybookService;
  sid: string;
  clears: string[];
  stages: string[];
} {
  const dir = mkdtempSync(join(os.tmpdir(), 'at-ops-pb-close-'));
  tempDirs.push(dir);
  const store = new SessionStore({ filePath: join(dir, 'ui-sessions.json') });
  const clears: string[] = [];
  const stages: string[] = [];
  const ctx = {
    core: createOpsCore(),
    playbooksDir: PLAYBOOK_ROOT,
    store,
    hub: {
      selection: {
        select: async () => {},
        clear: async () => {
          clears.push('playbook-closed');
        }
      },
      listAllTools: () => [],
      listExposedTools: () => []
    },
    chat: { runtimeFor: () => undefined },
    log: () => {},
    broadcastToSession: (_sid: string, type: string, payload: unknown) => {
      if (type === 'playbook/stage' && payload && typeof payload === 'object' && payload !== null) {
        const stage = (payload as { stage?: unknown }).stage;
        if (typeof stage === 'string') stages.push(stage);
      }
    },
    emitAssistantNotice: () => {},
    approvals: { registerBrief: () => {}, handleResolvedEvent: () => {} }
  } as unknown as HostContext;
  return { svc: new PlaybookService(ctx), sid: store.activeSessionId, clears, stages };
}

describe('playbook eval · PlaybookService.closePlaybook（closeRun 单真源）', () => {
  it('pb.inspection：start + 首条 prompt 驱动后一次 close → closed，并 clear selection', async () => {
    const { svc, sid, clears, stages } = createPlaybookServiceHarness();
    const started = await svc.startPlaybook('pb.inspection', undefined, sid);
    expect(started.ok).toBe(true);
    await svc.advancePlaybookForPrompt(sid);
    const run = svc.runOf(sid);
    expect(run).toBeDefined();
    expect(svc.currentStage(run!, sid)).toBe('investigating');

    const closed = await svc.closePlaybook(sid);
    expect(closed).toEqual({ ok: true, stage: 'closed' });
    expect(svc.runOf(sid)).toBeUndefined();
    expect(clears).toEqual(['playbook-closed']);
    expect(stages).toEqual(expect.arrayContaining(['synthesizing', 'reporting', 'closed']));
    const fromInvestigating = stages.slice(stages.lastIndexOf('investigating') + 1);
    expect(fromInvestigating).toEqual(['synthesizing', 'reporting', 'closed']);
  });

  it('无 run → ok=false 且不 clear selection', async () => {
    const { svc, sid, clears } = createPlaybookServiceHarness();
    const result = await svc.closePlaybook(sid);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/没有进行中/);
    expect(clears).toEqual([]);
  });

  it('investigating 缺省 advance → synthesizing；显式 closed → allowedNext 含 synthesizing', async () => {
    const { svc, sid } = createPlaybookServiceHarness();
    await svc.startPlaybook('pb.inspection', undefined, sid);
    await svc.advancePlaybookForPrompt(sid);
    expect(svc.currentStage(svc.runOf(sid)!, sid)).toBe('investigating');

    const advanced = await svc.advancePlaybook(undefined, sid);
    expect(advanced).toEqual({ ok: true, stage: 'synthesizing' });

    const { svc: svc2, sid: sid2 } = createPlaybookServiceHarness();
    await svc2.startPlaybook('pb.inspection', undefined, sid2);
    await svc2.advancePlaybookForPrompt(sid2);
    const rejected = await svc2.advancePlaybook('closed', sid2);
    expect(rejected.ok).toBe(false);
    expect(rejected.stage).toBe('investigating');
    expect(rejected.allowedNext).toContain('synthesizing');
  });
});

describe('playbook eval · 8 条链路 close 路径（无 LLM）', () => {
  const playbooks = loadPlaybooks(PLAYBOOK_ROOT);

  it('skills/playbooks 恰好覆盖 8 条 yaml', () => {
    expect(playbooks.map((pb) => pb.id).sort()).toEqual(
      [
        'pb.config-change',
        'pb.db',
        'pb.host-emergency',
        'pb.incident',
        'pb.inspection',
        'pb.metric-anomaly',
        'pb.release',
        'pb.security-triage'
      ].sort()
    );
  });

  it.each(playbooks.map((pb) => [pb.id, pb] as const))(
    '%s：yaml 阶段均在 STAGE_TRANSITIONS；startPlaybook → closeRun → closed',
    (id, pb) => {
      for (const stage of pb.stages) {
        expect(STAGE_TRANSITIONS[stage.id]).toBeDefined();
      }
      const orchestrator = createOrchestrator({ playbooks });
      const run = orchestrator.startPlaybook(id, `sess-eval-${id}`);
      expect(orchestrator.closeRun(run).stage).toBe('closed');
      expect(orchestrator.getRun(run.id)?.stage).toBe('closed');
    }
  );

  it('pb.security-triage 的 legalNext 不含 executing', () => {
    const orchestrator = createOrchestrator({ playbooks });
    const run = orchestrator.startPlaybook('pb.security-triage', 'sess-sec');
    const walk: Array<'selecting' | 'investigating' | 'synthesizing' | 'reporting'> = [
      'selecting',
      'investigating',
      'synthesizing',
      'reporting'
    ];
    expect(orchestrator.legalNextStages(run)).not.toContain('executing');
    for (const stage of walk) {
      orchestrator.advanceTo(run, stage);
      expect(orchestrator.legalNextStages(run)).not.toContain('executing');
    }
  });
});


