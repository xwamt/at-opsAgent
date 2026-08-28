/**
 * bundle-smoke harness：由测试用与扩展主产物**同一套** esbuild 配置
 * （bundle + cjs + external:vscode + import.meta.url shim）打成单文件 CJS，
 * 再 spawn 执行。它模拟 VSIX 里 host 创建 runtime 的路径：
 * createOpsRuntime → pi ModelRuntime → openai-completions 流式。
 *
 * 若 esbuild.extension.mjs 缺失 importMetaUrlShim：pi 的 dist/config.js 在
 * 模块顶层执行 fileURLToPath(import.meta.url)，CJS 产物里 import.meta 是空
 * 对象，加载期即抛错 → createOpsRuntime 回落 FallbackRuntime → 不发任何
 * HTTP 请求、text_delta 只有兜底文案 → bundle-smoke 测试变红。
 *
 * 输入（环境变量，由测试注入）：
 * - BUNDLE_SMOKE_AGENT_DIR：pi agentDir（内含指向 mock 服务的 models.json）
 * - BUNDLE_SMOKE_CWD：会话 cwd（临时目录）
 * - BUNDLE_SMOKE_API_KEY：getApiKey 返回的 key（模拟 SecretStorage 注入）
 *
 * 输出（stdout 每行一条）：
 * - `BUNDLE_SMOKE_EVENT <json>`：每个 OpsRuntimeEvent
 * - `BUNDLE_SMOKE_DONE`：prompt 完成
 */
import { join } from 'node:path';
import { createOpsRuntime, type OpsRuntimeHandlers } from '../../src/runtime/index';
// 注意：本文件顶层会直接执行 main()，测试绝不能 import 它——共享常量放在
// mock-openai-sse.ts。
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from './mock-openai-sse';

const hub: OpsRuntimeHandlers['hub'] = {
  listAllTools: () => [],
  listExposedTools: () => [],
  getProviders: () => ({ hostApp: 'bundle-smoke', providers: [] }),
  invoke: async () => ({ ok: true, result: {}, attemptCount: 1, durationMs: 0 }),
  selection: {
    state: () => ({
      mode: 'off',
      threshold: 20,
      selected: [],
      exposedBusinessToolCount: 0,
      idleMs: 0,
      maxCalls: 0
    }),
    select: async () => ({ selected: [], exposed: [] }),
    clear: async () => {},
    onDidChange: () => ({ dispose() {} })
  }
};

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const agentDir = process.env.BUNDLE_SMOKE_AGENT_DIR;
  const cwd = process.env.BUNDLE_SMOKE_CWD;
  const apiKey = process.env.BUNDLE_SMOKE_API_KEY;
  if (agentDir === undefined || cwd === undefined || apiKey === undefined) {
    throw new Error('缺少 BUNDLE_SMOKE_AGENT_DIR / BUNDLE_SMOKE_CWD / BUNDLE_SMOKE_API_KEY');
  }

  const runtime = await createOpsRuntime(
    {
      hub,
      onEvent: (e) => emit(`BUNDLE_SMOKE_EVENT ${JSON.stringify(e)}`)
    },
    {
      agentDir,
      cwd,
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
      getApiKey: async () => apiKey,
      thinkingLevel: 'off',
      bundledSkillsDir: join(cwd, 'skills')
    }
  );

  await runtime.prompt('你好');
  await runtime.dispose();
  // 显式 flush 后退出：pi 会话可能残留计时器等句柄，不 exit 进程不会自然结束。
  await new Promise<void>((resolve) => {
    process.stdout.write('BUNDLE_SMOKE_DONE\n', () => resolve());
  });
  process.exit(0);
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`BUNDLE_SMOKE_ERROR ${detail}\n`);
  process.exit(1);
});
