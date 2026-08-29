/**
 * models/test 与 models/fetch 的 HTTP 探测（P0-B / P1-1，vscode-free）：
 * - GET /models 成功 → ok；404/405 退 1-token chat completion；
 * - 401/403 归类「Key 无效」；DNS/超时归类网络错误；
 * - 红线：API key 只进 Authorization 头，绝不出现在 error 文本里。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeNetworkError,
  fetchModelCatalog,
  joinBaseUrl,
  parseModelList,
  probeOpenAiCompatible,
  sanitizeErrorText
} from '../src/host/modelsProbe';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('joinBaseUrl / parseModelList', () => {
  it('容忍尾部斜杠与端点前导斜杠', () => {
    expect(joinBaseUrl('https://gw.local/v1/', '/models')).toBe('https://gw.local/v1/models');
    expect(joinBaseUrl('https://gw.local/v1', 'models')).toBe('https://gw.local/v1/models');
  });

  it('兼容 {data:[{id}]}、{models:[…]} 与字符串数组，去重', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b']);
    expect(parseModelList({ models: ['m1', { name: 'm2' }] })).toEqual(['m1', 'm2']);
    expect(parseModelList({ nope: true })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
  });
});

describe('probeOpenAiCompatible', () => {
  it('GET /models 200 → ok 且带延迟；key 进 Authorization 头', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
      return jsonResponse(200, { data: [] });
    }) as unknown as typeof fetch;

    const res = await probeOpenAiCompatible({
      baseUrl: 'https://gw.local/v1/',
      apiKey: 'sk-test-123',
      fetchImpl
    });
    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(typeof res.latencyMs).toBe('number');
  });

  it('401 归类为 Key 无效且不透出 key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401)) as unknown as typeof fetch;
    const res = await probeOpenAiCompatible({
      baseUrl: 'https://gw.local/v1',
      apiKey: 'sk-secret-abcdef',
      fetchImpl
    });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(401);
    expect(res.error).toContain('API Key 无效');
    expect(res.error).not.toContain('sk-secret-abcdef');
  });

  it('/models 404 时退 1-token chat completion（成功）', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/models')) return jsonResponse(404);
      const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
      expect(body.model).toBe('gpt-x');
      expect(body.max_tokens).toBe(1);
      return jsonResponse(200, { choices: [] });
    }) as unknown as typeof fetch;

    const res = await probeOpenAiCompatible({
      baseUrl: 'https://gw.local/v1',
      modelId: 'gpt-x',
      fetchImpl
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['https://gw.local/v1/models', 'https://gw.local/v1/chat/completions']);
  });

  it('/models 404 且无 modelId → 明确说明无法探测', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404)) as unknown as typeof fetch;
    const res = await probeOpenAiCompatible({ baseUrl: 'https://gw.local/v1', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未提供模型 ID');
  });

  it('DNS 失败归类为网络错误', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND gw.local');
    }) as unknown as typeof fetch;
    const res = await probeOpenAiCompatible({ baseUrl: 'https://gw.local/v1', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('DNS 解析失败');
  });

  it('空 Base URL 直接报错，不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await probeOpenAiCompatible({ baseUrl: '  ', fetchImpl });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchModelCatalog', () => {
  it('/models 成功 → 模型 id 清单', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { data: [{ id: 'deepseek-v3' }, { id: 'qwen-max' }] })
    ) as unknown as typeof fetch;
    const res = await fetchModelCatalog({ baseUrl: 'https://gw.local/v1', fetchImpl });
    expect(res).toEqual({ ok: true, models: ['deepseek-v3', 'qwen-max'] });
  });

  it('响应非 OpenAI 兼容格式 → 明确报错', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { hello: 'world' })) as unknown as typeof fetch;
    const res = await fetchModelCatalog({ baseUrl: 'https://gw.local/v1', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('没有可用的模型 id');
  });

  it('401 → Key 无效分类', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401)) as unknown as typeof fetch;
    const res = await fetchModelCatalog({ baseUrl: 'https://gw.local/v1', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('API Key 无效');
  });
});

describe('脱敏', () => {
  it('sanitizeErrorText 抹掉 Bearer 与 sk- 片段', () => {
    expect(sanitizeErrorText('failed: Bearer sk-abcdef123456 rejected')).toBe(
      'failed: Bearer [REDACTED] rejected'
    );
    expect(sanitizeErrorText('key sk-abcdefgh1234 leaked')).toBe('key sk-[REDACTED] leaked');
  });

  it('describeNetworkError 对未知错误也不透出敏感串', () => {
    const msg = describeNetworkError(new Error('boom Bearer sk-abcdefgh1234'));
    expect(msg).not.toContain('sk-abcdefgh1234');
  });
});
