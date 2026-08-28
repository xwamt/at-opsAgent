import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '../webview-chat/ops-tokens.css';
import { ensureStylesheet } from '../webview-chat/ensure-css';
import { isMockHost } from '../webview-chat/vscode-api';
import BoardApp from './components/BoardApp.vue';
import { installBoardMockHost } from './mock-host';
import { useBoardStore } from './store';

function boot(): void {
  ensureStylesheet();
  let el = document.getElementById('app');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
  }
  const pinia = createPinia();
  const app = createApp(BoardApp);
  app.use(pinia);
  const store = useBoardStore(pinia);
  store.attach();
  if (isMockHost()) {
    installBoardMockHost();
  }
  app.mount(el);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
