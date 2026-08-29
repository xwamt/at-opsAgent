/**
 * WorkbenchService.exportReport / writeClipboard（Plan 09）：
 * - showSaveDialog 取消 → fs.writeFile / workspace.fs.writeFile / writeFileSync 零调用；
 * - 选定 Uri → 一次 write，内容为 markdown；
 * - exportReport(sessionId) 用 itemsOf 导非活动会话；
 * - clipboard/write 走 vscode.env.clipboard.writeText。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showTextDocument: vi.fn(),
  openTextDocument: vi.fn(),
  clipboardWriteText: vi.fn(),
  workspaceWriteFile: vi.fn()
}));

vi.mock('vscode', () => ({
  window: {
    showSaveDialog: vscodeMocks.showSaveDialog,
    showTextDocument: vscodeMocks.showTextDocument,
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn()
  },
  workspace: {
    openTextDocument: vscodeMocks.openTextDocument,
    findFiles: vi.fn().mockResolvedValue([]),
    asRelativePath: (uri: { fsPath?: string }) => uri.fsPath ?? '',
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    fs: { writeFile: vscodeMocks.workspaceWriteFile }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
    parse: (value: string) => ({ fsPath: value, toString: () => value })
  },
  env: {
    clipboard: { writeText: vscodeMocks.clipboardWriteText },
    language: 'zh-cn'
  },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) }
}));

import { SessionStore } from '../src/host/sessionStore';
import { HostController } from '../src/host/hostController';
import { OpsSecrets } from '../src/host/secrets';
import type { HostContext } from '../src/host/services/context';
import { WorkbenchService } from '../src/host/services/workbenchService';

const tempDirs: string[] = [];

function tempStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'at-ops-export-'));
  tempDirs.push(dir);
  return { store: new SessionStore({ filePath: path.join(dir, 'ui-sessions.json') }), dir };
}

function makeWorkbench(store: SessionStore): WorkbenchService {
  const ctx = { store, log: () => {} } as unknown as HostContext;
  return new WorkbenchService(ctx);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vscodeMocks.showSaveDialog.mockReset();
  vscodeMocks.showTextDocument.mockReset().mockResolvedValue(undefined);
  vscodeMocks.openTextDocument.mockReset().mockResolvedValue({});
  vscodeMocks.clipboardWriteText.mockReset().mockResolvedValue(undefined);
  vscodeMocks.workspaceWriteFile.mockReset();
});

describe('view/title 导出入口', () => {
  it('package.json menus.view/title 含 exportReport navigation@5', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { menus: { 'view/title': Array<{ command: string; group: string }> } };
    };
    const menus = pkg.contributes.menus['view/title'];
    expect(menus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'atOpsAgent.exportReport',
          group: 'navigation@5'
        })
      ])
    );
    expect(menus.filter((m) => m.command === 'atOpsAgent.newSession')).toHaveLength(1);
    expect(menus.filter((m) => m.command === 'atOpsAgent.openSettings')).toHaveLength(1);
  });
});

describe('WorkbenchService.exportReport', () => {
  it('showSaveDialog 返回 undefined 时零 IO（不写 tmp、不 openTextDocument）', async () => {
    const { store } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: '取消不应落盘' });
    store.persistNow();

    vscodeMocks.showSaveDialog.mockResolvedValue(undefined);
    const writePromise = vi.spyOn(nodeFs.promises, 'writeFile');
    const tmp = os.tmpdir();
    const beforeTmp = new Set(nodeFs.readdirSync(tmp).filter((name) => name.startsWith('at-ops-report-')));

    const result = await makeWorkbench(store).exportReport();

    expect(result).toEqual({ ok: false });
    expect(writePromise).not.toHaveBeenCalled();
    expect(vscodeMocks.workspaceWriteFile).not.toHaveBeenCalled();
    expect(vscodeMocks.openTextDocument).not.toHaveBeenCalled();
    expect(vscodeMocks.showTextDocument).not.toHaveBeenCalled();
    const newTmpReports = nodeFs
      .readdirSync(tmp)
      .filter((name) => name.startsWith('at-ops-report-') && !beforeTmp.has(name));
    expect(newTmpReports).toEqual([]);
  });

  it('选定 Uri 则一次 writeFile，内容为 markdown', async () => {
    const { store, dir } = tempStore();
    store.appendItem({ kind: 'user', id: 'u1', text: '支付网关 5xx 飙升' });
    store.persistNow();

    const targetPath = path.join(dir, 'duty-report.md');
    vscodeMocks.showSaveDialog.mockResolvedValue({ fsPath: targetPath });
    const writePromise = vi.spyOn(nodeFs.promises, 'writeFile').mockResolvedValue(undefined);

    const result = await makeWorkbench(store).exportReport();

    expect(result.ok).toBe(true);
    expect(result.path).toBe(targetPath);
    expect(writePromise).toHaveBeenCalledTimes(1);
    const [filePath, contents] = writePromise.mock.calls[0]!;
    expect(filePath).toBe(targetPath);
    expect(String(contents)).toContain('支付网关 5xx 飙升');
    expect(String(contents)).toContain('# 值班报告');
    expect(vscodeMocks.openTextDocument).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('exportReport(sessionId) 导非活动会话：含该会话 user 文本、不含活动会话独有文本', async () => {
    const { store, dir } = tempStore();
    const first = store.activeSessionId;
    store.appendItem({ kind: 'user', id: 'u1', text: 'FIRST_SESSION_UNIQUE' });
    const second = store.newSession().id;
    store.appendItem({ kind: 'user', id: 'u2', text: 'SECOND_SESSION_UNIQUE' });
    store.persistNow();
    expect(store.activeSessionId).toBe(second);
    expect(store.itemsOf(first).some((i) => i.kind === 'user' && i.text === 'FIRST_SESSION_UNIQUE')).toBe(
      true
    );

    const targetPath = path.join(dir, 'first-session.md');
    vscodeMocks.showSaveDialog.mockResolvedValue({ fsPath: targetPath });
    const writePromise = vi.spyOn(nodeFs.promises, 'writeFile').mockResolvedValue(undefined);

    await makeWorkbench(store).exportReport(first);

    expect(writePromise).toHaveBeenCalledTimes(1);
    const markdown = String(writePromise.mock.calls[0]![1]);
    expect(markdown).toContain('FIRST_SESSION_UNIQUE');
    expect(markdown).not.toContain('SECOND_SESSION_UNIQUE');
  });
});

describe('WorkbenchService.writeClipboard', () => {
  it('把文本写入 vscode.env.clipboard', async () => {
    const { store } = tempStore();
    const result = await makeWorkbench(store).writeClipboard('df -h');
    expect(result).toEqual({ ok: true });
    expect(vscodeMocks.clipboardWriteText).toHaveBeenCalledWith('df -h');
  });

  it('写入失败仍返回 ok（不 toast）', async () => {
    const { store } = tempStore();
    vscodeMocks.clipboardWriteText.mockRejectedValue(new Error('clipboard denied'));
    const result = await makeWorkbench(store).writeClipboard('secret-should-not-throw');
    expect(result).toEqual({ ok: true });
  });
});

describe('HostController 路由 clipboard/write 与 chat/export', () => {
  it('源码接线：clipboard/write + chat/export 读 sessionId', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/host/hostController.ts'), 'utf8');
    expect(src).toContain("case 'clipboard/write'");
    expect(src).toContain('this.workbench.writeClipboard');
    expect(src).toContain("case 'chat/export'");
    expect(src).toContain('sessionId');
  });

  it('handleRequest clipboard/write 调用 env.clipboard.writeText', async () => {
    const { store, dir } = tempStore();
    const controller = new HostController({
      hub: {
        onDidChangeTools: () => ({ dispose() {} }),
        getProviders: () => ({ hostApp: 'code', providers: [] }),
        listAllTools: () => [],
        hostApp: 'code'
      } as never,
      store,
      secrets: new OpsSecrets({
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
        onDidChange: () => ({ dispose() {} })
      } as never),
      output: { appendLine() {} } as never,
      extensionPath: dir
    });
    try {
      const result = await controller.handleRequest('clipboard/write', { text: 'uptime' });
      expect(result).toEqual({ ok: true });
      expect(vscodeMocks.clipboardWriteText).toHaveBeenCalledWith('uptime');
    } finally {
      controller.dispose();
    }
  });
});
