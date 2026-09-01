/**
 * 提示词适配契约：常驻层预算、产物名与 ops-documents 对齐、
 * 发现 loop 单真源、L3 按场景触发。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findStage, loadPlaybooks } from '../src/orchestrator';
import {
  L0_CORE,
  L0_MAIN_BOOTSTRAP,
  L1_SAFETY_REDLINES,
  L2_TOOL_DISCOVERY,
  L3_OUTPUT_FORMAT
} from '../src/prompts/layers';
import { ROLE_LAYERS } from '../src/prompts/roles';
import { discoveryToolSpecs } from '../src/runtime/discovery-tools';
import { OPS_DOC_TYPES } from '../src/runtime/workspace-write';

const SKILLS = join(process.cwd(), 'skills');

function nonEmptyLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

describe('常驻层预算', () => {
  it('L2 不超过 14 行；L0+L1+L2 合计不超过 40 行', () => {
    expect(nonEmptyLines(L2_TOOL_DISCOVERY)).toBeLessThanOrEqual(14);
    const resident = [L0_CORE, L0_MAIN_BOOTSTRAP, L1_SAFETY_REDLINES, L2_TOOL_DISCOVERY].join('\n');
    expect(nonEmptyLines(resident)).toBeLessThanOrEqual(40);
  });

  it('L2 不含 skill 路径别名、nacos 易错点、waitMs 派单参数', () => {
    expect(L2_TOOL_DISCOVERY).not.toContain('pb.inspection→');
    expect(L2_TOOL_DISCOVERY).not.toContain('nacos_list_instances');
    expect(L2_TOOL_DISCOVERY).not.toContain('waitMs');
  });
});

describe('产物名与 ops-documents 对齐', () => {
  it('L3 / Writer 使用六类 docType，不含 service-inspection / service-deployment', () => {
    for (const docType of OPS_DOC_TYPES) {
      expect(L3_OUTPUT_FORMAT).toContain(docType);
      expect(ROLE_LAYERS.writer).toContain(docType);
    }
    expect(L3_OUTPUT_FORMAT).not.toContain('service-inspection');
    expect(L3_OUTPUT_FORMAT).not.toContain('service-deployment');
    expect(ROLE_LAYERS.writer).not.toContain('service-inspection');
    expect(ROLE_LAYERS.writer).not.toContain('service-deployment');
  });

  it('pb.inspection / pb.release 的 reporting.artifact 与 ops-documents 同名', () => {
    const byId = new Map(loadPlaybooks(join(SKILLS, 'playbooks')).map((pb) => [pb.id, pb]));
    expect(findStage(byId.get('pb.inspection')!, 'reporting')?.artifact).toBe('inspection-report');
    expect(findStage(byId.get('pb.release')!, 'reporting')?.artifact).toBe('deployment');
  });
});

describe('发现 loop 单真源', () => {
  it('ops_list_providers 描述不要求「开始任务前先看这里」', () => {
    const spec = discoveryToolSpecs.find((s) => s.name === 'ops_list_providers');
    expect(spec?.description).toBeDefined();
    expect(spec!.description).not.toContain('开始任务前先看这里');
    expect(spec!.description).toContain('L-env');
  });

  it('ops-agent-core 与巡检 skill 先读 L-env，不教 list_providers 仪式', () => {
    const core = readFileSync(join(SKILLS, 'ops-agent-core/SKILL.md'), 'utf8');
    expect(core).toContain('L-env');
    expect(core).not.toMatch(/ops_list_providers\s*→/);

    const inspection = readFileSync(join(SKILLS, 'playbooks/daily-inspection/SKILL.md'), 'utf8');
    expect(inspection).toContain('L-env');
    expect(inspection).not.toMatch(/1\.\s*ops_list_providers/);

    const triage = readFileSync(join(SKILLS, 'playbooks/daily-inspection/references/triage.md'), 'utf8');
    expect(triage).toContain('L-env');
    expect(triage).not.toMatch(/第一步认目标：ops_list_providers/);
  });
});

describe('L3 按场景触发', () => {
  it('evidence-note 仅调查/合成；九要素仅无插件弹窗的写；闲聊不出仪式', () => {
    expect(L3_OUTPUT_FORMAT).toMatch(/调查.*evidence-note@1/);
    expect(L3_OUTPUT_FORMAT).toMatch(/闲聊.*不要出便签|不要出便签.*闲聊/);
    expect(L3_OUTPUT_FORMAT).toMatch(/插件确认/);
    expect(L3_OUTPUT_FORMAT).toMatch(/at\.database/);
    expect(L3_OUTPUT_FORMAT).toMatch(/不要再出 9 要素会话简报/);
  });
});
