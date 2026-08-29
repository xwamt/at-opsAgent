/**
 * 配置 / 设置页服务：settings/hydrate 快照、atOpsAgent.* 白名单写入、
 * mcp.json 脱敏读写（凭证绝不回传 webview / 落日志）、配置文件打开、
 * 技能目录缓存、Hub 诊断与能力刷新、工具目录变化处理
 * （plugins.autoEnableNew=false 的新插件剔除）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveToolRisk } from '../../mcp-client/riskLookup';
import {
  effectiveSessionRequiredFor,
  parseSessionRequiredFor
} from '../../policy';
import type { SessionSummary, SettingsOpenJsonReq, SettingsPatchConfigReq } from '../../protocol';
import { listProviders, type DiscoveryHub } from '../../runtime/discovery-tools';
import { diagnoseHub } from '../diagnose';
import { listSkills, type SkillInfo } from '../skillsScan';
import { describeError, isPlainRecord, type HostContext } from './context';

/** settings/patchConfig 白名单：与 package.json contributes.configuration 对齐。 */
const KNOWN_CONFIG_KEYS: readonly string[] = [
  'discovery.mode',
  'discovery.threshold',
  'plugins.autoEnableNew',
  'policy.floor',
  'approval.sessionRequiredFor',
  'approval.dedupePluginModal',
  'approval.sessionReadAllowlist',
  'approval.timeoutMs',
  'models.defaultThinkingLevel',
  'models.toolCallPromptFallback',
  'workspaceShell.enabled',
  'subagent.maxParallel',
  'sessions.maxParallel',
  'streaming.batchMs',
  'inspection.intervalMinutes',
  'im.webhookUrl',
  'ui.showThinking',
  'otel.endpoint',
  'otel.protocol'
];

/** mcp/get 脱敏占位；mcp/save 时同值从现有文件回填，不会抹掉真实凭证。 */
const MCP_REDACTED = '***';

/** 「打开 mcp.json」文件缺失时写入的模板（无任何凭证）。 */
const MCP_TEMPLATE = `{
  "servers": {}
}
`;

/**
 * settings/hydrate 与 chat hydrate 共用的能力快照：发现层 listProviders
 * 注解（liveToolCount / catalogLiveToolCount / connectedTargets）再加上
 * 每条声明工具的 risk / live。缺字段的旧 webview 仍按 displayName/healthy 渲染。
 */
export function annotateCapabilities(hub: DiscoveryHub): unknown {
  const annotated = listProviders(hub);
  const liveByName = new Map(hub.listAllTools().map((t) => [t.name, t] as const));
  return {
    ...annotated,
    providers: annotated.providers.map((p) => ({
      ...p,
      toolCount: p.toolNames.length,
      tools: p.toolNames.map((name) => {
        const descriptor = liveByName.get(name);
        return {
          name,
          risk: resolveToolRisk(name, descriptor),
          live: descriptor !== undefined
        };
      })
    }))
  };
}

/** settings/hydrate 的载荷（设置页 webview 全量快照）。 */
export interface SettingsSnapshot {
  /** atOpsAgent.* 已知键的当前值。 */
  config: Record<string, unknown>;
  modelsPath: string;
  agentDir: string;
  /**
   * 发现层 listProviders 注解后的能力插件清单（含 liveToolCount /
   * catalogLiveToolCount / connectedTargets / 每工具 risk）。缺字段旧 UI 仍能渲染。
   */
  capabilities: unknown;
  /**
   * 恒为空：内置技能是 Agent 内部资源（OpsResourceLoader / ops_read_skill
   * 渐进披露给模型），不是用户可配置目录，不下发 webview。
   */
  skills: SkillInfo[];
  sessions: SessionSummary[];
  /** mcp.json 脱敏文本（env/header/bearer 值 → ***）。 */
  mcp: { path: string; exists: boolean; text: string; error?: string };
  pendingApprovals: number;
}

