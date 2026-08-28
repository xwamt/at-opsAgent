/**
 * OpsCore facade（P2-1）：把 runtime + orchestrator + hub-host + policy +
 * mcp-client 收成**无 vscode import** 的单一 API 面。
 *
 * host（src/host/**）只经 createOpsCore() 装配这些模块——不再有动态
 * import 装载器与四套 fallback（P1-8 已删）。将来若出现第二客户端
 * （CLI 值班脚本 / Web 值班台），给本 facade 套 HTTP/SSE 壳即可，
 * 不需要抽独立 server 进程（ADR-001 进程模型不变）。
 */
import {
  createAtSeriesHubHost,
  type AtSeriesHubHostOptions
} from '../hub-host';
import {
  createOrchestrator,
  loadPlaybooks,
  type CreateOrchestratorOptions,
  type Orchestrator,
  type Playbook
} from '../orchestrator';
import {
  evaluatePolicy,
  hashCommandSet,
  issueApprovalToken,
  verifyApprovalToken,
  type PolicyContext,
  type PolicyDecision
} from '../policy';
import {
  buildSystemPrompt,
  createFallbackRuntime,
  createOpsRuntime,
  type BeforeToolCallVerdict,
  type CreateOpsRuntimeOptions,
  type OpsRuntime,
  type OpsRuntimeEvent,
  type OpsRuntimeHandlers,
  type OpsSubagentEvent,
  type ToolCallOrigin
} from '../runtime';
import { shouldSkipAtSeriesMcpServer } from '../mcp-client';
import type { HubHost } from '../protocol';

export type {
  AtSeriesHubHostOptions,
  BeforeToolCallVerdict,
  CreateOpsRuntimeOptions,
  CreateOrchestratorOptions,
  OpsRuntime,
  OpsRuntimeEvent,
  OpsRuntimeHandlers,
  OpsSubagentEvent,
  Orchestrator,
  Playbook,
  PolicyContext,
  PolicyDecision,
  ToolCallOrigin
};

export interface OpsCore {
  /** Bridge registry 聚合 Hub（fs.watch 热注册；ADR-001 进程内）。 */
  createHub(options: AtSeriesHubHostOptions & Record<string, unknown>): HubHost;
  /** pi 会话 runtime。创建期失败在内部落 FallbackRuntime，不抛出。 */
  createRuntime(
    handlers: OpsRuntimeHandlers,
    options?: CreateOpsRuntimeOptions
  ): Promise<OpsRuntime>;
  /** 显式兜底 runtime（正常路径不需要：createRuntime 内部已兜底）。 */
  createFallbackRuntime(handlers: OpsRuntimeHandlers, reason?: string): OpsRuntime;
  /** playbook 状态机 + 审批简报编排。 */
  createOrchestrator(options: CreateOrchestratorOptions): Orchestrator;
  /** 打包 playbook yaml 加载（校验失败抛错，调用方决定降级）。 */
  loadPlaybooks(rootDir: string): Playbook[];
  /** 策略闸（纯函数；host 在 beforeToolCall 装配）。 */
  evaluatePolicy(ctx: PolicyContext): PolicyDecision;
  /** L0–L3（+可选 L4）系统提示词合成。 */
  buildSystemPrompt(opts?: { playbookLayer?: string }): string;
  /** AT 系列 MCP server 去重判定（诊断 / mcp.json 扫描用）。 */
  shouldSkipMcpServer: typeof shouldSkipAtSeriesMcpServer;
  /** 审批令牌纯函数（HMAC；secret 只存 host 内存）。 */
  approvals: {
    hashCommandSet: typeof hashCommandSet;
    issueToken: typeof issueApprovalToken;
    verifyToken: typeof verifyApprovalToken;
  };
}

export function createOpsCore(): OpsCore {
  return {
    createHub: (options) => createAtSeriesHubHost(options),
    createRuntime: (handlers, options) => createOpsRuntime(handlers, options),
    createFallbackRuntime: (handlers, reason) => createFallbackRuntime(handlers, reason),
    createOrchestrator: (options) => createOrchestrator(options),
    loadPlaybooks: (rootDir) => loadPlaybooks(rootDir),
    evaluatePolicy: (ctx) => evaluatePolicy(ctx),
    buildSystemPrompt: (opts) => buildSystemPrompt(opts),
    shouldSkipMcpServer: shouldSkipAtSeriesMcpServer,
    approvals: {
      hashCommandSet,
      issueToken: issueApprovalToken,
      verifyToken: verifyApprovalToken
    }
  };
}
