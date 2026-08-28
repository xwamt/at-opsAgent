/**
 * esbuild 会把 SFC/导入的样式打成同名 .css。若宿主 html 没有 link，
 * 这里按当前脚本地址补一个（CSP style-src 允许 webview 资源域 + unsafe-inline）。
 * document.currentScript 必须在模块求值期捕获。
 */
const bootScript = document.currentScript as HTMLScriptElement | null;

export function ensureStylesheet(): void {
  const src = bootScript?.src;
  if (!src) {
    return;
  }
  const href = src.replace(/\.js(\?[^#]*)?(#.*)?$/, '.css$1$2');
  if (href === src) {
    return;
  }
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  for (const link of Array.from(links)) {
    if (link.href === href) {
      return;
    }
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
