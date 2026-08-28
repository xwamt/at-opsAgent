/**
 * 本地 mock OpenAI-compatible SSE 服务（/chat/completions 流式）。
 * bundle-smoke 用它断言两件事：
 * 1. CJS 产物里的 pi runtime 真正发起了流式请求（text_delta 拼接 = 下发正文）；
 * 2. Authorization 头是 host 经 getApiKey 注入的 key，而非 models.json 占位符。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

export interface MockOpenAiServer {
  /** 形如 http://127.0.0.1:<port>/v1，可直接写进 models.json 的 baseUrl。 */
  baseUrl: string;
  /** 收到的全部请求（含 Authorization 头与原始 body），按到达顺序。 */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** SSE 逐块下发的正文；测试断言 text_delta 拼接结果包含 join('')。 */
export const MOCK_COMPLETION_CHUNKS = ['你好', '，我是', 'mock 模型。'] as const;

/** models.json 里 mock 网关的 provider/model id（harness 与测试共用）。 */
export const MOCK_PROVIDER_ID = 'mock-openai';
export const MOCK_MODEL_ID = 'mock-model';

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'cmpl-bundle-smoke',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    ...payload
  })}\n\n`;
}

function streamCompletion(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache'
  });
  let index = 0;
  const sendNext = (): void => {
    if (index < MOCK_COMPLETION_CHUNKS.length) {
      res.write(
        sseChunk({
          choices: [
            { index: 0, delta: { content: MOCK_COMPLETION_CHUNKS[index] }, finish_reason: null }
          ]
        })
      );
      index += 1;
      setTimeout(sendNext, 5);
    } else {
      res.write(
        sseChunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
        })
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  sendNext();
}

/** 在 127.0.0.1 的随机端口起服务；close() 后端口释放。 */
export async function startMockOpenAiSse(): Promise<MockOpenAiServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization ?? null,
        body
      });
      if ((req.url ?? '').includes('/chat/completions')) {
        streamCompletion(res);
      } else {
        // 其余端点（如 GET /models）回空列表即可。
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
