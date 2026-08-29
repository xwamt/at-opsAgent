/**
 * pi 主会话工厂（createPiRuntime）：模型注入、工具面装配、会话续接。
 *
 * 从 src/runtime/index.ts 搬移，零行为变化。禁止 import vscode。不要 fork pi。
 */
import { join } from 'node:path';

import type {
  CreateAgentSessionOptions,
  SessionManager,
  ToolDefinition
} from '@earendil-works/pi-coding-agent';

import { composeSystemPrompt } from '../prompts/layers';
import { applyDiscoveryNudge, createDiscoveryNudgeState } from './discovery-nudge';
import { listBusinessToolDescriptors } from './discovery-tools';
import { describeError, runPromptWithRecovery, TRANSIENT_PROMPT_RETRY_MS } from './fallback';
import { createRecallTool, RECALL_TOOL_NAME } from './ops-recall';
import { createPlaybookTools } from './playbook-tools';
import {
  createOpsResourceLoader,
  createReadSkillTool,
  defaultBundledSkillsDir,
  skillRootsFor,
  type OpsCustomToolSpec
} from './resource-loader';
import { subscribeSessionEvents } from './session-events';
import { createMainSubagentLayer, defaultAgentDir, resolveModel } from './subagent-session';
import {
  createCheckSubagentTool,
  dispatchToolSpec,
  runDispatchToolCall
} from './subagents';
import {
  activeToolNames,
  appendExternalMcpProxyTools,
  applyToolGate,
  buildBusinessTools,
  buildDiscoveryTools,
  catalogGainedNewBusinessTool,
  createApiKeyInjector,
  MAIN_ORIGIN,
  toPiTool
} from './tool-gate';
import type {
  CreateOpsRuntimeOptions,
  OpsRuntime,
  OpsRuntimeHandlers,
  OpsThinkingLevel
} from './types';
import { createWorkspaceReadTool } from './workspace-read';
import { createWriteOpsDocTool, type WriteOpsDocHandler } from './workspace-write';

