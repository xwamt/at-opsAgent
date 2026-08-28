import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = !watch;

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: !minify,
  minify,
  treeShaking: true,
  external: ['vscode'],
  logLevel: 'info'
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
