/**
 * Models 树：读 ~/.at-series/agent/models.json（存在才读）。
 * 未配置时显示「未配置」节点，点击触发 openModels 创建模板。
 * 绝不展示 apiKey 值（占位符原样、明文一律打码）。
 */
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';

type ModelsNode =
  | { kind: 'empty'; reason: string }
  | { kind: 'provider'; providerId: string; api?: string; baseUrl?: string; modelCount: number }
  | { kind: 'model'; providerId: string; modelId: string; name?: string; thinking?: boolean };

interface ParsedProvider {
  api?: string;
  baseUrl?: string;
  models: Array<{ id: string; name?: string; thinking?: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ModelsTreeProvider implements vscode.TreeDataProvider<ModelsNode> {
  private readonly changeEmitter = new vscode.EventEmitter<ModelsNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly modelsPath: string) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: ModelsNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('未配置', vscode.TreeItemCollapsibleState.None);
      item.description = node.reason;
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      item.command = {
        command: 'atOpsAgent.openModels',
        title: 'Open Models',
        arguments: []
      };
      item.tooltip = `点击创建 ${this.modelsPath} 模板`;
      return item;
    }
    if (node.kind === 'provider') {
      const item = new vscode.TreeItem(
        node.providerId,
        node.modelCount > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      item.id = `models-provider:${node.providerId}`;
      item.contextValue = 'models.provider';
      item.description = [node.api, node.baseUrl].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon('server');
      return item;
    }
    const item = new vscode.TreeItem(node.name ?? node.modelId, vscode.TreeItemCollapsibleState.None);
    item.id = `models-model:${node.providerId}:${node.modelId}`;
    item.contextValue = 'models.model';
    item.description = [node.modelId, node.thinking ? 'thinking' : undefined]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon('sparkle');
    return item;
  }

  async getChildren(node?: ModelsNode): Promise<ModelsNode[]> {
    const providers = await this.readProviders();
    if (!node) {
      if (providers === undefined) {
        return [{ kind: 'empty', reason: '点击创建 models.json' }];
      }
      const ids = Object.keys(providers);
      if (ids.length === 0) {
        return [{ kind: 'empty', reason: 'models.json 中没有 provider' }];
      }
      return ids.sort().map((providerId) => ({
        kind: 'provider' as const,
        providerId,
        api: providers[providerId].api,
        baseUrl: providers[providerId].baseUrl,
        modelCount: providers[providerId].models.length
      }));
    }
    if (node.kind === 'provider' && providers) {
      return (providers[node.providerId]?.models ?? []).map((m) => ({
        kind: 'model' as const,
        providerId: node.providerId,
        modelId: m.id,
        name: m.name,
        thinking: m.thinking
      }));
    }
    return [];
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** undefined = 文件不存在或不可解析（视为未配置）。 */
  private async readProviders(): Promise<Record<string, ParsedProvider> | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.modelsPath, 'utf8'));
    } catch {
      return undefined;
    }
    if (!isRecord(raw) || !isRecord(raw.providers)) return undefined;
    const result: Record<string, ParsedProvider> = {};
    for (const [providerId, value] of Object.entries(raw.providers)) {
      if (!isRecord(value)) continue;
      const models = Array.isArray(value.models)
        ? value.models
            .filter(isRecord)
            .filter((m) => typeof m.id === 'string')
            .map((m) => ({
              id: m.id as string,
              name: typeof m.name === 'string' ? m.name : undefined,
              thinking: m.thinking === true
            }))
        : [];
      result[providerId] = {
        api: typeof value.api === 'string' ? value.api : undefined,
        baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
        models
      };
    }
    return result;
  }
}
