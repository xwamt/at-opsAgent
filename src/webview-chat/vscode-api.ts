/**
 * acquireVsCodeApi 单例封装。webview 环境只允许调用一次；
 * 本地直接打开 html 调试时不存在该函数，回退到 mock。
 */

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): unknown;
}

declare const acquireVsCodeApi: undefined | (() => VsCodeApi);

let cached: VsCodeApi | null = null;
let mocked = false;

export function isMockHost(): boolean {
  getVsCodeApi();
  return mocked;
}

export function getVsCodeApi(): VsCodeApi {
  if (cached) {
    return cached;
  }
  if (typeof acquireVsCodeApi === 'function') {
    cached = acquireVsCodeApi();
    return cached;
  }
  mocked = true;
  let state: unknown = undefined;
  cached = {
    postMessage(message: unknown) {
      // 本地调试：交给 mock host（若已安装），否则仅打印。
      const hook = (window as unknown as Record<string, unknown>).__opsMockPostMessage;
      if (typeof hook === 'function') {
        (hook as (m: unknown) => void)(message);
      } else {
        console.info('[ops-webview mock] postMessage', message);
      }
    },
    getState() {
      return state;
    },
    setState(next: unknown) {
      state = next;
      return next;
    }
  };
  return cached;
}
