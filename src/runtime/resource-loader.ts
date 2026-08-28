/**
 * OpsResourceLoader（docs/03 §1）：让两个 skills 根目录
 *   1. 打包 skills（options.bundledSkillsDir，host 侧传 extensionPath/skills）
 *   2. 用户 skills（join(agentDir, 'skills')，默认 ~/.at-series/agent/skills）
 * 作为 pi skill 资源可被发现，同时保持 noExtensions: true——绝不启用
 * pi 项目扩展（DefaultResourceLoader 的 noSkills=true 分支仍会加载
 * additionalSkillPaths，正好只发现我们的两个根，不扫用户项目目录）。
 *
 * pi 是 ESM-only 包而扩展打成 CJS，无法在模块顶层 extends 其 class，
 * 因此用工厂 createOpsResourceLoader(pi, options) 包装 DefaultResourceLoader。
 *
 * 模型侧读取走 ops_read_skill 自定义工具（仅主会话注册；子会话没有）：
 * - 参数 { path }：相对 skills 根的路径；
 * - 白名单 = 解析结果必须落在某个 skills 根之下；拒绝 ..、绝对路径、反斜杠；
 * - utf8 读取，单文件上限 64KB（超出截断并提示）。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

export const READ_SKILL_TOOL_NAME = 'ops_read_skill';

/** ops_read_skill / ops_read_workspace_file 单文件字符上限（64KB）。 */
export const SKILL_FILE_CHAR_LIMIT = 64 * 1024;

/** 打包 skills 默认根：join(cwd, 'skills')（host 未传 bundledSkillsDir 时）。 */
export function defaultBundledSkillsDir(cwd: string = process.cwd()): string {
  return join(cwd, 'skills');
}

/** 两个 skills 根：打包 skills 优先，其次用户 skills（agentDir/skills）。 */
export function skillRootsFor(options: { bundledSkillsDir: string; agentDir: string }): string[] {
  return [options.bundledSkillsDir, join(options.agentDir, 'skills')];
}

/**
 * skill 路径别名：模型常按 playbook id 短名猜目录（playbooks/inspection/…），
 * 真实目录名不同（daily-inspection/…）。lookup 前按前缀重写；键含结尾斜杠。
 */
export const SKILL_PATH_ALIASES: Readonly<Record<string, string>> = {
  'playbooks/inspection/': 'playbooks/daily-inspection/',
  'playbooks/incident/': 'playbooks/incident-response/',
  'playbooks/db/': 'playbooks/db-slow-and-capacity/',
  'playbooks/release/': 'playbooks/release-rollback/',
  'playbooks/host/': 'playbooks/host-emergency/'
};

/**
 * 应用 SKILL_PATH_ALIASES：前缀命中（如 playbooks/inspection/SKILL.md）或
 * 恰为别名目录本身（playbooks/inspection）时重写到真实目录，否则原样返回。
 */
export function applySkillPathAliases(relPath: string): string {
  const trimmed = relPath.trim();
  for (const [alias, target] of Object.entries(SKILL_PATH_ALIASES)) {
    if (trimmed.startsWith(alias)) return target + trimmed.slice(alias.length);
    if (trimmed === alias.slice(0, -1)) return target.slice(0, -1);
  }
  return relPath;
}

function isSafeRelativePath(relPath: string): boolean {
  if (typeof relPath !== 'string') return false;
  const trimmed = relPath.trim();
  if (trimmed.length === 0) return false;
  // 反斜杠与 NUL 一律拒绝（skills 内不需要，且会造成跨平台歧义）。
  if (trimmed.includes('\0') || trimmed.includes('\\')) return false;
  if (isAbsolute(trimmed)) return false;
  return !trimmed.split('/').some((segment) => segment === '..');
}

/**
 * 把相对路径解析到 root 之下：任何 .. 段、绝对路径、反斜杠、空串都返回
 * undefined（保守拒绝，即使 a/../b 结果仍在根内）。返回绝对路径。
 */
export function resolveUnderRoot(root: string, relPath: string): string | undefined {
  if (!isSafeRelativePath(relPath)) return undefined;
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, relPath.trim());
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return undefined;
  return abs;
}

export type ReadSkillResult =
  | { ok: true; root: string; path: string; content: string; truncated: boolean; notice?: string }
  | { ok: false; error: string };

