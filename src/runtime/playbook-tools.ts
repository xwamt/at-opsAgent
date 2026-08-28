/**
 * 主代理选择运维链路的工具面：ops_list_playbooks / ops_start_playbook /
 * ops_advance_stage / ops_close_playbook。
 *
 * OpenCode / Cline 的模式是「主会话决定何时开 task/subagent」，而不是 host
 * 用 NL 关键词替模型拍板。yaml triggers.kind=nl 的 patterns 只作为
 * whenToUse 提示词，绝不在 host 侧正则匹配自动启动。
 *
 * P1-7：阶段推进/收尾同样由主代理显式调用 advance/close——host 停用
 * 「按消息数推进」的隐式驱动。
 *
 * 本文件不 import vscode / pi SDK。
 */
import type { OpsCustomToolSpec } from './resource-loader';

export const LIST_PLAYBOOKS_TOOL_NAME = 'ops_list_playbooks';
export const START_PLAYBOOK_TOOL_NAME = 'ops_start_playbook';
export const ADVANCE_STAGE_TOOL_NAME = 'ops_advance_stage';
export const CLOSE_PLAYBOOK_TOOL_NAME = 'ops_close_playbook';

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

/** advance / close 的统一结果（stage = 操作后所处阶段）。 */
export interface PlaybookStageResult {
  ok: boolean;
  stage?: string;
  error?: string;
}

/** host 注入；缺席时工具仍注册，返回中文说明而不是抛错。 */
export interface PlaybookToolHost {
  list(): PlaybookCatalogEntry[] | Promise<PlaybookCatalogEntry[]>;
  start(playbookId: string): PlaybookStartResult | Promise<PlaybookStartResult>;
  /**
   * 推进当前 playbook 阶段（P1-7）。stage 缺省时 host 按状态机取下一个
   * 合法阶段；非法迁移返回 ok=false（不 throw）。可选：旧 host 未接线时
   * 工具返回 UNAVAILABLE 说明。
   */
  advance?(stage?: string): PlaybookStageResult | Promise<PlaybookStageResult>;
  /** 收尾当前 playbook（推进到 closed；沿途阶段事件由 host/orchestrator 发出）。 */
  close?(): PlaybookStageResult | Promise<PlaybookStageResult>;
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
    },
    {
      name: ADVANCE_STAGE_TOOL_NAME,
      label: 'Ops：推进链路阶段',
      description:
        '把当前 playbook 推进到下一阶段（P1-7：阶段由你显式推进，host 不按消息数自动推进）。' +
        'stage 缺省时进入状态机的下一个合法阶段；也可显式给目标阶段 id。' +
        '仅在当前阶段 DoD 达成后调用；非法迁移会返回 ok=false 并列出合法的下一步。',
      parameters: {
        type: 'object',
        properties: {
          stage: {
            type: 'string',
            description: '目标阶段 id（可选；缺省 = 状态机的下一个合法阶段）'
          }
        },
        additionalProperties: false
      },
      execute: async (args) => {
        if (!host?.advance) {
          return JSON.stringify({
            ok: false,
            error: 'host 未接线阶段推进（advance），无法推进 playbook 阶段。'
          });
        }
        const stage = typeof args.stage === 'string' && args.stage.trim().length > 0
          ? args.stage.trim()
          : undefined;
        const result = await host.advance(stage);
        return JSON.stringify(result);
      }
    },
    {
      name: CLOSE_PLAYBOOK_TOOL_NAME,
      label: 'Ops：收尾链路',
      description:
        '收尾当前 playbook（推进到 closed）。调用之前必须先在对话里输出可见的' +
        '中文巡检/故障结论 markdown（主机、负载、磁盘、内存、服务、异常、未检查项），' +
        '禁止只调工具不给结论就 close。仅在产出物（报告/记录）完成、' +
        '或用户明确要求终止时调用；收尾后工具选择回到任务边界，可重新 select。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        if (!host?.close) {
          return JSON.stringify({
            ok: false,
            error: 'host 未接线链路收尾（close），无法关闭 playbook。'
          });
        }
        const result = await host.close();
        return JSON.stringify(result);
      }
    }
  ];
}
