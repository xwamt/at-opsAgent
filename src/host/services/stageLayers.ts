/**
 * L4 阶段层注入器（PlaybookService 拆件）：
 * 阶段迁移时整体替换 L4，经 core.buildSystemPrompt 与 L0–L2 合成后
 * setSystemPrompt——host 绝不用裸 L4 覆盖红线层。按会话席位独立注入，
 * 每席带 seq 竞态防护（只应用最后一次请求的层）。
 */
import type { PlaybookMeta, RuntimeLike } from '../hostTypes';
import { PlaybookLayerSource } from '../playbookLayer';
import { describeError, type HostContext } from './context';

interface LayerState {
  seq: number;
  lastKey?: string;
  lastRuntime?: RuntimeLike;
}

export class StageLayerInjector {
  private readonly states = new Map<string, LayerState>();
  private readonly source: PlaybookLayerSource;

  constructor(
    private readonly ctx: HostContext,
    private readonly getPlaybooks: () => Promise<PlaybookMeta[]>
  ) {
    this.source = new PlaybookLayerSource(ctx.playbooksDir);
  }

  clearSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  async inject(sessionId: string, playbookId: string, stage: string): Promise<void> {
    const ctx = this.ctx;
    const runtime = ctx.chat.runtimeFor(sessionId);
    if (!runtime?.setSystemPrompt) return;
    let state = this.states.get(sessionId);
    if (!state) {
      state = { seq: 0 };
      this.states.set(sessionId, state);
    }
    const key = `${playbookId}:${stage}`;
    if (state.lastKey === key && state.lastRuntime === runtime) return;
    const seq = ++state.seq;
    try {
      const meta = (await this.getPlaybooks()).find((p) => p.id === playbookId);
      const layer = await this.source.stageLayer(meta, playbookId, stage);
      if (seq !== state.seq || ctx.chat.runtimeFor(sessionId) !== runtime) return; // 已有更新的注入
      runtime.setSystemPrompt(ctx.core.buildSystemPrompt({ playbookLayer: layer }));
      state.lastKey = key;
      state.lastRuntime = runtime;
      ctx.log(`[runtime] 已注入 L4（${playbookId}/${stage}）`);
    } catch (err) {
      ctx.log(`[runtime] L4 注入失败: ${describeError(err)}`);
    }
  }
}
