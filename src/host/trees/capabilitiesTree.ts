/**
 * Capabilities 树：HubHost.getProviders() + listAllTools()（不是 MCP tools/list）。
 * 按 pluginId 分组，节点显示 healthy/unhealthy 与 tool 数量；工具子节点显示 risk。
 * 空态由 viewsWelcome（context key atOpsAgent.bridgeCount == 0）承担。
 */
import * as vscode from 'vscode';
import type { HubHost } from '../../protocol';

type CapNode =
  | { kind: 'provider'; pluginId: string }
  | { kind: 'tool'; pluginId: string; name: string };

export class CapabilitiesTreeProvider implements vscode.TreeDataProvider<CapNode> {
  private readonly changeEmitter = new vscode.EventEmitter<CapNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly getHub: () => HubHost | undefined) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  /** { bridges, unhealthy } —— activate 用于 context key 与 badge。 */
  counts(): { bridges: number; unhealthy: number } {
    const hub = this.getHub();
    if (!hub) return { bridges: 0, unhealthy: 0 };
    try {
      const providers = hub.getProviders().providers;
      return {
        bridges: providers.reduce((sum, p) => sum + p.bridgeCount, 0),
        unhealthy: providers.filter((p) => !p.healthy).length
      };
    } catch {
      return { bridges: 0, unhealthy: 0 };
    }
  }

  getTreeItem(node: CapNode): vscode.TreeItem {
    const hub = this.getHub();
    if (node.kind === 'provider') {
      const provider = hub
        ?.getProviders()
        .providers.find((p) => p.pluginId === node.pluginId);
      const item = new vscode.TreeItem(
        provider?.displayName ?? node.pluginId,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `provider:${node.pluginId}`;
      item.contextValue = 'capability.provider';
      const healthy = provider?.healthy ?? false;
      const toolCount = provider?.toolNames.length ?? 0;
      const targets =
        provider?.connectedTargets !== undefined
          ? ` · ${provider.connectedTargets} connected`
          : '';
      item.description = `${healthy ? 'healthy' : 'unhealthy'} · ${toolCount} tools${targets}`;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${provider?.displayName ?? node.pluginId}** \`${node.pluginId}\``,
          '',
          `- 状态: ${healthy ? 'healthy' : 'unhealthy'}`,
          `- Bridges: ${provider?.bridgeCount ?? 0}`,
          `- Tools: ${toolCount}`,
          provider?.pluginVersion ? `- 版本: ${provider.pluginVersion}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      );
      item.iconPath = healthy
        ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
      return item;
    }
    const tool = hub?.listAllTools().find((t) => t.name === node.name);
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = `tool:${node.pluginId}:${node.name}`;
    item.contextValue = 'capability.tool';
    item.description = tool?.risk ?? '';
    if (tool) {
      item.tooltip = new vscode.MarkdownString(
        `**${tool.title || tool.name}**\n\nrisk: \`${tool.risk}\`\n\n${tool.description}`
      );
    }
    item.iconPath = riskIcon(tool?.risk);
    return item;
  }

  getChildren(node?: CapNode): CapNode[] {
    const hub = this.getHub();
    if (!hub) return [];
    if (!node) {
      try {
        return hub
          .getProviders()
          .providers.map((p) => ({ kind: 'provider' as const, pluginId: p.pluginId }))
          .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
      } catch {
        return [];
      }
    }
    if (node.kind === 'provider') {
      return hub
        .listAllTools()
        .filter((t) => t.pluginId === node.pluginId)
        .map((t) => ({ kind: 'tool' as const, pluginId: node.pluginId, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return [];
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function riskIcon(risk: 'read' | 'write' | 'exec' | undefined): vscode.ThemeIcon {
  switch (risk) {
    case 'write':
      return new vscode.ThemeIcon('pencil', new vscode.ThemeColor('editorWarning.foreground'));
    case 'exec':
      return new vscode.ThemeIcon('zap', new vscode.ThemeColor('editorError.foreground'));
    default:
      return new vscode.ThemeIcon('eye');
  }
}
