/**
 * Agent runtime：封装 @earendil-works/pi-coding-agent（0.84.3 精确锁定）。
 *
 * 约束（见 AGENTS.md / docs/03）：
 * - 禁止 import vscode。
 * - 默认不启用 pi 内置 coding 四件套（read/bash/edit/write）——运维动作走 AT 插件。
 * - pi 是 ESM-only 包，esbuild 会把扩展打成 CJS，因此这里只用
 *   `import type`（编译期擦除）+ 运行时动态 `import()`。
 * - 无 API key / 模型不可用时不得抛出导致扩展无法激活：createOpsRuntime
 *   捕获一切创建期错误并返回 FallbackRuntime。
 *
 * 本文件是装配 + 公共 barrel。实现见 types / tool-gate / fallback /
 * session-events / subagent-session / session-factory。
 */
import { composeSystemPrompt } from '../prompts/layers';
import { createFallbackRuntime, describeError } from './fallback';
import { createPiRuntime } from './session-factory';
import type { CreateOpsRuntimeOptions, OpsRuntime, OpsRuntimeHandlers } from './types';

export {
  discoveryToolNames,
  discoveryToolSpecs,
  executeDiscoveryTool,
  isBusinessToolName,
  listBusinessToolDescriptors,
  searchTools,
  getTool,
  listProviders,
  selectTools,
  clearToolSelection,
  DESCRIPTION_PREVIEW_LIMIT,
  type DiscoveryHub,
  type DiscoveryToolSpec,
  type SearchToolsArgs,
  type SearchToolsResult
} from './discovery-tools';

export {
  buildTaskSpec,
  createCheckSubagentTool,
  createSubagentManager,
  dispatchToolSpec,
  filterToolsForSubagent,
  normalizeDispatchInput,
  parseContractJson,
  parseEvidenceNote,
  runCheckSubagentToolCall,
  runDispatchToolCall,
  truncateSummary,
  CHECK_SUBAGENT_TOOL_NAME,
  DEFAULT_SUBAGENT_BUDGET,
  DISPATCH_TOOL_NAME,
  MAX_DISPATCH_TASKS,
  ROLE_PARALLEL_LIMITS,
  SUBAGENT_SUMMARY_CHAR_LIMIT,
  type BuildTaskSpecOutcome,
  type ContractJson,
  type DispatchToolTaskResult,
  type SubagentDispatchInput,
  type SubagentFinalResult,
  type SubagentManager,
  type SubagentRunner,
  type SubagentRunOutcome,
  type SubagentRunStatus,
  type SubagentStatusEvent
} from './subagents';

export {
  createOpsResourceLoader,
  createReadSkillTool,
  defaultBundledSkillsDir,
  readSkillFile,
  resolveUnderRoot,
  skillRootsFor,
  READ_SKILL_TOOL_NAME,
  SKILL_FILE_CHAR_LIMIT,
  type CreateOpsResourceLoaderOptions,
  type OpsCustomToolSpec,
  type ReadSkillResult
} from './resource-loader';

export {
  isPromptTooLongError,
  recoverFromPromptError,
  COMPACTION_NEW_SESSION_MESSAGE,
  type CompactableSessionLike
} from './compaction';

export {
  createWorkspaceReadTool,
  readWorkspaceFile,
  READ_WORKSPACE_FILE_TOOL_NAME,
  WORKSPACE_FILE_CHAR_LIMIT,
  type ReadWorkspaceFileResult
} from './workspace-read';

export {
  createPlaybookTools,
  ADVANCE_STAGE_TOOL_NAME,
  CLOSE_PLAYBOOK_TOOL_NAME,
  LIST_PLAYBOOKS_TOOL_NAME,
  START_PLAYBOOK_TOOL_NAME,
  type PlaybookCatalogEntry,
  type PlaybookStartResult,
  type PlaybookToolHost
} from './playbook-tools';

export {
  createRecallTool,
  RECALL_TOOL_NAME,
  INCIDENT_INDEX_MAX_LINES,
  RECALL_MAX_LINES,
  resolveMemoryDir,
  defaultHomeMemoryDir
} from './ops-recall';

export type {
  ToolCallOrigin,
  BeforeToolCallVerdict,
  OpsRuntimeHandlers,
  OpsSubagentEvent,
  OpsRuntimeEvent,
  DispatchSubagentResult,
  OpsThinkingLevel,
  OpsRuntime,
  CreateOpsRuntimeOptions
} from './types';

export {
  TOOL_END_PREVIEW_LIMIT,
  truncatePreview,
  MAIN_ORIGIN,
  applyToolGate,
  MODEL_RESULT_CHAR_LIMIT,
  TOOL_RESULTS_DIRNAME,
  truncateForModel,
  isCancelledInvocation,
  executeBusinessTool,
  catalogGainedNewBusinessTool,
  type ToolGateResult,
  type TruncateForModelContext
} from './tool-gate';

export {
  FALLBACK_NOTICE,
  FALLBACK_INIT_FAILURE_PREFIX,
  CREDENTIAL_NOTICE,
  TRANSIENT_PROMPT_RETRY_MS,
  OPEN_SETTINGS_NOTICE_ACTION,
  RETRY_NOTICE_ACTION,
  looksLikeMissingModelConfig,
  classifyPromptError,
  handleClassifiedPromptError,
  runPromptWithRecovery,
  createFallbackRuntime,
  type PromptErrorClass
} from './fallback';

export {
  roleModelPrefOf,
  resolveSubagentModel,
  type RoleModelRole,
  type ResolveSubagentModelInput
} from './subagent-session';

/** 组装主代理系统提示词：L0+L1+L2+L3（+可选 L-env 现场层 +可选 L-mem 工作记忆 +可选 L4 playbook 注入层）。 */
export function buildSystemPrompt(
  opts: { playbookLayer?: string; envLayer?: string; memLayer?: string } = {}
): string {
  return composeSystemPrompt(opts);
}

/**
 * 创建 Ops 运行时。任何创建期失败（pi 加载、凭证、模型解析、会话创建）
 * 都不抛出，改为返回 FallbackRuntime，保证扩展激活不受影响。
 */
export async function createOpsRuntime(
  handlers: OpsRuntimeHandlers,
  options: CreateOpsRuntimeOptions = {}
): Promise<OpsRuntime> {
  try {
    return await createPiRuntime(handlers, options);
  } catch (error) {
    return createFallbackRuntime(handlers, describeError(error));
  }
}