/**
 * 按根顺序读取第一个存在的文件；utf8；超过 limit 截断并附中文提示。
 * lookup 前先应用 SKILL_PATH_ALIASES（playbook id 短名 → 真实目录）。
 */
export async function readSkillFile(
  roots: readonly string[],
  relPath: string,
  limit = SKILL_FILE_CHAR_LIMIT
): Promise<ReadSkillResult> {
  const aliased = applySkillPathAliases(relPath);
  const candidates = roots
    .map((root) => ({ root, abs: resolveUnderRoot(root, aliased) }))
    .filter((c): c is { root: string; abs: string } => c.abs !== undefined);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `路径 "${relPath}" 不合法：只允许 skills 根目录内的相对路径（禁止 ..、绝对路径与反斜杠）。`
    };
  }
  for (const { root, abs } of candidates) {
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue; // 该根下不存在（或不可读/是目录），尝试下一个根。
    }
    const truncated = content.length > limit;
    return {
      ok: true,
      root,
      path: abs,
      content: truncated ? content.slice(0, limit) : content,
      truncated,
      ...(truncated
        ? { notice: `文件共 ${content.length} 字符，超过 ${limit} 上限已截断；请改读更小的分节文件。` }
        : {})
    };
  }
  return { ok: false, error: `未找到 "${aliased}"（在 ${roots.join('、')} 下均不存在）。` };
}

/** 自定义工具 spec 的最小面（src/runtime/index.ts 的 toPiTool 可直接消费）。 */
export interface OpsCustomToolSpec {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /**
   * 声明式风险级别（policy 闸门用；缺省由 host 决定，ops_* 元工具通常按
   * read 处理）。外部 MCP 代理工具见 mcp-client 的 RISK_BY_PROXY_TOOL。
   */
  readonly risk?: 'read' | 'write' | 'exec';
  execute(args: Record<string, unknown>): Promise<string>;
}

/** ops_read_skill 工具（仅主会话注册；roots 之外的一切路径被拒绝）。 */
export function createReadSkillTool(roots: readonly string[]): OpsCustomToolSpec {
  return {
    name: READ_SKILL_TOOL_NAME,
    label: 'Ops：读取 skill 文件',
    description:
      '按相对路径读取 skills 根目录下的文件（打包 skills 与 ~/.at-series/agent/skills，' +
      `utf8，单文件上限 ${SKILL_FILE_CHAR_LIMIT} 字符）。` +
      '用法：命中 playbook/vendor 后再读对应 SKILL.md / references，不要把全文塞进 system prompt，按需分文件读取。' +
      '示例 path：playbooks/incident-response/SKILL.md、ops-agent-core/references/approval-brief.md。' +
      'playbook id 短名会自动映射到真实目录（如 playbooks/inspection/ → playbooks/daily-inspection/）。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对 skills 根的路径（禁止 .. 与绝对路径），如 playbooks/incident-response/SKILL.md'
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async (args) => JSON.stringify(await readSkillFile(roots, String(args.path ?? '')))
  };
}

export interface CreateOpsResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  /** 打包 skills 根（host 传 extensionPath/skills；默认 defaultBundledSkillsDir(cwd)）。 */
  bundledSkillsDir: string;
  settingsManager: SettingsManager;
  /** 常驻系统提示词（L0+L1+L2+L3(+L4)）；调用方持有可变引用。 */
  systemPromptOverride: () => string;
}

/**
 * 包装 DefaultResourceLoader：skills 只从两个白名单根发现（additionalSkillPaths），
 * 其余资源面保持关闭（noExtensions/noPromptTemplates/noThemes/noContextFiles）。
 * 调用方负责 await loader.reload()。
 */
export function createOpsResourceLoader(
  pi: PiModule,
  options: CreateOpsResourceLoaderOptions
): DefaultResourceLoader {
  return new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    // 绝不启用 pi 项目扩展/皮肤/模板/上下文文件（最小资源面）。
    noExtensions: true,
    // noSkills=true 时 DefaultResourceLoader 仍加载 additionalSkillPaths：
    // 即只发现我们两个 skills 根，不扫 cwd/agentDir 的默认 skills 目录。
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: skillRootsFor(options),
    systemPromptOverride: options.systemPromptOverride
  });
}
