/**
 * Host 服务层共享上下文（P2-1 拆分 HostController 的基座）：
 * - 共享依赖（hub / store / secrets / OpsCore / 路径 / Output）；
 * - UI / 看板 / 状态位三条事件流（原 HostController 的 Emitter 收拢到此）；
 * - 服务互访：各服务经 ctx.chat / ctx.approvals / … 调用兄弟服务，
 *   由 HostController 构造后一次性 wire()，此后只读。
 *
 * 多会话广播纪律（P2 sessions.maxParallel ≤ 2）：来自后台会话 runtime /
 * orchestrator 的事件必须走 broadcastToSession(sessionId, …)——只有事件
 * 所属会话是当前活动会话时才推给 chat webview；后台会话的内容写进
 * SessionStore 对应会话的内存包，切回时经 hydrate 全量恢复。
 */
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { Emitter, envelope, type Envelope, type Event, type HubHost } from '../../protocol';
import { createOpsCore, type OpsCore } from '../../core';
import type { OpsSecrets } from '../secrets';
import type { SessionStore } from '../sessionStore';
import type { ApprovalService } from './approvalService';
import type { ChatService } from './chatService';
import type { ConfigService } from './configService';
import type { ModelService } from './modelService';
import type { PlaybookService } from './playbookService';
import type { WorkbenchService } from './workbenchService';

export interface HostContextOptions {
  hub: HubHost;
  store: SessionStore;
  secrets: OpsSecrets;
  output: vscode.OutputChannel;
  extensionPath: string;
}

/** 服务集合（HostController 构造后 wire 一次；类型互引均为 type-only）。 */
export interface HostServices {
  chat: ChatService;
  approvals: ApprovalService;
  playbooks: PlaybookService;
  models: ModelService;
  config: ConfigService;
  workbench: WorkbenchService;
}

export class HostContext {
  readonly hub: HubHost;
  readonly store: SessionStore;
  readonly secrets: OpsSecrets;
  readonly core: OpsCore = createOpsCore();
  readonly extensionPath: string;
  readonly agentDir: string;
  readonly modelsPath: string;
  readonly playbooksDir: string;

  private readonly output: vscode.OutputChannel;

  private readonly uiEmitter = new Emitter<Envelope>();
  /** 面向 Chat webview 的事件流（由 ChatViewProvider 合批转发）。 */
  readonly onUiEvent: Event<Envelope> = this.uiEmitter.event;

  private readonly boardEmitter = new Emitter<Envelope>();
  /** 面向 Ops 看板的事件流（timeline/upsert）。 */
  readonly onBoardEvent: Event<Envelope> = this.boardEmitter.event;

  private readonly statusEmitter = new Emitter<void>();
  /** 状态位变化（hasApiKey 等）；activate 的状态栏订阅。 */
  readonly onDidChangeStatus: Event<void> = this.statusEmitter.event;

  private services: HostServices | undefined;

  constructor(options: HostContextOptions) {
    this.hub = options.hub;
    this.store = options.store;
    this.secrets = options.secrets;
    this.output = options.output;
    this.extensionPath = options.extensionPath;
    this.agentDir = path.join(os.homedir(), '.at-series', 'agent');
    this.modelsPath = path.join(this.agentDir, 'models.json');
    this.playbooksDir = path.join(this.extensionPath, 'skills', 'playbooks');
  }

  /** HostController 构造完全部服务后调用一次。 */
  wire(services: HostServices): void {
    this.services = services;
  }

  private require(): HostServices {
    if (!this.services) throw new Error('HostContext 尚未 wire 服务集合');
    return this.services;
  }

  get chat(): ChatService {
    return this.require().chat;
  }
  get approvals(): ApprovalService {
    return this.require().approvals;
  }
  get playbooks(): PlaybookService {
    return this.require().playbooks;
  }
  get models(): ModelService {
    return this.require().models;
  }
  get config(): ConfigService {
    return this.require().config;
  }
  get workbench(): WorkbenchService {
    return this.require().workbench;
  }

  log(message: string): void {
    this.output.appendLine(message);
  }

  get outputChannel(): vscode.OutputChannel {
    return this.output;
  }

  /** 广播事件到 chat webview（playbook/subagent 类同步镜像到看板）。 */
  broadcast(type: string, payload: unknown): void {
    const env = envelope('evt', type, payload, randomUUID());
    this.uiEmitter.fire(env);
    if (type === 'playbook/stage' || type === 'subagent/upsert') {
      this.boardEmitter.fire(env);
    }
  }

  /**
   * 会话定向广播：只有 sessionId 是当前活动会话时才推给 webview。
   * 后台会话（sessions.maxParallel=2 的另一席）的内容已写进 store 的
   * 会话包，切回时 hydrate 恢复，不在此实时上屏。
   */
  broadcastToSession(sessionId: string, type: string, payload: unknown): void {
    if (sessionId === this.store.activeSessionId) this.broadcast(type, payload);
  }

  fireBoardEvent(env: Envelope): void {
    this.boardEmitter.fire(env);
  }

  fireStatusChanged(): void {
    this.statusEmitter.fire();
  }

  /** 以 assistant 身份追加一条提示（写目标会话；活动会话才实时上屏）。 */
  emitAssistantNotice(text: string, sessionId?: string): void {
    const sid = sessionId ?? this.store.activeSessionId;
    const item = { kind: 'assistant' as const, id: randomUUID(), text };
    this.store.appendItem(item, sid);
    this.broadcastToSession(sid, 'transcript/append', { item });
  }

  disposeEmitters(): void {
    this.uiEmitter.dispose();
    this.boardEmitter.dispose();
    this.statusEmitter.dispose();
  }
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
