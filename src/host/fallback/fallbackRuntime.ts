/**
 * 最小 runtime 兜底：src/runtime（pi SDK 会话）模块整体缺失时，
 * 聊天不至于黑洞——回一条固定说明并回到 idle。
 * （模块存在但模型未配置时，真 runtime 自带 createFallbackRuntime，不走这里。）
 */
import { randomUUID } from 'node:crypto';
import type { RuntimeEventLike, RuntimeLike } from '../hostTypes';

const NOT_READY_MESSAGE =
  '模型运行时（src/runtime）尚未就绪，暂时无法对话。\n\n' +
  '当前可用：Capabilities 树查看已安装的 AT 系列能力插件；' +
  '命令「AT Ops Agent: Diagnose Hub」查看 Bridge 注册详情；' +
  '命令「AT Ops Agent: Open Models」准备模型配置。';

export class FallbackRuntime implements RuntimeLike {
  constructor(private readonly onEvent: (e: RuntimeEventLike) => void) {}

  async prompt(_text: string): Promise<void> {
    this.onEvent({ type: 'text_delta', id: randomUUID(), text: NOT_READY_MESSAGE });
    this.onEvent({ type: 'idle' });
  }

  abort(): void {
    // 无 in-flight 工作可取消。
  }

  abortSubagent(): void {
    // 无子代理在跑。
  }

  setSystemPrompt(): void {
    // 无真会话；模块就绪后重建 runtime 时 L4 再生效。
  }

  dispose(): void {
    // 无资源可释放。
  }
}
