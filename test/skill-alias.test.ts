/**
 * skill 路径别名（docs/12）：模型常按 playbook id 短名猜目录
 * （playbooks/inspection/…），readSkillFile 在 lookup 前重写到真实目录。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SKILL_PATH_ALIASES,
  applySkillPathAliases,
  readSkillFile
} from '../src/runtime/resource-loader';

describe('SKILL_PATH_ALIASES', () => {
  it('覆盖 5 个 id 短名 → 真实目录映射', () => {
    expect(SKILL_PATH_ALIASES).toEqual({
      'playbooks/inspection/': 'playbooks/daily-inspection/',
      'playbooks/incident/': 'playbooks/incident-response/',
      'playbooks/db/': 'playbooks/db-slow-and-capacity/',
      'playbooks/release/': 'playbooks/release-rollback/',
      'playbooks/host/': 'playbooks/host-emergency/'
    });
  });

  it('applySkillPathAliases：前缀重写、目录本身、非别名原样返回', () => {
    expect(applySkillPathAliases('playbooks/inspection/SKILL.md')).toBe(
      'playbooks/daily-inspection/SKILL.md'
    );
    expect(applySkillPathAliases('playbooks/incident/references/triage.md')).toBe(
      'playbooks/incident-response/references/triage.md'
    );
    expect(applySkillPathAliases('playbooks/db/SKILL.md')).toBe(
      'playbooks/db-slow-and-capacity/SKILL.md'
    );
    expect(applySkillPathAliases('playbooks/release/SKILL.md')).toBe(
      'playbooks/release-rollback/SKILL.md'
    );
    expect(applySkillPathAliases('playbooks/host/SKILL.md')).toBe(
      'playbooks/host-emergency/SKILL.md'
    );
    // 恰为别名目录本身（无结尾斜杠）也重写
    expect(applySkillPathAliases('playbooks/inspection')).toBe('playbooks/daily-inspection');
    // 真实目录与无关路径原样返回
    expect(applySkillPathAliases('playbooks/daily-inspection/SKILL.md')).toBe(
      'playbooks/daily-inspection/SKILL.md'
    );
    expect(applySkillPathAliases('ops-agent-core/SKILL.md')).toBe('ops-agent-core/SKILL.md');
    // 别名只按前缀命中：inspection-x 不是 inspection/
    expect(applySkillPathAliases('playbooks/inspection-x/SKILL.md')).toBe(
      'playbooks/inspection-x/SKILL.md'
    );
  });

  it('readSkillFile 在 lookup 前应用别名（playbooks/inspection/SKILL.md 命中 daily-inspection）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ops-skill-alias-'));
    mkdirSync(join(root, 'playbooks', 'daily-inspection'), { recursive: true });
    writeFileSync(join(root, 'playbooks', 'daily-inspection', 'SKILL.md'), '# 巡检 skill');

    const hit = await readSkillFile([root], 'playbooks/inspection/SKILL.md');
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.path).toBe(join(root, 'playbooks', 'daily-inspection', 'SKILL.md'));
      expect(hit.content).toContain('巡检 skill');
    }

    // 别名后的路径仍受穿越校验保护
    const traversal = await readSkillFile([root], 'playbooks/inspection/../../etc/passwd');
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error).toContain('不合法');
  });

  it('别名目标在真打包 skills 里都存在（对照 skills/playbooks）', async () => {
    const bundled = join(process.cwd(), 'skills');
    for (const alias of Object.keys(SKILL_PATH_ALIASES)) {
      const result = await readSkillFile([bundled], `${alias}SKILL.md`);
      expect(result.ok, `${alias}SKILL.md 应命中真实目录`).toBe(true);
    }
  });
});