/**
 * Catalog 名差 vs 当前 Hub selection：removed ∩ selected → 断桥；
 * added ∩ 曾选 → 恢复。供 handleToolCatalogChange 与单测共用。
 */
export function diffCatalogSelectionNotices(input: {
  previousNames: ReadonlySet<string>;
  currentNames: readonly string[];
  selected: readonly string[];
  previouslySelected: ReadonlySet<string>;
}): {
  disconnected: string[];
  restored: string[];
  nextPreviouslySelected: Set<string>;
} {
  const currentSet = new Set(input.currentNames);
  const removed = [...input.previousNames].filter((name) => !currentSet.has(name));
  const added = input.currentNames.filter((name) => !input.previousNames.has(name));
  const selectedSet = new Set(input.selected);
  const nextPreviouslySelected = new Set(input.previouslySelected);
  const disconnected = removed.filter((name) => selectedSet.has(name));
  for (const name of disconnected) nextPreviouslySelected.add(name);
  const restored = added.filter((name) => nextPreviouslySelected.has(name));
  for (const name of restored) nextPreviouslySelected.delete(name);
  return { disconnected, restored, nextPreviouslySelected };
}

export class ConfigService {
  /** 技能清单缓存：refresh 命令 / 设置页刷新时失效重扫。 */
  private skillsCache: SkillInfo[] | undefined;
  /** 已知插件基线（plugins.autoEnableNew=false 时用于识别「新上线」插件）。 */
  private knownPluginIds: Set<string> | undefined;
  /** 上一拍 live catalog 工具名（断桥 notice 用；首拍只建基线）。 */
  private knownToolNames: Set<string> | undefined;
  /** 断桥时仍在 selected 里的工具名，恢复时对偶 notice。 */
  private previouslySelectedOffline = new Set<string>();

  constructor(private readonly ctx: HostContext) {}

  refreshSkills(): void {
    this.skillsCache = undefined;
  }

  safeProviders(): unknown {
    try {
      return annotateCapabilities(this.ctx.hub);
    } catch {
      return { hostApp: this.ctx.hub.hostApp, providers: [], catalogLiveToolCount: 0 };
    }
  }

  /**
   * 工具目录变化：plugins.autoEnableNew=false 时，新上线插件不自动纳入
   * 已选工具面（只记日志）；默认 true 保持现行为（hub 策略决定暴露）。
   * 首个事件（启动扫描）作为基线，不算「新插件」。
   * Plan 02 T5：removed ∩ 当前 selected → 断桥 notice；added ∩ 曾选 → 恢复。
   */
  handleToolCatalogChange(): void {
    const ctx = this.ctx;
    let tools: ReadonlyArray<{ name: string; pluginId: string }>;
    try {
      tools = ctx.hub.listAllTools();
    } catch {
      return;
    }
    const currentIds = new Set(tools.map((t) => t.pluginId));
    const currentNames = tools.map((t) => t.name);

    const knownPlugins = this.knownPluginIds;
    this.knownPluginIds = currentIds;
    if (knownPlugins) {
      this.applyAutoEnableNew(knownPlugins, currentIds);
    }

    const previousNames = this.knownToolNames;
    this.knownToolNames = new Set(currentNames);
    if (!previousNames) return;

    let selected: readonly string[] = [];
    try {
      selected = ctx.hub.selection.state().selected;
    } catch {
      return;
    }
    const { disconnected, restored, nextPreviouslySelected } = diffCatalogSelectionNotices({
      previousNames,
      currentNames,
      selected,
      previouslySelected: this.previouslySelectedOffline
    });
    this.previouslySelectedOffline = nextPreviouslySelected;
    if (disconnected.length > 0) {
      ctx.emitAssistantNotice(`能力插件桥断开，${disconnected.length} 个工具暂不可用`);
    }
    if (restored.length > 0) {
      ctx.emitAssistantNotice(`能力插件桥已恢复，${restored.length} 个工具重新可用`);
    }
  }

