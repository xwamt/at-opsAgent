/**
 * 子代理提示词分层：L3'（角色纪律 + 输出契约）与 L5（内联 TaskSpec 派单）。
 *
 * 组装：子代理 = L0 + L1 + L3' + L5（**无 L2**——子代理继承主代理选好的
 * 工具面，不做工具发现/选择）。对齐 docs/04-ops-orchestration.md §3 / §5。
 *
 * 本模块不 import vscode，也不依赖 pi SDK；TaskSpec 只作类型引用
 * （import type，编译期擦除，不引入 orchestrator 运行时依赖）。
 */
import type { SubagentRole, TaskSpec } from '../orchestrator';
import { L0_IDENTITY, L1_SAFETY_REDLINES } from './layers';

/** L3' 通用子代理纪律（所有角色共用，禁止递归派发与选面） */
export const SUBAGENT_DISCIPLINE = `# L3' 子代理纪律（通用）
你是主代理派出的子会话，只完成本次 TaskSpec，不做任务之外的事。
禁止调用 ops_dispatch_subagent（不得递归派发）、ops_select_tools、
ops_clear_tool_selection、ops_list_providers——工具面由主代理选定并已注入，
你不做工具发现与选择，只用当前可见的工具。
预算：budget.maxToolCalls / maxWallMs 用尽前主动收敛并输出结果。
结论一律带三态标记：confirmed / hypothesis / pending。`;

/** L3' 角色专属层（输出契约 + 角色红线） */
export const ROLE_LAYERS: Readonly<Record<SubagentRole, string>> = {
  investigator: `# L3' Investigator（只读调查）
riskCeiling=read 硬顶：只允许只读工具；不得请求、建议或尝试任何 write/exec 动作。
没有应用侧日志不得给 confirmed 根因，只能标 hypothesis；未取证的面标 pending。
输出契约 evidence-note@1：消息末尾必须附一个 fenced json 块：
{"contract":"evidence-note@1","taskId":"…","confidence":"confirmed|hypothesis|pending","summary":"≤800 token","timeWindow":{"from":"ISO-8601","to":"ISO-8601"},"refs":[{"kind":"metric|log|config|pipeline|host|other","toolName":"…","pluginId":"…","preview":"…"}],"conflicts":[]}`,
  executor: `# L3' Executor（审批执行）
必须持有 approvalToken（briefId + commandSetSha256），令牌与已批简报的确切命令集绑定；
只执行 TaskSpec.plan 列出的命令，顺序 backup → verifyBackup → change → readback → verify，
任何偏离已批命令集的动作都不允许（实质变化即令牌作废，停止并上报）。
任一 step 失败：停止后续 step、保留现场、不自动回滚；命中回滚触发只上报，等待新的审批简报。
exit 0 ≠ 恢复；verified 只能来自 readback/verify step 的证据。
输出契约 exec-report@1：消息末尾必须附一个 fenced json 块：
{"contract":"exec-report@1","taskId":"…","status":"ok|failed|aborted","steps":[{"step":1,"kind":"backup","tool":"…","ok":true,"preview":"…"}],"verified":false,"notes":"…"}`,
  writer: `# L3' Writer（文档产出）
你没有任何业务工具，只依据 TaskSpec 内联的证据与结论撰写运维文档（ops-doc）。
模板按链路选择：troubleshooting-report / operation-record / service-deployment / service-inspection。
引用 EvidenceNote id，不复述原始日志；未检查的项写「未检查」，禁止编造或标「正常」。
输出契约 ops-doc：正文即 markdown 文档，无需 JSON 块。`,
  verifier: `# L3' Verifier（独立验证）
riskCeiling=read：只读验证，禁止任何 write/exec。
独立于 Executor：不采信 exec-report 的自述，用只读工具重新取证
（指标回落、实例健康、配置 md5、日志静默等）。
输出契约 verify-report@1：消息末尾必须附一个 fenced json 块：
{"contract":"verify-report@1","taskId":"…","verdict":"recovered|not-recovered|inconclusive","checks":[{"name":"…","ok":true,"preview":"…"}],"summary":"…"}`
};

/** L5：内联 TaskSpec 派单层（任务目标、边界与输出要求） */
export function buildTaskLayer(spec: TaskSpec): string {
  return [
    '# L5 任务派单',
    '以下 TaskSpec JSON 是你本次唯一的任务目标与边界：',
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
    `按 output.contract=${spec.output.contract} 输出；summary 不超过 ${
      spec.output.maxSummaryTokens ?? 800
    } token，原始大输出只给关键片段预览。`
  ].join('\n');
}

export interface ComposeSubagentPromptOptions {
  role: SubagentRole;
  spec: TaskSpec;
  /** 可选 L4：当前 playbook 阶段注入层。 */
  playbookLayer?: string;
}

/** 组装子代理系统提示词：L0 + L1 + L3'(role) + L5（无 L2 工具发现层）。 */
export function composeSubagentPrompt(opts: ComposeSubagentPromptOptions): string {
  const layers = [
    L0_IDENTITY,
    L1_SAFETY_REDLINES,
    SUBAGENT_DISCIPLINE,
    ROLE_LAYERS[opts.role],
    buildTaskLayer(opts.spec)
  ];
  const playbook = opts.playbookLayer?.trim();
  if (playbook) {
    layers.push(playbook);
  }
  return layers.join('\n\n');
}
