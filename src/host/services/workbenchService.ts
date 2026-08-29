/**
 * 工作台服务（编辑器 / 窗口交互的小件）：
 * - asset/pick：QuickPick 选素材附进 Composer（证据便签 + 工作区文件）；
 * - chat/export（P1-10）：指定/活动会话 → Markdown 值班报告（取消保存零 IO）；
 * - clipboard/write：host 回退剪贴板；
 * - log/open：LogViewer「在编辑器打开」；
 * - skill/run：内置技能无用户入口，收到请求只记日志（无害 no-op）。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AssetPickRes, TranscriptItem } from '../../protocol';
import { buildOpsReportMarkdown, exportReportFileName } from '../exportReport';
import { AUDIT_WINDOW_CHOICES, copyAuditWindow } from './auditChain';
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
      placeHolder: vscode.l10n.t('选择要附加到对话的素材（证据 / 工作区文件）'),
      matchOnDescription: true
    });
    return { items: picked ? [picked.asset] : [] };
  }

  /**
   * chat/export（P1-10）：指定会话（缺省活动会话）→ Markdown 值班报告。
   * showSaveDialog 选路径；取消（undefined）时零 write、零 openTextDocument。
   * 报告绝不包含审批令牌 / API key。
   */
  async exportReport(sessionId?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    const store = this.ctx.store;
    const sid =
      typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : store.activeSessionId;
    const session = store.sessions.find((s) => s.id === sid);
    const playbook = store.playbookOf(sid);
    const isActive = sid === store.activeSessionId;
    const markdown = buildOpsReportMarkdown({
      sessionId: sid,
      ...(session !== undefined ? { sessionTitle: session.title } : {}),
      ...(playbook !== undefined ? { playbook } : {}),
      items: store.itemsOf(sid),
      timeline: isActive ? store.timeline : [],
      pendingBriefs: isActive ? store.pendingBriefs : []
    });
    const fileName = exportReportFileName();
    let target: vscode.Uri | undefined;
    try {
      target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)),
        filters: { Markdown: ['md'] },
        title: vscode.l10n.t('导出值班报告')
      });
    } catch {
      target = undefined;
    }
    if (!target) {
      return { ok: false }; // 取消：零 write、零 openTextDocument
    }
    try {
      await fs.writeFile(target.fsPath, markdown, 'utf8');
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.ctx.log(`[export] 值班报告已导出：${target.fsPath}`);
      this.ctx.emitDuty?.('export', sid, {
        path: target.fsPath,
        format: 'markdown',
        sessionId: sid
      });
      return { ok: true, path: target.fsPath };
    } catch (err) {
      this.ctx.log(`[export] 导出失败: ${describeError(err)}`);
      return { ok: false, error: describeError(err) };
    }
  }

  /**
   * atOpsAgent.exportAudit：QuickPick 时间窗，把日切 JSONL 原样拼接写出
   * （链哈希不重算）。取消 QuickPick / SaveDialog 时零 IO。
   */
  async exportAudit(): Promise<{ ok: boolean; path?: string; error?: string }> {
    const picked = await vscode.window.showQuickPick(
      AUDIT_WINDOW_CHOICES.map((choice) => ({
        label: choice.label,
        description: choice.description,
        days: choice.days
      })),
      { placeHolder: vscode.l10n.t('选择审计导出时间窗') }
    );
    if (!picked) return { ok: false };
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    let target: vscode.Uri | undefined;
    try {
      target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `at-ops-audit-${stamp}.jsonl`)),
        filters: { JSONL: ['jsonl'] },
        title: vscode.l10n.t('导出审计 JSONL')
      });
    } catch {
      target = undefined;
    }
    if (!target) return { ok: false };
    try {
      const copied = await copyAuditWindow({
        agentDir: this.ctx.agentDir,
        destPath: target.fsPath,
        days: picked.days,
        now
      });
      if (!copied.ok) {
        const error = copied.error ?? '导出失败';
        void vscode.window.showWarningMessage(error);
        return { ok: false, error };
      }
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.ctx.log(`[audit] 已导出 ${copied.lines} 行（${copied.files.join(', ')}）→ ${target.fsPath}`);
      this.ctx.emitDuty?.('export', this.ctx.store.activeSessionId, {
        path: target.fsPath,
        format: 'audit-jsonl',
        days: picked.days,
        lines: copied.lines
      });
      return { ok: true, path: target.fsPath };
    } catch (err) {
      this.ctx.log(`[audit] 导出失败: ${describeError(err)}`);
      return { ok: false, error: describeError(err) };
    }
  }

  /**
   * clipboard/write：host 回退剪贴板。失败只记日志，仍返回 ok
   * （webview 已展示「已复制」，不要 toast 打断值班）。
   */
  async writeClipboard(text: string): Promise<{ ok: boolean }> {
    try {
      await vscode.env.clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      this.ctx.log(`[clipboard] 写入失败: ${describeError(err)}`);
      return { ok: true };
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
