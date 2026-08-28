/**
 * ~/.at-series/agent/settings.json 读写（thinkingLevel 等非敏感偏好）。
 *
 * 与 models.json 分离：settings.json 不含任何凭证，读写都保留未知字段，
 * 供 runtime / Models 面板共同消费。文件缺失或坏 JSON 一律按空配置处理。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ThinkingLevel } from './hostTypes';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
];

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

export function agentSettingsPath(agentDir: string): string {
  return path.join(agentDir, 'settings.json');
}

export async function readAgentSettings(agentDir: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(agentSettingsPath(agentDir), 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 合并写回（保留未知字段）；目录缺失时创建。 */
export async function patchAgentSettings(
  agentDir: string,
  patch: Record<string, unknown>
): Promise<void> {
  const current = await readAgentSettings(agentDir);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    agentSettingsPath(agentDir),
    `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
    'utf8'
  );
}
