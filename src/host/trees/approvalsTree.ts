/**
 * Approvals 树：pending 审批简报。
 * viewItem == 'approval.pending' 时 package.json 的 inline 批准/拒绝菜单生效；
 * badge 数量由 activate 侧订阅 store.onDidChangeApprovals 设置。
 */
import * as vscode from 'vscode';
import type { ApprovalBriefView } from '../../protocol';
import type { SessionStore } from '../sessionStore';

export class ApprovalTreeItem extends vscode.TreeItem {
  constructor(readonly brief: ApprovalBriefView) {
    super(brief.targetLabel, vscode.TreeItemCollapsibleState.None);
    this.id = brief.id;
    this.contextValue = 'approval.pending';
    this.description = `${brief.risk} · ${brief.id.slice(0, 8)}`;
    this.iconPath = new vscode.ThemeIcon(
      brief.risk === 'exec' ? 'zap' : 'pencil',
      new vscode.ThemeColor(
        brief.risk === 'exec' ? 'editorError.foreground' : 'editorWarning.foreground'
      )
    );
    const lines = [`**待审批 · ${brief.risk}** — ${brief.targetLabel}`, ''];
    for (const [key, value] of Object.entries(brief.elements)) {
      lines.push(`- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    if (brief.dualConfirmHint) {
      lines.push('', '批准后插件仍可能再次确认。插件弹窗不是本次批准。');
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n'));
  }
}

export class ApprovalsTreeProvider implements vscode.TreeDataProvider<ApprovalTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ApprovalTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly storeSub: { dispose(): void };

  constructor(private readonly store: SessionStore) {
    this.storeSub = store.onDidChangeApprovals(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(item: ApprovalTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: ApprovalTreeItem): ApprovalTreeItem[] {
    if (item) return [];
    return this.store.pendingBriefs.map((brief) => new ApprovalTreeItem(brief));
  }

  dispose(): void {
    this.storeSub.dispose();
    this.changeEmitter.dispose();
  }
}
