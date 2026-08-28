import * as esbuild from 'esbuild';
import vue3 from 'esbuild-plugin-vue3';

const watch = process.argv.includes('--watch');
const minify = !watch;
const vuePlugin = vue3();

const common = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: !minify,
  minify,
  treeShaking: true,
  plugins: [vuePlugin],
  logLevel: 'info'
};

const chat = await esbuild.context({
  ...common,
  entryPoints: ['src/webview-chat/main.ts'],
  outfile: 'dist/webview/chat.js'
});

const board = await esbuild.context({
  ...common,
  entryPoints: ['src/webview-board/main.ts'],
  outfile: 'dist/webview/board.js'
});

const settings = await esbuild.context({
  ...common,
  entryPoints: ['src/webview-settings/main.ts'],
  outfile: 'dist/webview/settings.js'
});

const contexts = [chat, board, settings];

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
