/**
 * 系统提示词现场注入器（PlaybookService 拆件 + docs/13 §4.2 L-env）：
 * - inject()：阶段迁移时整体替换 L4，同时叠上 L-env——L4 注入绝不擦掉现场层；
 * - syncLivePrompt()：每条用户 prompt 前由 ChatService 调用，用 hub 实时快照
 *   合成 L-env；若该会话有进行中的 playbook 再叠当前阶段 L4。
 * - applyLayers()：可选 memLayer（compaction 后的 L-mem digest），叠在
 *   L-env 之后、L4 之前；未传时沿用本席上次 mem。
 * 三者都经 core.buildSystemPrompt 与 L0–L3 合成后 setSystemPrompt——host
 * 绝不用裸层覆盖红线层。按会话席位独立注入，每席带 seq 竞态防护
 * （只应用最后一次请求的层）；内容未变（playbook 键 + L-env + mem 文本相同）
 * 时跳过重复 setSystemPrompt。
 */
import { formatEnvSnapshot } from '../../prompts/env-snapshot';
import { listProviders } from '../../runtime/discovery-tools';
import type { PlaybookMeta, RuntimeLike } from '../hostTypes';
import { PlaybookLayerSource } from '../playbookLayer';
import { describeError, type HostContext } from './context';

interface LayerState {
  seq: number;
  lastKey?: string;
  lastRuntime?: RuntimeLike;
  /** compaction / 交接回灌的 L-mem；sync/inject 未传 memLayer 时沿用。 */
  lastMemLayer?: string;
}

/**
 * hub 现场 → L-env 层文本（纯读，不触发 refresh；refresh 由 ChatService
 * 在派发前完成）。liveToolCount 按「声明名 ∩ live catalog」口径，
 * 与发现层 listProviders 包装一致。
 */
export function buildEnvLayer(ctx: HostContext): string {
  const annotated = listProviders(ctx.hub);
  return formatEnvSnapshot({
    hostApp: annotated.hostApp,
    catalogLiveToolCount: annotated.catalogLiveToolCount ?? ctx.hub.listAllTools().length,
    exposed: ctx.hub.listExposedTools().map((t) => t.name),
    ...(annotated.hint !== undefined ? { hint: annotated.hint } : {}),
    providers: annotated.providers.map((p) => ({
      pluginId: p.pluginId,
      displayName: p.displayName,
      healthy: p.healthy,
      bridgeCount: p.bridgeCount,
      ...(p.connectedTargets !== undefined ? { connectedTargets: p.connectedTargets } : {}),
      toolNames: [...p.toolNames],
      liveToolCount: p.liveToolCount ?? 0
    }))
  });
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

  /** L4 阶段注入（阶段迁移触发）：同时带上 L-env，不擦现场。 */
  async inject(sessionId: string, playbookId: string, stage: string): Promise<void> {
    await this.applyLayers(sessionId, { playbookId, stage });
  }

  /**
   * 每条用户 prompt 前的现场同步（docs/13 §4.2 第 2 步）：
   * L-env 恒有；该会话有进行中的 playbook 时再叠当前阶段 L4。
   * 失败只记日志，绝不阻塞 prompt 派发。
   */
  async syncLivePrompt(sessionId: string): Promise<void> {
    const run = this.ctx.playbooks.runOf(sessionId);
    if (!run) {
      await this.applyLayers(sessionId);
      return;
    }
    const playbookId = this.ctx.store.playbookOf(sessionId)?.id ?? run.playbookId;
    const stage = this.ctx.playbooks.currentStage(run, sessionId);
    await this.applyLayers(sessionId, { playbookId, stage });
  }

  /**
   * 合成并注入 L-env（+ 可选 L-mem + 可选 L4）。
   * memLayer 写入本席状态后，后续 inject/syncLivePrompt 未再传入时仍保留。
   * runtime 尚未就绪时也先记下 mem，等第一次 sync 再生效。
   */
  async applyLayers(
    sessionId: string,
    opts?: { playbookId?: string; stage?: string; memLayer?: string }
  ): Promise<void> {
    const ctx = this.ctx;
    let state = this.states.get(sessionId);
    if (!state) {
      state = { seq: 0 };
      this.states.set(sessionId, state);
    }
    if (opts?.memLayer !== undefined) {
      const trimmed = opts.memLayer.trim();
      state.lastMemLayer = trimmed.length > 0 ? trimmed : undefined;
    }
    const memLayer = state.lastMemLayer;
    const playbook =
      typeof opts?.playbookId === 'string' &&
      opts.playbookId.length > 0 &&
      typeof opts.stage === 'string'
        ? { playbookId: opts.playbookId, stage: opts.stage }
        : undefined;

    const runtime = ctx.chat.runtimeFor(sessionId);
    if (!runtime?.setSystemPrompt) return;
    const seq = ++state.seq;
    try {
      let envLayer: string | undefined;
      try {
        envLayer = buildEnvLayer(ctx);
      } catch (err) {
        // L-env 合成失败降级为无现场层（仍注入 L4 / L-mem），不阻塞对话。
        ctx.log(`[runtime] L-env 合成失败: ${describeError(err)}`);
      }
      let playbookLayer: string | undefined;
      if (playbook) {
        const meta = (await this.getPlaybooks()).find((p) => p.id === playbook.playbookId);
        playbookLayer = await this.source.stageLayer(meta, playbook.playbookId, playbook.stage);
      }
      if (seq !== state.seq || ctx.chat.runtimeFor(sessionId) !== runtime) return; // 已有更新的注入
      const playbookKey = playbook ? `${playbook.playbookId}:${playbook.stage}` : '';
      const key = `${playbookKey}\u0000${envLayer ?? ''}\u0000${memLayer ?? ''}`;
      if (state.lastKey === key && state.lastRuntime === runtime) return; // 内容未变
      runtime.setSystemPrompt(
        ctx.core.buildSystemPrompt({
          ...(playbookLayer !== undefined ? { playbookLayer } : {}),
          ...(envLayer !== undefined ? { envLayer } : {}),
          ...(memLayer !== undefined ? { memLayer } : {})
        })
      );
      state.lastKey = key;
      state.lastRuntime = runtime;
      const bits = ['L-env'];
      if (memLayer) bits.push('L-mem');
      if (playbook) bits.push(`L4（${playbook.playbookId}/${playbook.stage}）`);
      ctx.log(`[runtime] 已注入 ${bits.join(' + ')}`);
    } catch (err) {
      ctx.log(`[runtime] 系统提示词层注入失败: ${describeError(err)}`);
    }
  }
}
