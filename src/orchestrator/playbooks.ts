/**
 * Playbook 加载与校验。
 *
 * 类型与 docs/schemas/playbook.schema.json 一一对应；yaml 来自打包的
 * skills/playbooks/<id>/playbook.yaml，不在运行时接受用户任意 yaml。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

export const STAGE_IDS = [
  'triage',
  'selecting',
  'investigating',
  'synthesizing',
  'awaitingApproval',
  'executing',
  'verifying',
  'guidedManual',
  'reporting',
  'escalated',
  'closed'
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export type RiskLevel = 'read' | 'write' | 'exec';

export type SubagentRole = 'investigator' | 'executor' | 'writer' | 'verifier';

export type SelectDirective = {
  mode: 'replace' | 'add';
  pluginIds?: string[];
  names?: string[];
};

export type EscalateSelectDirective = {
  mode: 'add';
  pluginIds?: string[];
};

export type ParallelTaskDef = {
  id: string;
  role: SubagentRole;
  allowTools?: string[];
  riskCeiling?: RiskLevel;
  goal?: string;
};

export type GuidedManualDef = {
  command?: string;
  hint?: string;
};

export type ArtifactKind =
  | 'troubleshooting-report'
  | 'operation-record'
  | 'service-deployment'
  | 'service-inspection'
  | 'evidence-only'
  | 'security-triage';

export type PlaybookStage = {
  id: StageId;
  prompt?: string;
  select?: SelectDirective;
  escalateSelect?: EscalateSelectDirective;
  parallelGroup?: ParallelTaskDef[];
  guidedManual?: GuidedManualDef;
  artifact?: ArtifactKind;
};

export type PlaybookTrigger = {
  kind: 'nl' | 'board' | 'alert-paste' | 'command';
  patterns?: string[];
};

export type PlaybookDefaults = {
  maxParallelInvestigators?: number;
  payloadCaps?: Record<string, unknown>;
};

export type Playbook = {
  id: string;
  version: number;
  title?: string;
  description?: string;
  triggers: PlaybookTrigger[];
  defaults?: PlaybookDefaults;
  stages: PlaybookStage[];
};

const PLAYBOOK_ID_RE = /^pb\.[a-z0-9-]+$/;

const STAGE_ID_SET: ReadonlySet<string> = new Set(STAGE_IDS);

function fail(file: string, message: string): never {
  throw new Error(`Invalid playbook ${file}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePlaybook(raw: unknown, file: string): Playbook {
  if (!isRecord(raw)) fail(file, 'root is not a mapping');
  const { id, version, triggers, stages } = raw;
  if (typeof id !== 'string' || !PLAYBOOK_ID_RE.test(id)) {
    fail(file, `id must match ${PLAYBOOK_ID_RE} (got ${JSON.stringify(id)})`);
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail(file, 'version must be an integer >= 1');
  }
  if (!Array.isArray(triggers) || triggers.length === 0) {
    fail(file, 'triggers must be a non-empty array');
  }
  if (!Array.isArray(stages) || stages.length === 0) {
    fail(file, 'stages must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const stage of stages) {
    if (!isRecord(stage) || typeof stage.id !== 'string' || !STAGE_ID_SET.has(stage.id)) {
      fail(file, `unknown stage id ${JSON.stringify(isRecord(stage) ? stage.id : stage)}`);
    }
    if (seen.has(stage.id)) fail(file, `duplicate stage id ${stage.id}`);
    seen.add(stage.id);
    if (stage.parallelGroup !== undefined) {
      if (!Array.isArray(stage.parallelGroup)) fail(file, `stage ${stage.id}: parallelGroup must be an array`);
      for (const task of stage.parallelGroup) {
        if (!isRecord(task) || typeof task.id !== 'string' || typeof task.role !== 'string') {
          fail(file, `stage ${stage.id}: parallelGroup entries need id and role`);
        }
      }
    }
  }
  return raw as unknown as Playbook;
}

function findPlaybookFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findPlaybookFiles(full, out);
    } else if (entry.isFile() && entry.name === 'playbook.yaml') {
      out.push(full);
    }
  }
}

/**
 * 递归加载 rootDir 下所有 playbook.yaml。
 * 任一文件不合法（id 不匹配 ^pb\. 、阶段 id 越界等）直接 throw，
 * 打包资源坏了应当在启动时暴露而不是静默降级。
 */
export function loadPlaybooks(rootDir: string): Playbook[] {
  const files: string[] = [];
  findPlaybookFiles(rootDir, files);
  const playbooks = files.map((file) =>
    validatePlaybook(parseYaml(readFileSync(file, 'utf8')), file)
  );
  const ids = new Set<string>();
  for (const pb of playbooks) {
    if (ids.has(pb.id)) throw new Error(`Duplicate playbook id ${pb.id} under ${rootDir}`);
    ids.add(pb.id);
  }
  return playbooks.sort((a, b) => a.id.localeCompare(b.id));
}

export function findStage(playbook: Playbook, stageId: StageId): PlaybookStage | undefined {
  return playbook.stages.find((stage) => stage.id === stageId);
}
