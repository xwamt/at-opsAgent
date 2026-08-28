/**
 * 最小编排兜底：src/orchestrator 模块整体缺失时保证 playbook/start 不崩。
 *
 * - startPlaybook：有 select 阶段则直接落在该阶段（desiredSelect 可取）
 * - applyApproval：只记录决策（token 签发/状态机属于真 orchestrator）
 * - loadPlaybooksFallback：js-yaml 扫描 skills/playbooks/<id>/playbook.yaml
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { SelectToolsInput } from '../../protocol';
import type {
  OrchestratorEventLike,
  OrchestratorLike,
  PlaybookMeta,
  PlaybookRunLike
} from '../hostTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSelect(value: unknown): SelectToolsInput | undefined {
  if (!isRecord(value)) return undefined;
  const select: SelectToolsInput = {};
  if (Array.isArray(value.pluginIds)) {
    select.pluginIds = value.pluginIds.filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(value.names)) {
    select.names = value.names.filter((v): v is string => typeof v === 'string');
  }
  if (value.mode === 'replace' || value.mode === 'add') select.mode = value.mode;
  return select;
}

export async function loadPlaybooksFallback(rootDir: string): Promise<PlaybookMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch {
    return [];
  }
  const playbooks: PlaybookMeta[] = [];
  for (const entry of entries.sort()) {
    const file = path.join(rootDir, entry, 'playbook.yaml');
    let raw: unknown;
    try {
      raw = parseYaml(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(raw) || typeof raw.id !== 'string') continue;
    const stages = Array.isArray(raw.stages)
      ? raw.stages.filter(isRecord).map((stage) => ({
          id: typeof stage.id === 'string' ? stage.id : '',
          select: toSelect(stage.select)
        }))
      : undefined;
    playbooks.push({
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      stages
    });
  }
  return playbooks;
}

export class FallbackOrchestrator implements OrchestratorLike {
  private runSeq = 0;
  private readonly runs = new Map<string, PlaybookRunLike>();

  constructor(
    private readonly playbooks: PlaybookMeta[],
    private readonly onEvent: (event: OrchestratorEventLike) => void,
    private readonly log: (message: string) => void
  ) {}

  startPlaybook(playbookId: string, _sessionId: string): PlaybookRunLike {
    const playbook = this.playbooks.find((p) => p.id === playbookId);
    if (!playbook) {
      throw new Error(`未知 playbook ${playbookId}`);
    }
    const selectStage = playbook.stages?.find((s) => s.select !== undefined);
    const stage = selectStage
      ? selectStage.id || 'selecting'
      : playbook.stages?.[0]?.id ?? 'triage';
    const run: PlaybookRunLike = {
      id: `fallback-run-${++this.runSeq}`,
      playbookId,
      stage
    };
    this.runs.set(run.id, run);
    this.onEvent({ type: 'playbook/stage', runId: run.id, playbookId, stage });
    return run;
  }

  desiredSelect(runOrId: PlaybookRunLike | string): SelectToolsInput | undefined {
    const run = typeof runOrId === 'string' ? this.runs.get(runOrId) : runOrId;
    if (!run) return undefined;
    const playbook = this.playbooks.find((p) => p.id === run.playbookId);
    return playbook?.stages?.find((s) => s.id === run.stage)?.select;
  }

  applyApproval(input: {
    brief: { briefId: string; runId: string };
    decision: 'approved' | 'rejected';
  }): unknown {
    // 真 orchestrator 负责 approvalToken 签发/作废与状态机迁移。
    this.log(
      `[fallback-orchestrator] approval ${input.brief.briefId} → ${input.decision}` +
        '（orchestrator 模块未就绪，未签发 token）'
    );
    this.onEvent({
      type: 'approval/resolved',
      runId: input.brief.runId,
      briefId: input.brief.briefId,
      decision: input.decision
    });
    return { ok: false, reason: 'orchestrator module not available' };
  }
}
