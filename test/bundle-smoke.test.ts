/**
 * P0-A bundle smoke（docs/11-redesign-recommendations.md）：验证「用扩展主产物
 * 同一套 esbuild 配置打出的 CJS 单文件」里 pi runtime 真的活着——能对
 * OpenAI-compatible 端点发起流式请求，且 Authorization 是 host 经 getApiKey
 * 注入的 key（而非 models.json 占位符）。
 *
 * 关键回归点：esbuild.extension.mjs 导出的 importMetaUrlShim（define + banner）。
 * pi 的 dist/config.js 在模块顶层执行 fileURLToPath(import.meta.url)；esbuild
 * 的 cjs 输出会把 import.meta 置成空对象，**没有 shim 时**该调用在 require 期
 * 抛 ERR_INVALID_ARG_TYPE → createOpsRuntime 回落 FallbackRuntime → mock 收不到
 * 任何请求、text_delta 只有兜底文案 → 本测试必须红。
 *
 * 单独跑：npx vitest run test/bundle-smoke.test.ts
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build, type BuildOptions } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MOCK_COMPLETION_CHUNKS,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockOpenAiSse,
  type MockOpenAiServer
} from './helpers/mock-openai-sse';

/** 模拟 SecretStorage 注入的 key；mock 服务必须收到 `Bearer ${此值}`。 */
const INJECTED_API_KEY = 'sk-test-bundle';

// 打整棵依赖树（含 pi）成单文件约需十几秒，放宽超时（仅限本文件）。
const BUILD_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 60_000;

interface SharedEsbuildConfig {
  importMetaUrlShim: { define: Record<string, string>; banner: { js: string } };
  sharedBundleOptions: Record<string, unknown>;
}

/**
 * 从 esbuild.extension.mjs 取共享打包配置——保证测试与产物用的是**同一份**
 * define/banner/format/external，而不是各自复制一份然后悄悄漂移。
 * （specifier 用变量 + file URL，绕开 tsc 对 .mjs 模块的解析限制。）
 */
async function loadSharedEsbuildConfig(): Promise<SharedEsbuildConfig> {
  const specifier = pathToFileURL(join(__dirname, '..', 'esbuild.extension.mjs')).href;
  return (await import(specifier)) as SharedEsbuildConfig;
}

interface HarnessEvent {
  type: string;
  text?: string;
}

function parseEvents(stdout: string): HarnessEvent[] {
  const prefix = 'BUNDLE_SMOKE_EVENT ';
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as HarnessEvent);
}

describe('bundle smoke（P0-A：CJS 产物里 pi runtime 可用）', () => {
  let tmp: string;
  let agentDir: string;
  let harnessFile: string;
  let mock: MockOpenAiServer;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'at-ops-bundle-smoke-'));
    agentDir = join(tmp, 'agent');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(tmp, 'skills'), { recursive: true });

    mock = await startMockOpenAiSse();

    // 临时 models.json：openai-completions + 指向 mock 的 baseUrl + apiKey 占位符。
    // 若占位符被当成真实凭证发出去（未注入 getApiKey 的 key），auth 断言会红。
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify(
        {
          providers: {
            [MOCK_PROVIDER_ID]: {
              baseUrl: mock.baseUrl,
              api: 'openai-completions',
              apiKey: `\${secret:atOpsAgent.apiKey.${MOCK_PROVIDER_ID}}`,
              models: [{ id: MOCK_MODEL_ID, reasoning: false }]
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );
    await writeFile(join(agentDir, 'auth.json'), '{}', 'utf8');
    await writeFile(join(agentDir, 'models-store.json'), '{}', 'utf8');

    // 用与 dist/extension.js 同一套配置打 harness（bundle + cjs + external:vscode
    // + import.meta.url shim）。pi 与生产一样被打进 bundle，不外置。
    const { sharedBundleOptions } = await loadSharedEsbuildConfig();
    harnessFile = join(tmp, 'bundle-harness.cjs');
    await build({
      ...(sharedBundleOptions as BuildOptions),
      entryPoints: [join(__dirname, 'helpers', 'bundle-harness.ts')],
      outfile: harnessFile,
      sourcemap: false,
      minify: false,
      logLevel: 'silent'
    });
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await mock?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('共享配置携带 import.meta.url shim（快速回归守卫）', async () => {
    const { importMetaUrlShim, sharedBundleOptions } = await loadSharedEsbuildConfig();
    expect(importMetaUrlShim.define['import.meta.url']).toBe('__importMetaUrl');
    expect(importMetaUrlShim.banner.js).toContain("pathToFileURL(__filename)");
    // shim 必须实际混入共享配置（而不是只导出没使用）。
    expect(sharedBundleOptions.define).toEqual(importMetaUrlShim.define);
    expect(sharedBundleOptions.banner).toEqual(importMetaUrlShim.banner);
    expect(sharedBundleOptions).toMatchObject({
      bundle: true,
      format: 'cjs',
      platform: 'node',
      external: ['vscode']
    });
  });

  it(
    'CJS 产物里 createOpsRuntime 流式可用，且 mock 收到注入的 Bearer key',
    async () => {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [harnessFile], {
            cwd: tmp,
            env: {
              ...process.env,
              BUNDLE_SMOKE_AGENT_DIR: agentDir,
              BUNDLE_SMOKE_CWD: tmp,
              BUNDLE_SMOKE_API_KEY: INJECTED_API_KEY
            }
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          const killer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS - 10_000);
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(killer);
            resolve({ code, stdout, stderr });
          });
        }
      );

      const diagnostics = `exit=${String(result.code)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      expect(result.code, diagnostics).toBe(0);

      // 流式正文必须来自 mock 下发的 chunks。没有 import.meta shim 时这里只会
      // 看到 FallbackRuntime 的兜底文案（创建期 pi 加载失败），断言失败。
      const events = parseEvents(result.stdout);
      const streamedText = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text ?? '')
        .join('');
      expect(streamedText, diagnostics).toContain(MOCK_COMPLETION_CHUNKS.join(''));
      expect(events.some((e) => e.type === 'idle'), diagnostics).toBe(true);

      // 鉴权注入：mock 必须收到 getApiKey 的 key，而非 models.json 的
      // "${secret:…}" 占位符（FallbackRuntime 则一条请求都不会发）。
      const completionRequests = mock.requests.filter((r) => r.url.includes('/chat/completions'));
      expect(completionRequests.length, diagnostics).toBeGreaterThan(0);
      for (const request of completionRequests) {
        expect(request.authorization).toBe(`Bearer ${INJECTED_API_KEY}`);
      }
    },
    RUN_TIMEOUT_MS
  );
});
