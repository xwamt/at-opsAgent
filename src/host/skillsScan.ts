/**
 * 技能清单扫描（vscode-free）：<extensionPath>/skills/ops-agent-core 与
 * skills/playbooks/<id>/SKILL.md。SkillsTreeProvider 与设置页共用同一真源。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface SkillInfo {
  label: string;
  description?: string;
  skillFile: string;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function listSkills(extensionPath: string): Promise<SkillInfo[]> {
  const skillsDir = path.join(extensionPath, 'skills');
  const nodes: SkillInfo[] = [];

  const coreSkill = path.join(skillsDir, 'ops-agent-core', 'SKILL.md');
  if (await fileExists(coreSkill)) {
    nodes.push({ label: 'ops-agent-core', description: '核心身份与安全红线', skillFile: coreSkill });
  }

  const playbooksDir = path.join(skillsDir, 'playbooks');
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(playbooksDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // skills/playbooks 缺失：不报错，清单为空。
  }
  for (const entry of entries) {
    const skillFile = path.join(playbooksDir, entry, 'SKILL.md');
    if (await fileExists(skillFile)) {
      nodes.push({ label: entry, description: 'playbook', skillFile });
    }
  }
  return nodes;
}
