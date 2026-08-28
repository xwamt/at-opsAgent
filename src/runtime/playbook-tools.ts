/**
 * 主代理选择运维链路的工具面：ops_list_playbooks / ops_start_playbook。
 *
 * OpenCode / Cline 的模式是「主会话决定何时开 task/subagent」，而不是 host
 * 用 NL 关键词替模型拍板。yaml triggers.kind=nl 的 patterns 只作为
 * whenToUse 提示词，绝不在 host 侧正则匹配自动启动。
 *
 * 本文件不 import vscode / pi SDK。
 */
import type { OpsCustomToolSpec } from './resource-loader';

export const LIST_PLAYBOOKS_TOOL_NAME = 'ops_list_playbooks';
export const START_PLAYBOOK_TOOL_NAME = 'ops_start_playbook';

export interface PlaybookCatalogEntry {
  id: string;
  title: string;
  description?: string;
  /** yaml NL patterns：给模型判断「这个问题适不适合这条链路」，不是 host 触发器。 */
  whenToUse?: string[];
}

export interface PlaybookStartResult {
  ok: boolean;
  stage?: string;
  error?: string;
}

/** host 注入；缺席时工具仍注册，返回中文说明而不是抛错。 */
export interface PlaybookToolHost {
  list(): PlaybookCatalogEntry[] | Promise<PlaybookCatalogEntry[]>;
  start(playbookId: string): PlaybookStartResult | Promise<PlaybookStartResult>;
}

export function createPlaybookTools(host: PlaybookToolHost | undefined): OpsCustomToolSpec[] {
  return [
    {
      name: LIST_PLAYBOOKS_TOOL_NAME,
      label: 'Ops：列出运维链路',
      description:
        '列出可用的运维 Playbook 链路（id / 标题 / 适用场景提示）。' +
        '简单问答、闲聊、与运维无关的问题不要启动链路。' +
        '只有当前问题确实需要结构化排查、变更或巡检时，再调用 ops_start_playbook。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        if (!host) {
          return JSON.stringify({
            error: 'UNAVAILABLE',
            message: 'host 未接线 playbook 目录，无法列出链路。'
          });
        }
        const playbooks = await host.list();
        return JSON.stringify({ playbooks, hint: '是否启动由你决定，host 不会因关键词自动启动。' });
      }
    },
    {
      name: START_PLAYBOOK_TOOL_NAME,
      label: 'Ops：启动运维链路',
      description:
        '启动一条 Playbook。仅当你判断当前用户问题匹配该链路时调用。' +
        '不要因为用户消息里出现「故障」「超时」等词就启动；先看问题是否真的需要这条结构化流程。' +
        '已有进行中的 playbook 时不要叠加启动。',
      parameters: {
        type: 'object',
        properties: {
          playbookId: {
            type: 'string',
            description: 'ops_list_playbooks 返回的 id，例如 pb.incident'
          }
        },
        required: ['playbookId'],
        additionalProperties: false
      },
      execute: async (args) => {
        const playbookId = typeof args.playbookId === 'string' ? args.playbookId.trim() : '';
        if (playbookId.length === 0) {
          return JSON.stringify({
            ok: false,
            error: 'playbookId 不能为空；先用 ops_list_playbooks 查看可用链路。'
          });
        }
        if (!host) {
          return JSON.stringify({
            ok: false,
            error: 'host 未接线，无法启动 playbook。用户仍可通过标题栏 /playbook 手动选择。'
          });
        }
        const result = await host.start(playbookId);
        return JSON.stringify(result);
      }
    }
  ];
}
