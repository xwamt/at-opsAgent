/**
 * models/test 与 models/fetch 的 HTTP 探测（P0-B「保存并测试」/ P1-1 拉目录）。
 *
 * 不 import vscode：settings webview 的 req 由 hostController 路由到这里。
 * 约定：
 * - 先 GET {baseUrl}/models（OpenAI 兼容目录端点），404/405 再退 1-token
 *   chat completion 探测（部分网关不开 /models）。
 * - 401/403 归类为「Key 无效或无权限」；DNS/连接/超时归类为网络错误。
 * - API key 只进 Authorization 头，**绝不出现在返回的 error 文本或日志里**。
 */
import { sanitizeErrorText } from '../runtime/sanitize';

export { sanitizeErrorText };

export interface ProbeInput {
  baseUrl: string;
  modelId?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  httpStatus?: number;
}

export interface FetchModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** baseUrl 规整 + 端点拼接（容忍尾部斜杠）。 */
export function joinBaseUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

/** HTTP 状态码 → 人话（中文；不含任何凭证）。 */
export function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `服务返回 ${status}：API Key 无效、过期或无权限。请检查后重试。`;
  }
  if (status === 404) return '服务返回 404：Base URL 或端点不存在，请核对地址。';
  if (status === 429) return '服务返回 429：限流中，请稍后重试。';
  if (status >= 500) return `服务返回 ${status}：网关/模型服务端错误。`;
  return `服务返回 ${status}。`;
}

/** 网络级错误 → 人话；确保不透出 Authorization 等敏感信息。 */
export function describeNetworkError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const lowered = raw.toLowerCase();
  if (lowered.includes('abort') || lowered.includes('timeout')) {
    return '连接超时：网关未在限定时间内响应，请检查网络或 Base URL。';
  }
  if (
    lowered.includes('enotfound') ||
    lowered.includes('eai_again') ||
    lowered.includes('getaddrinfo')
  ) {
    return 'DNS 解析失败：无法解析 Base URL 的主机名。';
  }
  if (lowered.includes('econnrefused')) {
    return '连接被拒绝：目标端口未监听，请核对 Base URL 与端口。';
  }
  if (lowered.includes('certificate') || lowered.includes('tls') || lowered.includes('ssl')) {
    return 'TLS/证书错误：请核对 https 地址与内网证书配置。';
  }
  return `网络错误：${sanitizeErrorText(raw)}`;
}

function headersFor(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** 解析 OpenAI 兼容 /models 响应（{data:[{id}]} 或 {models:[…]}）。 */
export function parseModelList(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.length > 0) {
      ids.push(entry);
    } else if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/**
 * 连通性测试：GET /models，404/405 时退 1-token chat completion。
 * 成功返回延迟；失败返回分类后的中文原因（不含 key）。
 */
export async function probeOpenAiCompatible(input: ProbeInput): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };
  const started = Date.now();
  let modelsStatus: number | undefined;
  try {
    const res = await fetchImpl(joinBaseUrl(baseUrl, 'models'), {
      method: 'GET',
      headers: headersFor(input.apiKey),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.ok) {
      return { ok: true, latencyMs: Date.now() - started, httpStatus: res.status };
    }
    modelsStatus = res.status;
    // /models 不存在不代表配置错：退 1-token completion 再判。
    if (res.status !== 404 && res.status !== 405) {
      return { ok: false, httpStatus: res.status, error: describeHttpStatus(res.status) };
    }
  } catch (err) {
    return { ok: false, error: describeNetworkError(err) };
  }
  if (typeof input.modelId !== 'string' || input.modelId.trim().length === 0) {
    return {
      ok: false,
      ...(modelsStatus !== undefined ? { httpStatus: modelsStatus } : {}),
      error: '该网关未开放 /models 端点，且未提供模型 ID，无法做最小对话探测。'
    };
  }
  const chatStarted = Date.now();
  try {
    const res = await fetchImpl(joinBaseUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: headersFor(input.apiKey),
      body: JSON.stringify({
        model: input.modelId.trim(),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.ok) {
      return { ok: true, latencyMs: Date.now() - chatStarted, httpStatus: res.status };
    }
    return { ok: false, httpStatus: res.status, error: describeHttpStatus(res.status) };
  } catch (err) {
    return { ok: false, error: describeNetworkError(err) };
  }
}

/** 拉取模型目录：GET /models → 模型 id 清单（P1-1）。 */
export async function fetchModelCatalog(input: ProbeInput): Promise<FetchModelsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };
  try {
    const res = await fetchImpl(joinBaseUrl(baseUrl, 'models'), {
      method: 'GET',
      headers: headersFor(input.apiKey),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return { ok: false, error: describeHttpStatus(res.status) };
    }
    const models = parseModelList(await res.json().catch(() => undefined));
    if (models.length === 0) {
      return { ok: false, error: '目录响应里没有可用的模型 id（响应格式不是 OpenAI 兼容 /models）。' };
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: describeNetworkError(err) };
  }
}
