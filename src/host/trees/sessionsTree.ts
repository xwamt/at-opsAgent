/** Sessions 树：内存会话列表；newSession 命令追加。 */
import * as vscode from 'vscode';
import type { SessionInfo, SessionStore } from '../sessionStore';

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionInfo> {
  private readonly changeEmitter = new vscode.EventEmitter<SessionInfo | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly storeSub: { dispose(): void };

  constructor(private readonly store: SessionStore) {
    this.storeSub = store.onDidChangeSessions(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(session: SessionInfo): vscode.TreeItem {
    const active = session.id === this.store.activeSessionId;
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.id = session.id;
    item.contextValue = active ? 'session.active' : 'session';
    item.description = new Date(session.createdAt).toLocaleTimeString();
    item.iconPath = new vscode.ThemeIcon(active ? 'comment-discussion' : 'comment');
    if (active) item.tooltip = '当前会话';
    return item;
  }

  getChildren(session?: SessionInfo): SessionInfo[] {
    if (session) return [];
    return [...this.store.sessions].sort((a, b) => b.createdAt - a.createdAt);
  }

  dispose(): void {
    this.storeSub.dispose();
    this.changeEmitter.dispose();
  }
}