export async function createPiRuntime(
  handlers: OpsRuntimeHandlers,
  options: CreateOpsRuntimeOptions
): Promise<OpsRuntime> {
  const pi = await import('@earendil-works/pi-coding-agent');
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? defaultAgentDir();

  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json')
  });

  // P0：SecretStorage 的 API key 经 setRuntimeApiKey 注入 pi 凭证层。
  // models.json 里的 apiKey 往往是 "${secret:…}" 占位符，若不覆盖会被当成
  // 真实 bearer token 发出去。key 只在本地变量中经过，绝不写日志。
  // 只对「首选 provider」与「实际选中模型的 provider」按 provider 取 key
  // 注入——getRegisteredProviderIds()[0] 启发式已删除（P0-B）。
  const injectApiKey = createApiKeyInjector(modelRuntime, options.getApiKey);
  await injectApiKey(options.model?.provider);

  const model = (await resolveModel(modelRuntime, options.model)) as CreateAgentSessionOptions['model'];

  // 实际选中模型的 provider 与首选 provider 不同时（如按可用性兜底选中），
  // 同样注入该 provider 的 key，保证选中模型不用占位符凭证。
  const resolvedProvider = (model as { provider?: unknown } | undefined)?.provider;
  if (typeof resolvedProvider === 'string') {
    await injectApiKey(resolvedProvider);
  }

  const { subagents, dispatchSubagent } = createMainSubagentLayer({
    pi,
    handlers,
    cwd,
    agentDir,
    modelRuntime,
    model,
    injectApiKey,
    ...(options.roleModels !== undefined ? { roleModels: options.roleModels } : {})
  });

  let systemPrompt = composeSystemPrompt({});
  const settingsManager = pi.SettingsManager.inMemory();
  // OpsResourceLoader：skills 只从两个白名单根（打包 skills + agentDir/skills）
  // 发现，noExtensions 恒为 true；其余资源面全关。
  const bundledSkillsDir = options.bundledSkillsDir ?? defaultBundledSkillsDir(cwd);
  const skillRoots = skillRootsFor({ bundledSkillsDir, agentDir });
  const resourceLoader = createOpsResourceLoader(pi, {
    cwd,
    agentDir,
    bundledSkillsDir,
    settingsManager,
    systemPromptOverride: () => systemPrompt
  });
  await resourceLoader.reload();

  // ops_dispatch_subagent 仅注册在主会话（子会话不注册，禁止递归派发）。
  // P1-6：execute 阻塞到全部子代理终态，工具结果 = 终态摘要 JSON。
  const dispatchTool = toPiTool(pi, {
    name: dispatchToolSpec.name,
    label: dispatchToolSpec.label,
    description: dispatchToolSpec.description,
    parameters: dispatchToolSpec.parameters,
    execute: async (args) => {
      const gate = await applyToolGate(handlers, dispatchToolSpec.name, args, MAIN_ORIGIN);
      if (gate.kind === 'reject') return gate.resultJson;
      return runDispatchToolCall(args, subagents);
    }
  });

  // 常驻附加工具（不受 hub selection 影响；仅主会话，子会话一律没有）。
  const gatedTool = (spec: OpsCustomToolSpec): ToolDefinition =>
    toPiTool(pi, {
      ...spec,
      execute: async (args) => {
        const gate = await applyToolGate(handlers, spec.name, args, MAIN_ORIGIN);
        if (gate.kind === 'reject') return gate.resultJson;
        return spec.execute(args);
      }
    });

  const extraToolNames: string[] = [];
  const extraTools: ToolDefinition[] = [];

  // ops_check_subagent：只读收割 waitMs 早返的任务；仅主会话（禁递归）。
  const checkSpec = createCheckSubagentTool(subagents);
  extraTools.push(gatedTool(checkSpec));
  extraToolNames.push(checkSpec.name);

  // ops_read_skill：命中 playbook/vendor 后按需读 SKILL.md / references。
  const readSkillSpec = createReadSkillTool(skillRoots);
  extraTools.push(gatedTool(readSkillSpec));
  extraToolNames.push(readSkillSpec.name);

  // 可选工作区只读（默认关）；开启也只给 ops_read_workspace_file，绝无 bash。
  if (options.workspaceShellEnabled === true) {
    const workspaceReadSpec = createWorkspaceReadTool(cwd);
    extraTools.push(gatedTool(workspaceReadSpec));
    extraToolNames.push(workspaceReadSpec.name);
  }

  // 运维链路：由主代理决定是否启动，host 不再用 NL 关键词自动开 playbook。
  for (const spec of createPlaybookTools(handlers.playbooks)) {
    extraTools.push(gatedTool(spec));
    extraToolNames.push(spec.name);
  }

  // 运维文档落盘（仅 ops-docs/；write 走审批闸；host 未接线则不注册）。
  const writeOpsDoc = (handlers as { writeOpsDoc?: WriteOpsDocHandler }).writeOpsDoc;
  if (typeof writeOpsDoc === 'function') {
    const writeSpec = createWriteOpsDocTool(writeOpsDoc);
    extraTools.push(gatedTool(writeSpec));
    extraToolNames.push(writeSpec.name);
  }

  // 长期记忆只读检索（仅主会话；子会话一律没有）。
  extraTools.push(
    gatedTool(
      createRecallTool({
        ...(typeof handlers.memoryDir === 'function' ? { memoryDir: handlers.memoryDir } : {}),
        ...(typeof handlers.recallMemory === 'function'
          ? { recallMemory: handlers.recallMemory }
          : {})
      })
    )
  );
  extraToolNames.push(RECALL_TOOL_NAME);

  // 目录热更新判定基线：本次注册进会话的业务工具名快照。
  const registeredBusinessNames = new Set(
    listBusinessToolDescriptors(handlers.hub.listAllTools()).map((t) => t.name)
  );

  // docs/13 §4.4 主会话发现空转软顶：ops_search_tools / ops_get_tool 同一
  // 工具 + 规范化参数连续 ≥2 次空结果时在结果 JSON 附加 nudge（advisory，
  // 不 block）。状态在本 runtime 闭包内（随会话生命周期，绝不全局）。
  const discoveryNudgeState = createDiscoveryNudgeState();
  const customTools = [
    ...buildDiscoveryTools(pi, handlers, (toolName, args, resultJson) =>
      applyDiscoveryNudge(discoveryNudgeState, toolName, args, resultJson)
    ),
    dispatchTool,
    ...extraTools,
    ...buildBusinessTools(pi, handlers, agentDir)
  ];

  await appendExternalMcpProxyTools(
    pi,
    handlers,
    agentDir,
    customTools,
    extraToolNames,
    registeredBusinessNames
  );

  // P0-C 会话单真源：主会话 JSONL 持久化到 agentDir/sessions（默认
  // ~/.at-series/agent/sessions）。host 重建 runtime（换模型 / 新插件工具）
  // 时经 resumeSessionFile 续接同一 JSONL——SessionManager.open 载入既有
  // transcript，LLM 上下文不丢。打开失败（文件被删/损坏）回退新建；新建
  // 失败（目录不可写等）再回退 in-memory：会话可用性优先于持久化。
  // 子代理子会话始终 in-memory（不落工作副本 transcript）。
  const sessionsDir = join(agentDir, 'sessions');
  const sessionManager: SessionManager = (() => {
    if (options.resumeSessionFile !== undefined && options.resumeSessionFile.length > 0) {
      try {
        return pi.SessionManager.open(options.resumeSessionFile, sessionsDir, cwd);
      } catch {
        // 续接文件被删/损坏：降级新建（不失败激活）。
      }
    }
    try {
      return pi.SessionManager.create(cwd, sessionsDir);
    } catch {
      return pi.SessionManager.inMemory(cwd);
    }
  })();

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    // 思考等级透传（缺省时由 pi 按 settings/模型能力决定）。
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    // 不要内置 coding 四件套（read/bash/edit/write）；只保留 custom 工具。
    noTools: 'builtin',
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager
  });

  // 初始 active = 发现工具 + 常驻附加工具 + 当前暴露的业务工具；
  // select 变化后即时同步。
  session.setActiveToolsByName(activeToolNames(handlers, extraToolNames));
  const selectionSub = handlers.hub.selection.onDidChange(() => {
    session.setActiveToolsByName(activeToolNames(handlers, extraToolNames));
  });

  // P1-15：目录重建请求排队到会话 idle（agent_end）后再回调 host——
  // 流式进行中装插件不打断当前上下文；host 重建时带 resumeSessionFile 续接。
  let rebuildQueued = false;
  const requestCatalogRebuild = (): void => {
    if (handlers.onCatalogNeedsRebuild === undefined) return;
    if (session.isStreaming) {
      rebuildQueued = true;
      return;
    }
    rebuildQueued = false;
    handlers.onCatalogNeedsRebuild();
  };

  // 软停（abort('cancel')）：等当前 in-flight 工具调用全部结束后再 abort。
  const inflightToolCalls = new Set<string>();
  let softAbortPending = false;
  const hardAbort = (): void => {
    softAbortPending = false;
    // 全局停止 = 主会话 + 全部子代理级联中止。
    subagents.abortAll();
    void session.abort().catch(() => {
      // abort 竞态（会话已结束）无需上报。
    });
  };

  // P1：工具目录变化（插件桥接上线/下线）时热刷新工具面。
  // 已知限制：pi 的 AgentSession 只在 createAgentSession 期接收 customTools
  // （AgentSessionConfig.customTools，之后是私有 _customTools），0.84.3 没有
  // 任何公开 API 能事后追加/替换 ToolDefinition（reload() 只重载资源）。
  // 因此：
  // - 下线工具立即消失、重新上线的已注册工具立即恢复（setActiveToolsByName）；
  // - 目录里出现全新的业务工具时，经 requestCatalogRebuild 通知 host 重建
  //   runtime（P1-15：流式中排队到 idle），新工具才能进模型工具面。
  const toolsSub = handlers.hub.onDidChangeTools?.(() => {
    session.setActiveToolsByName(activeToolNames(handlers, extraToolNames));
    if (catalogGainedNewBusinessTool(registeredBusinessNames, handlers.hub.listAllTools())) {
      requestCatalogRebuild();
    }
  });
  const unsubscribe = subscribeSessionEvents(session, handlers, {
    onIdle: () => {
      if (rebuildQueued) requestCatalogRebuild();
    },
    onToolActivity: (kind, toolCallId) => {
      if (kind === 'start') {
        inflightToolCalls.add(toolCallId);
        return;
      }
      inflightToolCalls.delete(toolCallId);
      if (softAbortPending && inflightToolCalls.size === 0) {
        hardAbort();
      }
    }
  });

  return {
    async prompt(text: string, opts?: { mode?: 'steer' | 'followUp' }): Promise<void> {
      const run = async (): Promise<void> => {
        if (opts?.mode) {
          await session.prompt(text, { streamingBehavior: opts.mode });
        } else if (session.isStreaming) {
          // 运行中未指定 mode 时按 steer 处理（追加约束），避免 pi 抛错。
          await session.prompt(text, { streamingBehavior: 'steer' });
        } else {
          await session.prompt(text);
        }
      };
      await runPromptWithRecovery({
        run,
        session,
        onEvent: handlers.onEvent,
        onCompaction: (summary) => handlers.onEvent?.({ type: 'compaction', summary }),
        retryDelayMs: options.retryDelayMs ?? TRANSIENT_PROMPT_RETRY_MS
      });
    },
    abort(mode?: 'cancel' | 'stop'): void {
      if (mode === 'cancel' && inflightToolCalls.size > 0) {
        // 软停：保留在途证据——当前工具调用结束（tool_execution_end）后
        // 由 onToolActivity 触发 hardAbort。
        softAbortPending = true;
        return;
      }
      hardAbort();
    },
    async dispose(): Promise<void> {
      subagents.abortAll();
      selectionSub.dispose();
      toolsSub?.dispose();
      unsubscribe();
      try {
        await session.abort();
      } catch {
        // 忽略 dispose 期的 abort 失败。
      }
      session.dispose();
    },
    setSystemPrompt(prompt: string): void {
      systemPrompt = prompt;
      // 立即生效于下一次 LLM 调用；后续 setActiveToolsByName 触发的
      // rebuild 会经 resourceLoader.systemPromptOverride 读到同一份。
      session.agent.state.systemPrompt = prompt;
    },
    setThinkingLevel(level: OpsThinkingLevel): void {
      // AgentSession 0.84 提供 setThinkingLevel（按模型能力收敛并落
      // 会话 transcript）；防御性探测，实现缺席时静默忽略。
      const setter = (session as { setThinkingLevel?: (l: OpsThinkingLevel) => void })
        .setThinkingLevel;
      if (typeof setter === 'function') {
        setter.call(session, level);
      }
    },
    dispatchSubagent,
    abortSubagent(taskId: string): void {
      subagents.abort(taskId);
    },
    // P0-C：当前 JSONL 路径（in-memory 会话为 undefined）。host 重建时
    // 作为 resumeSessionFile 传回续接。getter 保证读到的是实时路径。
    get sessionFile(): string | undefined {
      try {
        return sessionManager.getSessionFile();
      } catch {
        return undefined;
      }
    },
    // models/test：一次极小补全探测连通性；错误转人话（不抛出）。
    async probeModel(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
      const started = Date.now();
      try {
        const reply = (await modelRuntime.completeSimple(model as never, {
          messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }]
        })) as { stopReason?: string; errorMessage?: string };
        if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
          return {
            ok: false,
            error: reply.errorMessage ?? `模型探测失败（stopReason=${reply.stopReason}）`
          };
        }
        return { ok: true, latencyMs: Date.now() - started };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    }
  };
}
