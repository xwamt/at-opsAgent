/**
 * 可选的工作区只读访问（docs/03 §2，默认关闭）。
 *
 * options.workspaceShellEnabled === true 时也只注册 ops_read_workspace_file：
 * - 路径限定在 cwd 之内（拒绝 ..、绝对路径、反斜杠）；
 * - utf8 读取，单文件上限 64KB；
 * - 绝不注入不受限 bash / write / edit——运维变更走 AT 插件与审批链。
 */
import { readFile } from 'node:fs/promises';

import { resolveUnderRoot, SKILL_FILE_CHAR_LIMIT, type OpsCustomToolSpec } from './resource-loader';

export const READ_WORKSPACE_FILE_TOOL_NAME = 'ops_read_workspace_file';

/** 工作区单文件字符上限（与 skills 读取一致：64KB）。 */
export const WORKSPACE_FILE_CHAR_LIMIT = SKILL_FILE_CHAR_LIMIT;

export type ReadWorkspaceFileResult =
  | { ok: true; path: string; content: string; truncated: boolean; notice?: string }
  | { ok: false; error: string };

/** 读取 cwd 内的单个文件；utf8；超过 limit 截断并附中文提示。 */
export async function readWorkspaceFile(
  cwd: string,
  relPath: string,
  limit = WORKSPACE_FILE_CHAR_LIMIT
): Promise<ReadWorkspaceFileResult> {
  const abs = resolveUnderRoot(cwd, relPath);
  if (abs === undefined) {
    return {
      ok: false,
      error: `路径 "${relPath}" 不合法：只允许工作区（cwd）内的相对路径（禁止 ..、绝对路径与反斜杠）。`
    };
  }
  let content: string;
  try {
    content = await readFile(abs, 'utf8');
  } catch {
    return { ok: false, error: `无法读取 "${relPath}"（不存在、无权限或不是普通文件）。` };
  }
  const truncated = content.length > limit;
  return {
    ok: true,
    path: abs,
    content: truncated ? content.slice(0, limit) : content,
    truncated,
    ...(truncated
      ? { notice: `文件共 ${content.length} 字符，超过 ${limit} 上限已截断；请收窄读取范围。` }
      : {})
  };
}

/** ops_read_workspace_file 工具（仅 workspaceShellEnabled=true 时注册）。 */
export function createWorkspaceReadTool(cwd: string): OpsCustomToolSpec {
  return {
    name: READ_WORKSPACE_FILE_TOOL_NAME,
    label: 'Ops：读取工作区文件（只读）',
    description:
      `只读地读取当前工作区（${cwd}）内的单个文件，utf8，上限 ${WORKSPACE_FILE_CHAR_LIMIT} 字符。` +
      '仅限相对路径（禁止 .. 与绝对路径）。没有任何写入/执行能力；运维变更走 AT 插件与审批链。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对工作区根的路径，如 config/app.yaml'
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (args) => JSON.stringify(await readWorkspaceFile(cwd, String(args.path ?? '')))
  };
}
