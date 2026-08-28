import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findStage,
  loadPlaybooks,
  STAGE_IDS,
  type Playbook,
  type RiskLevel
} from '../src/orchestrator';

const PLAYBOOK_ROOT = join(process.cwd(), 'skills', 'playbooks');

const RISK_ORDER: Record<RiskLevel, number> = { read: 0, write: 1, exec: 2 };

/** Highest riskCeiling any parallelGroup task of the playbook declares. */
function highestDeclaredRiskCeiling(pb: Playbook): RiskLevel {
  let highest: RiskLevel = 'read';
  for (const stage of pb.stages) {
    for (const task of stage.parallelGroup ?? []) {
      const ceiling = task.riskCeiling ?? 'read';
      if (RISK_ORDER[ceiling] > RISK_ORDER[highest]) {
        highest = ceiling;
      }
    }
  }
  return highest;
}

describe('playbooks · skills/playbooks catalog', () => {
  const playbooks = loadPlaybooks(PLAYBOOK_ROOT);
  const byId = new Map(playbooks.map((pb) => [pb.id, pb]));

  it('ships exactly the 8 known playbooks', () => {
    expect(playbooks.map((pb) => pb.id)).toEqual([
      'pb.config-change',
      'pb.db',
      'pb.host-emergency',
      'pb.incident',
      'pb.inspection',
      'pb.metric-anomaly',
      'pb.release',
      'pb.security-triage'
    ]);
  });

  it('each playbook is schema-shaped: id, integer version >= 1, non-empty stages/triggers', () => {
    const stageIdSet = new Set<string>(STAGE_IDS);
    for (const pb of playbooks) {
      expect(pb.id).toMatch(/^pb\.[a-z0-9-]+$/);
      expect(Number.isInteger(pb.version)).toBe(true);
      expect(pb.version).toBeGreaterThanOrEqual(1);
      expect(pb.triggers.length).toBeGreaterThan(0);
      expect(pb.stages.length).toBeGreaterThan(0);
      for (const stage of pb.stages) {
        expect(stageIdSet.has(stage.id)).toBe(true);
      }
    }
  });

  it('pb.incident investigating runs a parallelGroup of exactly 3 read-only investigators', () => {
    const incident = byId.get('pb.incident');
    expect(incident).toBeDefined();
    const investigating = findStage(incident!, 'investigating');
    expect(investigating?.parallelGroup).toHaveLength(3);
    expect(investigating!.parallelGroup!.map((t) => t.id)).toEqual([
      'inv-metrics',
      'inv-logs',
      'inv-changes'
    ]);
    for (const task of investigating!.parallelGroup!) {
      expect(task.role).toBe('investigator');
      expect(task.riskCeiling ?? 'read').toBe('read');
    }
    expect(incident!.defaults?.maxParallelInvestigators).toBe(3);
  });

  it('pb.security-triage stays read-only: its highest declared riskCeiling is read', () => {
    const securityTriage = byId.get('pb.security-triage');
    expect(securityTriage).toBeDefined();
    expect(highestDeclaredRiskCeiling(securityTriage!)).toBe('read');
    // Forensic collection is minimal-touch: investigator role only, no
    // executing / awaitingApproval stages in this playbook.
    const stageIds = securityTriage!.stages.map((s) => s.id);
    expect(stageIds).not.toContain('executing');
    expect(stageIds).not.toContain('awaitingApproval');
    expect(stageIds).toContain('escalated');
    expect(findStage(securityTriage!, 'reporting')?.artifact).toBe('security-triage');
  });

  it('no playbook task escalates beyond exec, and investigators never exceed read', () => {
    for (const pb of playbooks) {
      for (const stage of pb.stages) {
        for (const task of stage.parallelGroup ?? []) {
          const ceiling = task.riskCeiling ?? 'read';
          expect(RISK_ORDER[ceiling]).toBeLessThanOrEqual(RISK_ORDER.exec);
          if (task.role === 'investigator' || task.role === 'verifier') {
            expect(ceiling).toBe('read');
          }
        }
      }
    }
  });

  it('every reporting stage names an artifact and ships exactly one no-tool writer task', () => {
    for (const pb of playbooks) {
      const reporting = findStage(pb, 'reporting');
      expect(reporting?.artifact, `${pb.id} reporting.artifact`).toBeDefined();
      const writers = (reporting?.parallelGroup ?? []).filter((task) => task.role === 'writer');
      expect(writers, `${pb.id} reporting writer task`).toHaveLength(1);
      // Writer 无业务工具（docs/04 §3.1），只产出 ops-doc
      expect(writers[0].allowTools).toEqual([]);
      expect(writers[0].riskCeiling ?? 'read').toBe('read');
    }
  });

  it('every playbook starts at triage, ends at closed, and selects via the orchestrator', () => {
    for (const pb of playbooks) {
      expect(pb.stages[0].id).toBe('triage');
      expect(pb.stages[pb.stages.length - 1].id).toBe('closed');
      const selecting = findStage(pb, 'selecting');
      expect(selecting?.select?.mode, `${pb.id} selecting.select.mode`).toBe('replace');
      expect(selecting?.select?.pluginIds?.length).toBeGreaterThan(0);
    }
  });
});
