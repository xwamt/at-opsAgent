/**
 * Skills 树：清单扫描委托 src/host/skillsScan.ts（与设置页共用真源）。
 * 点击节点在编辑器打开 SKILL.md。
 * 注：视图收敛后默认不再注册（activate 不再挂 TreeView），类保留可复用。
 */
import * as vscode from 'vscode';
import { listSkills, type SkillInfo } from '../skillsScan';

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillInfo> {
  private readonly changeEmitter = new vscode.EventEmitter<SkillInfo | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly extensionPath: string) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: SkillInfo): vscode.TreeItem {
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

  async getChildren(node?: SkillInfo): Promise<SkillInfo[]> {
    if (node) return [];
    return listSkills(this.extensionPath);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
