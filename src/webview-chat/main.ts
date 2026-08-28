import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './ops-tokens.css';
import ChatApp from './components/ChatApp.vue';
import { ensureStylesheet } from './ensure-css';
import { installMockHost } from './mock-host';
import { useOpsStore } from './store';
import { isMockHost } from './vscode-api';

function boot(): void {
  ensureStylesheet();
  let el = document.getElementById('app');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app';
    document.body.appendChild(el);
  }
  const pinia = createPinia();
  const app = createApp(ChatApp);
  app.use(pinia);
  const store = useOpsStore(pinia);
  store.attach();
  if (isMockHost()) {
    installMockHost();
  }
  app.mount(el);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
