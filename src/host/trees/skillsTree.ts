/**
 * Skills 树：扫描 <extensionPath>/skills/ops-agent-core 与
 * skills/playbooks/<id>/SKILL.md。点击节点在编辑器打开 SKILL.md。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface SkillNode {
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

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillNode> {
  private readonly changeEmitter = new vscode.EventEmitter<SkillNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly extensionPath: string) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: SkillNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.skillFile;
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon('book');
    item.resourceUri = vscode.Uri.file(node.skillFile);
    item.command = {
      command: 'vscode.open',
      title: 'Open SKILL.md',
      arguments: [vscode.Uri.file(node.skillFile)]
    };
    return item;
  }

  async getChildren(node?: SkillNode): Promise<SkillNode[]> {
    if (node) return [];
    const skillsDir = path.join(this.extensionPath, 'skills');
    const nodes: SkillNode[] = [];

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
      // skills/playbooks 缺失：不报错，树为空态。
    }
    for (const entry of entries) {
      const skillFile = path.join(playbooksDir, entry, 'SKILL.md');
      if (await fileExists(skillFile)) {
        nodes.push({ label: entry, description: 'playbook', skillFile });
      }
    }
    return nodes;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
