/**
 * 长期记忆 host 面（Plan 12 T1 / T8）：
 * - 命令 atOpsAgent.memory.editEnvironment 打开 JSON，保存时 schema + 刮密；
 * - close playbook 成功后询问是否追加 incidents/index.md（从不自动写）；
 * - 有历史结论时 notice 行级 diff（+新增 / -消失，最多 20 行）。
 *
 * vscode 只出现在本文件；读写语义在 runtime/ops-recall.ts。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { NoticeAction, TranscriptItem } from '../../protocol';
import {
  commitIncidentAppend,
  conclusionFromTranscript,
  diffConclusionLines,
  environmentJsonPath,
  findPreviousConclusion,
  formatIncidentIndexLine,
  formatInspectionDiffNotice,
  isoDate,
  oneSentenceFromConclusion,
  prepareEnvironmentSave,
  resolveMemoryDir
} from '../../runtime/ops-recall';
import { describeError, type HostContext } from './context';
import { memoryDirOf } from './stageLayers';

export const INCIDENT_APPEND_YES_ID = 'incidents-append-yes';
export const INCIDENT_APPEND_NO_ID = 'incidents-append-no';

export const INCIDENT_APPEND_ACTIONS: NoticeAction[] = [
  { id: INCIDENT_APPEND_YES_ID, label: '是' },
  { id: INCIDENT_APPEND_NO_ID, label: '否' }
];

export type PendingIncident = {
  sessionId: string;
  playbookId: string;
  date: string;
  sentence: string;
  relativePath: string;
  conclusionMarkdown: string;
};

const pendingBySession = new Map<string, PendingIncident>();

export function stashPendingIncident(pending: PendingIncident): void {
  pendingBySession.set(pending.sessionId, pending);
}

export function takePendingIncident(sessionId: string): PendingIncident | undefined {
  const pending = pendingBySession.get(sessionId);
  pendingBySession.delete(sessionId);
  return pending;
}

function emitNotice(
  ctx: HostContext,
  sessionId: string,
  text: string,
  actions?: NoticeAction[]
): void {
  const item: TranscriptItem = {
    kind: 'notice',
    id: randomUUID(),
    variant: 'info',
    text,
    ...(actions !== undefined && actions.length > 0 ? { actions } : {})
  };
  ctx.store.appendItem(item, sessionId);
  ctx.broadcastToSession(sessionId, 'transcript/append', { item });
}

/**
 * closePlaybook 成功路径：先 T8 diff（无历史则跳过），再询问是否追加 incidents。
 * 不删除同路径上已有的导出 notice。
 */
export function emitPlaybookCloseMemoryNotices(
  ctx: HostContext,
  sessionId: string,
  playbookId: string
): void {
  const memoryDir = memoryDirOf(ctx);
  const items = ctx.store.itemsOf(sessionId);
  const current = conclusionFromTranscript(items);
  const previous = findPreviousConclusion(memoryDir, playbookId);
  if (previous !== undefined && previous.length > 0 && current.length > 0) {
    const notice = formatInspectionDiffNotice(diffConclusionLines(previous, current));
    if (notice.length > 0) emitNotice(ctx, sessionId, notice);
  }

  const date = isoDate();
  const sentence = oneSentenceFromConclusion(current, `${playbookId} 已关闭`);
  const relativePath = `incidents/${date}-${playbookId}.md`;
  stashPendingIncident({
    sessionId,
    playbookId,
    date,
    sentence,
    relativePath,
    conclusionMarkdown:
      current.length > 0
        ? `# ${playbookId} · ${date}\n\n## 结论\n\n${current}\n`
        : `# ${playbookId} · ${date}\n\n## 结论\n\n（无可见结论正文）\n`
  });
  emitNotice(ctx, sessionId, '是否把本结论追加到 incidents/index.md？', INCIDENT_APPEND_ACTIONS);
}

export function confirmAppendIncident(
  ctx: HostContext,
  sessionId?: string
): { ok: boolean; error?: string } {
  const sid = sessionId ?? ctx.store.activeSessionId;
  const pending = takePendingIncident(sid);
  if (!pending) {
    emitNotice(ctx, sid, '没有待追加的巡检结论。');
    return { ok: false, error: '没有待追加的巡检结论' };
  }
  const result = commitIncidentAppend(memoryDirOf(ctx), {
    relativePath: pending.relativePath,
    indexLine: formatIncidentIndexLine({
      date: pending.date,
      sentence: pending.sentence,
      relativePath: pending.relativePath
    }),
    conclusionMarkdown: pending.conclusionMarkdown
  });
  if (!result.ok) {
    emitNotice(ctx, sid, result.error);
    return { ok: false, error: result.error };
  }
  emitNotice(ctx, sid, `已追加到 incidents/index.md（${pending.relativePath}）。`);
  return { ok: true };
}

export function skipAppendIncident(ctx: HostContext, sessionId?: string): { ok: boolean } {
  const sid = sessionId ?? ctx.store.activeSessionId;
  pendingBySession.delete(sid);
  return { ok: true };
}

export async function editEnvironmentFile(ctx: HostContext): Promise<{ ok: boolean; error?: string }> {
  const dir = memoryDirOf(ctx);
  const abs = environmentJsonPath(dir);
  try {
    await mkdir(dir, { recursive: true });
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(abs));
    } catch {
      await writeFile(abs, '{}\n', 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: false });
    return { ok: true };
  } catch (err) {
    const error = describeError(err);
    ctx.log(`[memory] 打开 environment.json 失败: ${error}`);
    void vscode.window.showErrorMessage(`无法打开 environment.json：${error}`);
    return { ok: false, error };
  }
}

/** 保存 environment.json 时 schema 校验 + 秘密字段拒绝。 */
export function registerEnvironmentSaveGuard(getMemoryDir: () => string): vscode.Disposable {
  return vscode.workspace.onDidSaveTextDocument((doc) => {
    let expected: string;
    try {
      expected = environmentJsonPath(getMemoryDir());
    } catch {
      expected = environmentJsonPath(resolveMemoryDir());
    }
    const saved = doc.uri.fsPath;
    if (saved !== expected) return;
    const prepared = prepareEnvironmentSave(doc.getText());
    if (!prepared.ok) {
      void vscode.window.showErrorMessage(`environment.json 未通过校验：${prepared.error}`);
    }
  });
}
