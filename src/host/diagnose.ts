/**
 * atOpsAgent.diagnoseHub：Output Channel 打印 Hub 诊断信息。
 *
 * 打印：hostApp、home、bridges 目录（含各 hostApp 子目录 record 数与
 * unscoped 忽略数）、listBridgeRecords 条数、每条 pluginId/port/updatedAt/stale。
 * 同时扫描 ~/.cursor/mcp.json 与 ~/.at-series/agent/mcp.json 做 AT Series 去重提示。
 *
 * 禁止打印：token、Authorization、任何凭据。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { atSeriesRootDir, bridgesDirForHostApp, listBridgeRecords } from '@at-series/mcp-hub';
import { OPS_ERROR, type HubHost } from '../protocol';
import { shouldSkipAtSeriesMcpServerFallback } from './fallback/fallbackDedup';
import type { McpServerEntryLike } from './hostTypes';
import { loadDedupModule } from './modules';

const STALE_MS = 90_000;

export interface DiagnoseInput {
  hostApp: string;
  hub: HubHost | undefined;
  output: vscode.OutputChannel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function diagnoseHub(input: DiagnoseInput): Promise<void> {
  const { hostApp, hub, output } = input;
  const home = os.homedir();
  const log = (line: string) => output.appendLine(line);

  log('');
  log(`=== AT Ops Agent · Hub 诊断 ${new Date().toISOString()} ===`);
  log(`hostApp: ${hostApp}`);
  log(`home: ${home}`);

  // ── bridges 目录 ────────────────────────────────────────────────────────
  const bridgesRoot = path.join(atSeriesRootDir(home), 'bridges');
  log(`bridges 根目录: ${bridgesRoot}`);
  try {
    const entries = await fs.readdir(bridgesRoot, { withFileTypes: true });
    let unscoped = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        unscoped += 1;
        continue;
      }
      if (!entry.isDirectory()) continue;
      let count = 0;
      try {
        count = (await fs.readdir(path.join(bridgesRoot, entry.name))).filter((f) =>
          f.endsWith('.json')
        ).length;
      } catch {
        // 子目录不可读：按 0 计。
      }
      const marker = entry.name === hostApp ? '  ← 本进程 hostApp' : '';
      log(`  ${entry.name}/: ${count} 条 record${marker}`);
    }
    if (unscoped > 0) {
      log(`  （忽略 ${unscoped} 条未按 hostApp 分目录的 unscoped record —— 协议 v1 已不再读取）`);
    }
  } catch {
    log('  （目录不存在——尚无任何 AT 系列插件发布 Bridge）');
  }

  // ── 本 hostApp 的 registry records ─────────────────────────────────────
  log(`registry 目录: ${bridgesDirForHostApp(hostApp, home)}`);
  try {
    const records = await listBridgeRecords({ hostApp, home });
    log(`listBridgeRecords(${hostApp}): ${records.length} 条`);
    const now = Date.now();
    for (const record of records) {
      const stale = now - record.updatedAt > STALE_MS;
      log(
        `  - ${record.pluginId}  bridge=${record.bridgeId.slice(0, 8)}…  port=${record.port}  ` +
          `pid=${record.pid}  updatedAt=${new Date(record.updatedAt).toISOString()}  ` +
          `${stale ? 'stale(>90s)' : 'fresh'}  tools=${record.tools.length}`
      );
    }
    if (records.length === 0) {
      log('  提示：安装并激活 AT 系列插件（Terminal / Grafana / Jenkins / Nacos / JumpServer / Database）后会自动出现，无需配置 MCP。');
    }
  } catch (err) {
    log(`listBridgeRecords 失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── HubHost 聚合视角 ────────────────────────────────────────────────────
  if (hub) {
    try {
      const providers = hub.getProviders();
      log(`HubHost providers: ${providers.providers.length} 个 plugin`);
      for (const p of providers.providers) {
        log(
          `  - ${p.pluginId} (${p.displayName})  ${p.healthy ? 'healthy' : 'unhealthy'}  ` +
            `bridges=${p.bridgeCount}  tools=${p.toolNames.length}` +
            (p.connectedTargets !== undefined ? `  connected=${p.connectedTargets}` : '')
        );
      }
      log(`HubHost 暴露集: ${hub.listExposedTools().length} / 全量 ${hub.listAllTools().length} 个工具`);
    } catch (err) {
      log(`HubHost 查询失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('HubHost: 未创建');
  }

  // ── 用户 MCP 配置去重扫描 ───────────────────────────────────────────────
  await scanUserMcpConfigs(home, log);

  log('=== 诊断结束 ===');
  output.show(true);
}

async function scanUserMcpConfigs(
  home: string,
  log: (line: string) => void
): Promise<void> {
  log('MCP 去重扫描:');
  const dedupModule = await loadDedupModule(log);
  const shouldSkip = (entry: McpServerEntryLike): boolean => {
    if (dedupModule) {
      try {
        const result = dedupModule.shouldSkipAtSeriesMcpServer(entry);
        return typeof result === 'boolean' ? result : result.skip;
      } catch {
        // 落回启发式。
      }
    }
    return shouldSkipAtSeriesMcpServerFallback(entry);
  };

  const files = [
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.at-series', 'agent', 'mcp.json')
  ];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      log(`  ${file}: 不存在或不可解析（跳过）`);
      continue;
    }
    const servers = extractServers(raw);
    if (servers.length === 0) {
      log(`  ${file}: 无 server 条目`);
      continue;
    }
    for (const entry of servers) {
      if (shouldSkip(entry)) {
        log(
          `  ${file}: server "${entry.name}" → ${OPS_ERROR.PROVIDER_SKIPPED} 已由内置 AT Series 接管`
        );
      } else {
        log(`  ${file}: server "${entry.name}" 保留（非 AT Series）`);
      }
    }
  }
}

/** 兼容 cursor 的 mcpServers 与本扩展 mcp.json 的 servers 两种布局。 */
function extractServers(raw: unknown): McpServerEntryLike[] {
  if (!isRecord(raw)) return [];
  const table = isRecord(raw.mcpServers) ? raw.mcpServers : isRecord(raw.servers) ? raw.servers : undefined;
  if (!table) return [];
  const entries: McpServerEntryLike[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (!isRecord(value)) continue;
    entries.push({
      name,
      command: typeof value.command === 'string' ? value.command : undefined,
      args: Array.isArray(value.args)
        ? value.args.filter((a): a is string => typeof a === 'string')
        : undefined,
      url: typeof value.url === 'string' ? value.url : undefined
    });
  }
  return entries;
}
