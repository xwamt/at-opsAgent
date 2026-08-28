/**
 * 并行模块的动态装载器。
 *
 * import 路径是冻结的公开 API 入口（见 docs/10-implementation-plan.md 人力切分）：
 *   src/hub-host/index.ts            → createAtSeriesHubHost
 *   src/orchestrator/index.ts        → createOrchestrator, loadPlaybooks
 *   src/runtime/index.ts             → createOpsRuntime, buildSystemPrompt
 *   src/mcp-client/atSeriesDedup.ts  → shouldSkipAtSeriesMcpServer
 *
 * 装载失败（模块尚未落地 / 导出缺失 / 抛错）不阻断 activate：
 * 调用方使用 src/host/fallback/* 的最小实现兜底。
 */
import type { DedupModule, HubHostModule, OrchestratorModule, RuntimeModule } from './hostTypes';

type Loaded<T> = T | null;

export type ModuleLogger = (message: string) => void;

function hasFunctions(mod: unknown, names: string[]): boolean {
  if (typeof mod !== 'object' || mod === null) return false;
  return names.every((n) => typeof (mod as Record<string, unknown>)[n] === 'function');
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let hubModule: Loaded<HubHostModule> | undefined;

export async function loadHubHostModule(log: ModuleLogger): Promise<Loaded<HubHostModule>> {
  if (hubModule !== undefined) return hubModule;
  try {
    const mod: unknown = await import('../hub-host');
    if (hasFunctions(mod, ['createAtSeriesHubHost'])) {
      hubModule = mod as HubHostModule;
      return hubModule;
    }
    log('[modules] src/hub-host 缺少 createAtSeriesHubHost 导出，使用 host 内置只读 Hub 兜底');
  } catch (err) {
    log(`[modules] src/hub-host 装载失败（${describeError(err)}），使用 host 内置只读 Hub 兜底`);
  }
  hubModule = null;
  return hubModule;
}

let orchestratorModule: Loaded<OrchestratorModule> | undefined;

export async function loadOrchestratorModule(
  log: ModuleLogger
): Promise<Loaded<OrchestratorModule>> {
  if (orchestratorModule !== undefined) return orchestratorModule;
  try {
    const mod: unknown = await import('../orchestrator');
    if (hasFunctions(mod, ['createOrchestrator', 'loadPlaybooks'])) {
      orchestratorModule = mod as OrchestratorModule;
      return orchestratorModule;
    }
    log('[modules] src/orchestrator 导出不完整，使用 host 内置最小编排兜底');
  } catch (err) {
    log(`[modules] src/orchestrator 装载失败（${describeError(err)}），使用 host 内置最小编排兜底`);
  }
  orchestratorModule = null;
  return orchestratorModule;
}

let runtimeModule: Loaded<RuntimeModule> | undefined;

export async function loadRuntimeModule(log: ModuleLogger): Promise<Loaded<RuntimeModule>> {
  if (runtimeModule !== undefined) return runtimeModule;
  try {
    const mod: unknown = await import('../runtime');
    if (hasFunctions(mod, ['createOpsRuntime'])) {
      runtimeModule = mod as RuntimeModule;
      return runtimeModule;
    }
    log('[modules] src/runtime 缺少 createOpsRuntime 导出，聊天将提示运行时未就绪');
  } catch (err) {
    log(`[modules] src/runtime 装载失败（${describeError(err)}），聊天将提示运行时未就绪`);
  }
  runtimeModule = null;
  return runtimeModule;
}

let dedupModule: Loaded<DedupModule> | undefined;

export async function loadDedupModule(log: ModuleLogger): Promise<Loaded<DedupModule>> {
  if (dedupModule !== undefined) return dedupModule;
  try {
    const mod: unknown = await import('../mcp-client/atSeriesDedup');
    if (hasFunctions(mod, ['shouldSkipAtSeriesMcpServer'])) {
      dedupModule = mod as DedupModule;
      return dedupModule;
    }
    log('[modules] src/mcp-client/atSeriesDedup 导出缺失，使用 host 内置去重启发式');
  } catch (err) {
    log(`[modules] src/mcp-client/atSeriesDedup 装载失败（${describeError(err)}），使用 host 内置去重启发式`);
  }
  dedupModule = null;
  return dedupModule;
}
