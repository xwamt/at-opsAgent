import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

// P0-A：pi 是 ESM-only 包，而扩展产物是 CJS。esbuild 的 cjs 输出会把
// import.meta 置成空对象，pi 的 dist/config.js 在模块顶层执行
// fileURLToPath(import.meta.url)，加载期即抛错 → createOpsRuntime 永远
// 回落 FallbackRuntime（测试绿、产物死）。define 把 import.meta.url 重写为
// banner 里由 __filename 推导的 file:// URL，让 pi 在 VSIX 的 CJS 产物里活过来。
// test/bundle-smoke.test.ts 以同一份配置打 harness 验证：删掉这个 shim，
// 该测试必须红。
export const importMetaUrlShim = {
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: {
    js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;"
  }
};

/**
 * 扩展主产物与 bundle-smoke 测试共用的核心打包配置。
 * entryPoints / outfile / sourcemap / minify 由调用方补齐。
 */
export const sharedBundleOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  ...importMetaUrlShim
};

// 仅在 `node esbuild.extension.mjs` 直接执行时构建；被测试 import 时只导出配置。
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const watch = process.argv.includes('--watch');
  const minify = !watch;

  const ctx = await esbuild.context({
    ...sharedBundleOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    sourcemap: !minify,
    minify,
    treeShaking: true,
    logLevel: 'info'
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