  /** autoEnableNew=false：新 pluginId 不并入已有选择（发现模式只记日志）。 */
  private applyAutoEnableNew(known: Set<string>, currentIds: Set<string>): void {
    const fresh = [...currentIds].filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    const ctx = this.ctx;
    const autoEnable = vscode.workspace
      .getConfiguration('atOpsAgent')
      .get<boolean>('plugins.autoEnableNew', true);
    if (autoEnable) return;
    ctx.log(
      `[hub] 新插件上线：${fresh.join(', ')}；plugins.autoEnableNew=false，不自动纳入已选工具面`
    );
    // 有显式选择且新插件工具混进了暴露面时剔除（保持原选择不变）；
    // 无显式选择（发现模式管理暴露面）只记通知，不强加选择。
    try {
      if (ctx.hub.selection.state().selected.length === 0) return;
      const freshSet = new Set(fresh);
      const exposed = ctx.hub.listExposedTools();
      const keep = exposed.filter((t) => !freshSet.has(t.pluginId)).map((t) => t.name);
      if (keep.length === exposed.length) return;
      void ctx.hub.selection
        .select({ names: keep, mode: 'replace' })
        .then(() =>
          ctx.log(`[hub] 已从当前选择剔除新插件工具 ${exposed.length - keep.length} 个`)
        )
        .catch((err) => ctx.log(`[hub] 剔除新插件工具失败: ${describeError(err)}`));
    } catch (err) {
      ctx.log(`[hub] autoEnableNew 处理失败: ${describeError(err)}`);
    }
  }

  // ── 设置页 ─────────────────────────────────────────────────────────────

  /** settings/hydrate：设置页全量快照（不含任何明文凭证；skills 恒为空）。 */
  async settingsSnapshot(): Promise<SettingsSnapshot> {
    const ctx = this.ctx;
    const config = vscode.workspace.getConfiguration('atOpsAgent');
    const configValues: Record<string, unknown> = {};
    for (const key of KNOWN_CONFIG_KEYS) configValues[key] = config.get(key);
    return {
      config: configValues,
      modelsPath: ctx.modelsPath,
      agentDir: ctx.agentDir,
      capabilities: this.safeProviders(),
      // 内置技能目录（listSkills）只服务 skill/open 路径校验与 ops 内部，不进 UI。
      skills: [],
      sessions: ctx.chat.sessionSummaries(),
      mcp: await this.readMcpRedacted(),
      pendingApprovals: ctx.store.pendingBriefs.length
    };
  }

  /** settings/open（chat webview 深链）：打开设置页并聚焦指定页签。 */
  async openSettingsPanel(tab: string | undefined): Promise<{ ok: boolean }> {
    try {
      await vscode.commands.executeCommand(
        tab === 'models' ? 'atOpsAgent.openModels' : 'atOpsAgent.openSettings'
      );
      return { ok: true };
    } catch (err) {
      this.ctx.log(`[settings] 打开设置页失败: ${describeError(err)}`);
      return { ok: false };
    }
  }

  async refreshCapabilities(): Promise<SettingsSnapshot> {
    try {
      await this.ctx.hub.refresh();
    } catch (err) {
      this.ctx.log(`[hub] refresh 失败: ${describeError(err)}`);
    }
    this.refreshSkills();
    return this.settingsSnapshot();
  }

  async runDiagnose(): Promise<{ ok: boolean }> {
    await diagnoseHub({
      hostApp: this.ctx.hub.hostApp,
      hub: this.ctx.hub,
      output: this.ctx.outputChannel
    });
    this.ctx.outputChannel.show(true);
    return { ok: true };
  }

