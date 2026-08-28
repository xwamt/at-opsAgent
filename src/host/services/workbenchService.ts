/**
 * 工作台服务（编辑器 / 窗口交互的小件）：
 * - asset/pick：QuickPick 选素材附进 Composer（证据便签 + 工作区文件）；
 * - chat/export（P1-10）：当前会话 → Markdown 值班报告；
 * - log/open：LogViewer「在编辑器打开」；
 * - skill/run：内置技能无用户入口，收到请求只记日志（无害 no-op）。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AssetPickRes, TranscriptItem } from '../../protocol';
import { buildOpsReportMarkdown, exportReportFileName } from '../exportReport';
import { describeError, type HostContext } from './context';

export class WorkbenchService {
  constructor(private readonly ctx: HostContext) {}

  /**
   * asset/pick：QuickPick 选一条要附进 Composer 的素材——
   * 最近证据便签（透传摘要文本）+ 工作区文件（透传 uri，由 prompt 侧引用）。
   * 大文件内容不在这里读：附件只带 uri/标签，模型按需经工具读取。
   */
  async pickAsset(query?: string): Promise<AssetPickRes> {
    type PickItem = vscode.QuickPickItem & { asset: AssetPickRes['items'][number] };
    const items: PickItem[] = [];

    const evidence = this.ctx.store.items
      .filter((i): i is Extract<TranscriptItem, { kind: 'evidence' }> => i.kind === 'evidence')
      .slice(-5)
      .reverse();
    for (const item of evidence) {
      const summary = item.note.summary.replace(/\s+/g, ' ').trim();
      items.push({
        label: `$(beaker) ${summary.slice(0, 60)}`,
        description: `证据 · ${item.note.taskId}`,
        asset: {
          kind: 'evidence',
          label: summary.slice(0, 60),
          text: `[证据 ${item.note.taskId} / ${item.note.confidence}] ${summary}`
        }
      });
    }

    try {
      const pattern =
        typeof query === 'string' && query.trim().length > 0 ? `**/*${query.trim()}*` : '**/*';
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 30);
      for (const uri of files) {
        const rel = vscode.workspace.asRelativePath(uri);
        items.push({
          label: `$(file) ${rel}`,
          description: '工作区文件',
          asset: { kind: 'file', label: rel, text: `[附件] ${rel}`, uri: uri.toString() }
        });
      }
    } catch (err) {
      this.ctx.log(`[asset/pick] findFiles 失败: ${describeError(err)}`);
    }

    if (items.length === 0) return { items: [] };
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要附加到对话的素材（证据 / 工作区文件）',
      matchOnDescription: true
    });
    return { items: picked ? [picked.asset] : [] };
  }

  /**
   * chat/export（P1-10）：当前会话 → Markdown 值班报告。
   * showSaveDialog 选路径；取消时落系统临时目录，两种路径都会在编辑器打开。
   * 报告绝不包含审批令牌 / API key。
   */
  async exportReport(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const store = this.ctx.store;
    const session = store.sessions.find((s) => s.id === store.activeSessionId);
    const markdown = buildOpsReportMarkdown({
      sessionId: store.activeSessionId,
      ...(session !== undefined ? { sessionTitle: session.title } : {}),
      ...(store.playbook !== undefined ? { playbook: store.playbook } : {}),
      items: store.items,
      timeline: store.timeline,
      pendingBriefs: store.pendingBriefs
    });
    const fileName = exportReportFileName();
    let target: vscode.Uri | undefined;
    try {
      target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)),
        filters: { Markdown: ['md'] },
        title: '导出值班报告'
      });
    } catch {
      target = undefined;
    }
    const filePath = target?.fsPath ?? path.join(os.tmpdir(), fileName);
    try {
      await fs.writeFile(filePath, markdown, 'utf8');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      this.ctx.log(`[export] 值班报告已导出：${filePath}`);
      return { ok: true, path: filePath };
    } catch (err) {
      this.ctx.log(`[export] 导出失败: ${describeError(err)}`);
      return { ok: false, error: describeError(err) };
    }
  }

  /** LogViewer「在编辑器打开」：只打开 URI，不把大日志 postMessage 回 webview。 */
  async openLog(uri?: string): Promise<{ ok: boolean }> {
    if (typeof uri !== 'string' || uri.trim().length === 0) {
      void vscode.window.showWarningMessage('没有可打开的日志 URI（结果可能已截断且未落盘）。');
      return { ok: false };
    }
    try {
      const parsed = vscode.Uri.parse(uri);
      const doc = await vscode.workspace.openTextDocument(parsed);
      await vscode.window.showTextDocument(doc, { preview: true });
      return { ok: true };
    } catch (err) {
      this.ctx.log(`[log/open] 打开失败: ${describeError(err)}`);
      void vscode.window.showErrorMessage(`无法打开日志：${describeError(err)}`);
      return { ok: false };
    }
  }

  /** skill/run：内置技能无用户可见入口，收到请求只记日志（无害 no-op）。 */
  runSkill(name?: string): { ok: boolean } {
    if (typeof name !== 'string' || name.length === 0) return { ok: false };
    this.ctx.log(`[skill] 收到 skill/run ${name}（技能由模型按需读取，UI 不再提供入口）`);
    return { ok: true };
  }
}
