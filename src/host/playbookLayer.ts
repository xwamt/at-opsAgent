/**
 * L4（playbook 阶段注入层）文本装配。
 *
 * 阶段迁移时整体替换 L4（docs/04 §5）：stage.prompt 指向的 markdown
 * （相对 skills/playbooks/<dir>/）读得到就用文件内容，读不到退化为一条
 * 简短中文兜底——绝不因资源缺失打断对话链路。
 * 与 L0–L2 的合成交给 runtime 模块的 buildSystemPrompt（host 不覆盖红线层）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { PlaybookMeta } from './hostTypes';

export class PlaybookLayerSource {
  /** playbookId → 所在目录（目录名 ≠ id，如 incident-response/ 对应 pb.incident）。 */
  private dirsPromise: Promise<Map<string, string>> | undefined;

  constructor(private readonly playbooksDir: string) {}

  /**
   * 返回该阶段的 L4 文本。meta 来自 loadPlaybooks（真模块或兜底解析），
   * 其 stages[].prompt 是相对 playbook 目录的文件路径。
   */
  async stageLayer(
    meta: PlaybookMeta | undefined,
    playbookId: string,
    stage: string
  ): Promise<string> {
    const promptRel = meta?.stages?.find((s) => s.id === stage)?.prompt;
    if (promptRel) {
      const content = await this.readStagePrompt(playbookId, promptRel);
      if (content) {
        return `${this.wrapLayer(playbookId, stage, content)}${this.agentChoiceFooter(meta, stage)}`;
      }
    }
    return (
      this.wrapLayer(
        playbookId,
        stage,
        `当前 playbook ${playbookId}，阶段 ${stage}。` +
          `调查中禁止 ops_clear_tool_selection；选择已由编排器代发，直接用一等工具名。`
      ) + this.agentChoiceFooter(meta, stage)
    );
  }

  private wrapLayer(playbookId: string, stage: string, body: string): string {
    return `# L4 Playbook 阶段注入（${playbookId} / ${stage}）\n${body}`;
  }

  /** host 不再自动 spawn；把 yaml parallelGroup 写成主代理可选用的候选。 */
  private agentChoiceFooter(meta: PlaybookMeta | undefined, stage: string): string {
    const group = meta?.stages?.find((s) => s.id === stage)?.parallelGroup ?? [];
    const lines = [
      '',
      '## 子代理（由你决定，host 不会自动下发）',
      '是否调用 ops_dispatch_subagent 由你判断。',
      '单证据面或单台机器禁止派发——由主会话直接调用一等工具完成。',
      '仅当存在多个独立目标（多主机、多插件面）时才考虑候选。',
      'yaml parallelGroup 只是候选，不是必须执行的清单。'
    ];
    if (group.length > 0) {
      lines.push('本阶段候选（仅多个独立目标时考虑）：');
      for (const task of group) {
        const goal = task.goal ? ` — ${task.goal}` : '';
        lines.push(`- ${task.role} \`${task.id}\`${goal}`);
      }
    }
    return `\n\n${lines.join('\n')}`;
  }

  private async readStagePrompt(playbookId: string, promptRel: string): Promise<string | undefined> {
    const dir = (await this.dirs()).get(playbookId);
    if (!dir) return undefined;
    const file = path.resolve(dir, promptRel);
    // prompt 路径来自打包 yaml，但仍拒绝越出 playbook 目录。
    if (!file.startsWith(path.resolve(dir) + path.sep)) return undefined;
    try {
      const content = (await fs.readFile(file, 'utf8')).trim();
      return content.length > 0 ? content : undefined;
    } catch {
      return undefined;
    }
  }

  private dirs(): Promise<Map<string, string>> {
    if (!this.dirsPromise) {
      this.dirsPromise = this.scanDirs();
    }
    return this.dirsPromise;
  }

  private async scanDirs(): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    let entries: string[];
    try {
      entries = await fs.readdir(this.playbooksDir);
    } catch {
      return byId;
    }
    for (const entry of entries) {
      const dir = path.join(this.playbooksDir, entry);
      try {
        const raw: unknown = parseYaml(await fs.readFile(path.join(dir, 'playbook.yaml'), 'utf8'));
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id === 'string') byId.set(id, dir);
      } catch {
        continue;
      }
    }
    return byId;
  }
}