  async openSkill(
    payload: { name?: string; path?: string } | undefined
  ): Promise<{ ok: boolean; error?: string }> {
    const ctx = this.ctx;
    const skills = this.skillsCache ?? (await listSkills(ctx.extensionPath));
    this.skillsCache = skills;
    const requestedPath = typeof payload?.path === 'string' ? payload.path : undefined;
    const requestedName = typeof payload?.name === 'string' ? payload.name : undefined;
    const hit = skills.find(
      (s) =>
        (requestedPath !== undefined && s.skillFile === requestedPath) ||
        (requestedName !== undefined && (s.label === requestedName || s.skillFile === requestedName))
    );
    if (!hit) {
      return { ok: false, error: '未找到该技能文件' };
    }
    const skillsRoot = path.join(ctx.extensionPath, 'skills');
    const resolved = path.resolve(hit.skillFile);
    if (!resolved.startsWith(path.resolve(skillsRoot))) {
      return { ok: false, error: '技能路径越界' };
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(doc, { preview: true });
    return { ok: true };
  }

  /** settings/patchConfig：只接受 atOpsAgent.* 已知键，写用户级配置。 */
  async patchConfig(req: SettingsPatchConfigReq): Promise<{ ok: boolean; error?: string }> {
    const key = typeof req?.key === 'string' ? req.key.replace(/^atOpsAgent\./, '') : '';
    if (!KNOWN_CONFIG_KEYS.includes(key)) {
      return { ok: false, error: `未知配置键 "${key}"（只允许 atOpsAgent.* 已知键）` };
    }
    let value = req.value;
    if (key === 'approval.sessionRequiredFor') {
      const floor = parseSessionRequiredFor(
        vscode.workspace.getConfiguration('atOpsAgent').get('policy.floor'),
        'write-exec'
      );
      const user = parseSessionRequiredFor(req.value, 'write-exec');
      const effective = effectiveSessionRequiredFor(floor, user);
      if (effective !== user) {
        value = effective;
        void vscode.window.showInformationMessage('已按组织下限收紧');
      }
    }
    try {
      await vscode.workspace
        .getConfiguration('atOpsAgent')
        .update(key, value, vscode.ConfigurationTarget.Global);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  // ── mcp.json ───────────────────────────────────────────────────────────

  private mcpPath(): string {
    return path.join(this.ctx.agentDir, 'mcp.json');
  }

  /** mcp/get：读 ~/.at-series/agent/mcp.json，env/header/bearer 值一律脱敏为 ***。 */
  async readMcpRedacted(): Promise<SettingsSnapshot['mcp']> {
    const filePath = this.mcpPath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        path: filePath,
        exists: false,
        text: MCP_TEMPLATE,
        ...(missing ? {} : { error: describeError(err) })
      };
    }
    try {
      const redacted = redactMcpConfig(JSON.parse(raw));
      return { path: filePath, exists: true, text: `${JSON.stringify(redacted, null, 2)}\n` };
    } catch {
      // 坏 JSON 无法可靠脱敏：绝不回传原文（可能含明文凭证）。
      return {
        path: filePath,
        exists: true,
        text: '',
        error: 'mcp.json 不是合法 JSON，无法脱敏预览；请用「打开 mcp.json」在编辑器修复。'
      };
    }
  }

  /**
   * mcp/save：写回 mcp.json（0600）。webview 提交的 *** 占位值从现有文件
   * 回填，真实凭证不经过 webview 往返；内容与凭证一律不落日志。
   * AT 系列 hub.js 项照存——运行时由 filterMcpServers 跳过，绝不 spawn。
   */
  async saveMcp(text: string | undefined): Promise<{ ok: boolean; error?: string }> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'mcp.json 内容不能为空。' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `不是合法 JSON：${describeError(err)}` };
    }
    if (!isPlainRecord(parsed)) return { ok: false, error: 'mcp.json 根节点必须是对象。' };
    let existing: unknown;
    try {
      existing = JSON.parse(await fs.readFile(this.mcpPath(), 'utf8'));
    } catch {
      existing = undefined;
    }
    const merged = restoreRedactedMcpValues(parsed, existing);
    try {
      await fs.mkdir(this.ctx.agentDir, { recursive: true });
      await fs.writeFile(this.mcpPath(), `${JSON.stringify(merged, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    this.ctx.log('[mcp] 已保存 mcp.json（内容不落日志）');
    return { ok: true };
  }

  /** settings/openJson：在编辑器打开配置文件；kind=vscode 走原生设置页。 */
  async openJson(
    kind: SettingsOpenJsonReq['kind'] | undefined
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (kind) {
        case 'models':
          await this.ctx.models.openModelsFile();
          return { ok: true };
        case 'auth':
          await this.ctx.models.openAuthFile();
          return { ok: true };
        case 'mcp': {
          await fs.mkdir(this.ctx.agentDir, { recursive: true });
          try {
            await fs.access(this.mcpPath());
          } catch {
            await fs.writeFile(this.mcpPath(), MCP_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
          }
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.mcpPath()));
          await vscode.window.showTextDocument(doc, { preview: false });
          return { ok: true };
        }
        case 'vscode':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'atOpsAgent');
          return { ok: true };
        default:
          return { ok: false, error: `未知 openJson kind "${String(kind)}"` };
      }
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }
}

/** mcp.json 脱敏：servers / mcpServers 两种映射的 env、headers 值与 bearerToken → ***。 */
function redactMcpConfig(root: unknown): unknown {
  if (!isPlainRecord(root)) return root;
  const out: Record<string, unknown> = { ...root };
  for (const mapKey of ['servers', 'mcpServers'] as const) {
    const map = out[mapKey];
    if (!isPlainRecord(map)) continue;
    out[mapKey] = Object.fromEntries(
      Object.entries(map).map(([name, entry]) => [name, redactMcpEntry(entry)])
    );
  }
  return out;
}

function redactMcpEntry(entry: unknown): unknown {
  if (!isPlainRecord(entry)) return entry;
  const out: Record<string, unknown> = { ...entry };
  for (const key of ['env', 'headers'] as const) {
    const rec = out[key];
    if (isPlainRecord(rec)) {
      out[key] = Object.fromEntries(Object.keys(rec).map((k) => [k, MCP_REDACTED]));
    }
  }
  if (typeof out.bearerToken === 'string' && out.bearerToken.length > 0) {
    out.bearerToken = MCP_REDACTED;
  }
  return out;
}

/** mcp/save：webview 传回的 *** 占位值按 server+键 从现有文件回填。 */
function restoreRedactedMcpValues(
  next: Record<string, unknown>,
  existing: unknown
): Record<string, unknown> {
  if (!isPlainRecord(existing)) return next;
  const out: Record<string, unknown> = { ...next };
  for (const mapKey of ['servers', 'mcpServers'] as const) {
    const nextMap = out[mapKey];
    const prevMap = existing[mapKey];
    if (!isPlainRecord(nextMap) || !isPlainRecord(prevMap)) continue;
    out[mapKey] = Object.fromEntries(
      Object.entries(nextMap).map(([name, entry]) => [
        name,
        restoreRedactedEntry(entry, prevMap[name])
      ])
    );
  }
  return out;
}

function restoreRedactedEntry(entry: unknown, prev: unknown): unknown {
  if (!isPlainRecord(entry)) return entry;
  const prevRec = isPlainRecord(prev) ? prev : undefined;
  const out: Record<string, unknown> = { ...entry };
  for (const key of ['env', 'headers'] as const) {
    const rec = out[key];
    if (!isPlainRecord(rec)) continue;
    const prevValues = prevRec && isPlainRecord(prevRec[key]) ? prevRec[key] : undefined;
    out[key] = Object.fromEntries(
      Object.entries(rec).map(([k, v]) => [
        k,
        v === MCP_REDACTED && typeof prevValues?.[k] === 'string' ? prevValues[k] : v
      ])
    );
  }
  if (out.bearerToken === MCP_REDACTED && typeof prevRec?.bearerToken === 'string') {
    out.bearerToken = prevRec.bearerToken;
  }
  return out;
}
