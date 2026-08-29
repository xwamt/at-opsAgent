/**
 * 运维文档 host 写盘（Plan 11）：applyToolGate 批准后才进这里的 fs.writeFile。
 * 用户 hover / 命令面板 `atOpsAgent.saveOpsDoc` 跳过审批（风险主体是用户）。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  WRITE_OPS_DOC_TOOL_NAME,
  formatOpsDocApprovalCommands,
  isOpsDocType,
  prepareWriteOpsDoc,
  type OpsDocType,
  type WriteOpsDocRequest
} from '../../runtime/workspace-write';
import { describeError, type HostContext } from './context';

export type WriteOpsDocOutcome = { ok: true; path: string } | { ok: false; error: string };

export function opsDocsRoot(workspaceFolder?: string, agentDir?: string): string {
  if (typeof workspaceFolder === 'string' && workspaceFolder.length > 0) {
    return path.join(workspaceFolder, 'ops-docs');
  }
  const homeAgent = agentDir ?? path.join(os.homedir(), '.at-series', 'agent');
  return path.join(homeAgent, 'ops-docs');
}

export function docsRootFromContext(ctx: HostContext): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return opsDocsRoot(folder, ctx.agentDir);
}

/** host handler：闸门已通过（或用户主动保存）后写盘并打开编辑器。 */
export async function writeOpsDoc(
  ctx: HostContext,
  req: WriteOpsDocRequest
): Promise<WriteOpsDocOutcome> {
  const prepared = prepareWriteOpsDoc(docsRootFromContext(ctx), req);
  if (!prepared.ok) return prepared;
  try {
    await mkdir(path.dirname(prepared.absPath), { recursive: true });
    await writeFile(prepared.absPath, prepared.markdown, 'utf8');
  } catch (err) {
    return { ok: false, error: `写入失败：${describeError(err)}` };
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(prepared.absPath));
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    ctx.log(`[ops-doc] 已写入 ${prepared.absPath}，打开编辑器失败: ${describeError(err)}`);
  }
  return { ok: true, path: prepared.absPath };
}

const DOC_TYPE_PICKS: Array<{ label: string; description: OpsDocType }> = [
  { label: '巡检报告', description: 'inspection-report' },
  { label: '排障报告', description: 'troubleshooting-report' },
  { label: '班次交接', description: 'handoff' },
  { label: '操作记录', description: 'operation-record' },
  { label: '发布记录', description: 'deployment' },
  { label: '应急预案', description: 'emergency-plan' }
];

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m);
  const fromHeading = heading?.[1]?.trim();
  if (fromHeading && fromHeading.length > 0) return fromHeading;
  const first = markdown.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  if (first && first.length > 0) return first.slice(0, 80);
  return fallback;
}

/**
 * 用户「存为运维文档」：QuickPick docType，当前 assistant 正文当 markdown。
 * 不走模型工具、不走审批。
 */
export async function saveOpsDocFromTranscript(
  ctx: HostContext,
  itemId?: string
): Promise<WriteOpsDocOutcome> {
  const items = ctx.store.items;
  const assistant =
    typeof itemId === 'string' && itemId.length > 0
      ? items.find((i) => i.id === itemId && i.kind === 'assistant')
      : [...items].reverse().find((i) => i.kind === 'assistant' && i.streaming !== true);
  if (!assistant || assistant.kind !== 'assistant' || assistant.text.trim().length === 0) {
    void vscode.window.showWarningMessage('没有可保存的 Agent 回复。');
    return { ok: false, error: '没有可保存的 Agent 回复。' };
  }
  const picked = await vscode.window.showQuickPick(
    DOC_TYPE_PICKS.map((p) => ({ label: p.label, description: p.description })),
    { placeHolder: '选择运维文档类型', matchOnDescription: true }
  );
  if (!picked || !isOpsDocType(picked.description)) {
    return { ok: false, error: '已取消' };
  }
  const sessionTitle = ctx.store.sessions.find((s) => s.id === ctx.store.activeSessionId)?.title;
  const title = titleFromMarkdown(assistant.text, sessionTitle ?? '运维文档');
  return writeOpsDoc(ctx, {
    docType: picked.description,
    title,
    markdown: assistant.text
  });
}

function opsWriteArgsFromCommandSet(commandSet: unknown): Record<string, unknown> | undefined {
  if (!commandSet || typeof commandSet !== 'object') return undefined;
  const rec = commandSet as { tool?: unknown; args?: unknown };
  if (rec.tool !== WRITE_OPS_DOC_TOOL_NAME) return undefined;
  if (!rec.args || typeof rec.args !== 'object') return undefined;
  return rec.args as Record<string, unknown>;
}

/** 批准前 vscode.diff：失败只 log。 */
export async function tryPreviewOpsDocDiff(
  commandSet: unknown,
  ctx: HostContext
): Promise<void> {
  const args = opsWriteArgsFromCommandSet(commandSet);
  if (!args) return;
  const root = docsRootFromContext(ctx);
  const prepared = prepareWriteOpsDoc(root, {
    docType: isOpsDocType(args.docType) ? args.docType : 'operation-record',
    title: typeof args.title === 'string' ? args.title : 'untitled',
    markdown: typeof args.markdown === 'string' ? args.markdown : '',
    ...(typeof args.overwritePath === 'string' ? { overwritePath: args.overwritePath } : {})
  });
  let oldText = '';
  if (prepared.ok) {
    try {
      oldText = await readFile(prepared.absPath, 'utf8');
    } catch {
      oldText = '';
    }
  }
  const newText = prepared.ok ? prepared.markdown : formatOpsDocApprovalCommands(args);
  try {
    if (typeof vscode.workspace?.openTextDocument !== 'function') return;
    const left = await vscode.workspace.openTextDocument({ content: oldText, language: 'markdown' });
    const right = await vscode.workspace.openTextDocument({ content: newText, language: 'markdown' });
    const title =
      prepared.ok ? `将写入 ${prepared.relPath}` : `将写入 ops-docs（${WRITE_OPS_DOC_TOOL_NAME}）`;
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, title);
  } catch (err) {
    ctx.log(`[ops-doc] vscode.diff 预览失败: ${describeError(err)}`);
  }
}

export function isOpsWriteOpsDocCommandSet(commandSet: unknown): boolean {
  return opsWriteArgsFromCommandSet(commandSet) !== undefined;
}
