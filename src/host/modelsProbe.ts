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

/** 判断模型 ID 是否属于已知具备深度思考 / Reasoning 能力的模型 */
export function isReasoningModel(modelId: string | undefined): boolean {
  if (!modelId || typeof modelId !== 'string') return false;
  const lower = modelId.toLowerCase();
  return (
    lower.includes('deepseek-r1') ||
    lower.includes('reasoner') ||
    lower.includes('thinking') ||
    lower.includes('qwq') ||
    /(^|[-_/])(o1|o3|r1)([-_/]|$)/.test(lower) ||
    lower.includes('claude-3-7-sonnet')
  );
}

/** 解析 OpenAI / Ollama / OpenRouter 兼容 /models 响应（{data:[{id}]}、{models:[…]} 或数组）。 */
export function parseModelList(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as unknown[])
      : Array.isArray((payload as Record<string, unknown>).models)
        ? ((payload as Record<string, unknown>).models as unknown[])
        : [];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      ids.push(entry.trim());
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      const id =
        (typeof rec.id === 'string' && rec.id.trim()) ||
        (typeof rec.name === 'string' && rec.name.trim()) ||
        (typeof rec.model === 'string' && rec.model.trim()) ||
        '';
      if (id.length > 0) ids.push(id);
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

/**
 * 拉取模型目录：自动尝试 candidate 端点（/models -> /v1/models -> /api/tags）。
 * 成功返回模型 ID 清单，失败返回中文诊断信息。
 */
export async function fetchModelCatalog(input: ProbeInput): Promise<FetchModelsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0) return { ok: false, error: 'Base URL 不能为空。' };

  // 构造候选端点列表（按优先级尝试）
  const candidateUrls: string[] = [joinBaseUrl(baseUrl, 'models')];
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (!trimmed.endsWith('/v1')) {
    candidateUrls.push(joinBaseUrl(baseUrl, 'v1/models'));
  }
  candidateUrls.push(joinBaseUrl(baseUrl, 'api/tags')); // Ollama 原生端点

  let lastError = '';
  let lastStatus: number | undefined;

  for (const url of candidateUrls) {
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: headersFor(input.apiKey),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) {
        const rawJson = await res.json().catch(() => undefined);
        const models = parseModelList(rawJson);
        if (models.length > 0) {
          return { ok: true, models };
        }
        lastError = '目录响应里没有可用的模型 id（响应格式不是 OpenAI 兼容 /models 或 Ollama /api/tags）。';
      } else {
        lastStatus = res.status;
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          // 鉴权或限流失败无需尝试其他端点，立即返回明确提示
          return { ok: false, error: describeHttpStatus(res.status) };
        }
      }
    } catch (err) {
      lastError = describeNetworkError(err);
      // 网络级错误（如域名不通）中断探测
      if (lastError.includes('DNS') || lastError.includes('连接被拒绝')) {
        return { ok: false, error: lastError };
      }
    }
  }

  if (lastError) {
    return { ok: false, error: lastError };
  }
  if (lastStatus !== undefined && lastStatus !== 404) {
    return { ok: false, error: describeHttpStatus(lastStatus) };
  }
  return {
    ok: false,
    error: '无法从该 API 获取模型列表：/models 与 /v1/models 均未返回有效的模型数据。'
  };
}

