/**
 * Plan 12 T7：IM 加签 + vscode:// 深链（单向）。
 * 密钥空仍 POST 并 log「未加签」；密钥在 SecretStorage 时带 X-At-Ops-Signature。
 * 禁止 inbound 批准 HTTP。
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configState } = vi.hoisted(() => ({
  configState: { webhookUrl: 'https://im.example.internal/hook' }
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue?: unknown) => {
        if (key === 'im.webhookUrl') return configState.webhookUrl;
        return defaultValue;
      }
    })
  },
  env: { uriScheme: 'vscode' }
}));

import { IM_WEBHOOK_SECRET_KEY } from '../src/host/secrets';
import {
  IM_EXTENSION_ID,
  IM_SIGNATURE_HEADER,
  approvalChatDeeplink,
  buildApprovalWebhookBody,
  handleChatDeeplink,
  hmacSha256Hex,
  parseChatDeeplinkSessionId,
  sendApprovalWebhook,
  type ApprovalWebhookContext
} from '../src/host/services/approvalNotify';
import type { ApprovalBriefView } from '../src/protocol';

const SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'src/host/services/approvalNotify.ts'),
  'utf8'
);
const CONFIG_SOURCE = readFileSync(
  path.resolve(__dirname, '..', 'src/host/services/configService.ts'),
  'utf8'
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
) as { publisher: string; name: string; contributes: { configuration: { properties: Record<string, unknown> } } };

const VIEW: ApprovalBriefView = {
  id: 'brief-1',
  risk: 'exec',
  targetLabel: '重启 prod-a nginx',
  elements: { goal: '重启 prod-a nginx' },
  dualConfirmHint: true
};

function expectedSig(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('IM webhook 加签 + 深链', () => {
  const logs: string[] = [];
  const secrets = new Map<string, string>();
  let fetchMock: ReturnType<typeof vi.fn>;

  const ctx: ApprovalWebhookContext = {
    log: (message: string) => {
      logs.push(message);
    },
    secrets: {
      get: async (key: string) => secrets.get(key)
    }
  };

  beforeEach(() => {
    logs.length = 0;
    secrets.clear();
    configState.webhookUrl = 'https://im.example.internal/hook';
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('密钥空：仍 POST，log 未加签，无签名头', async () => {
    await sendApprovalWebhook(ctx, VIEW, 'sess-empty');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers[IM_SIGNATURE_HEADER]).toBeUndefined();
    expect(logs.some((line) => line.includes('未加签'))).toBe(true);
    const body = JSON.parse(String(init.body)) as { deeplink: string; hint: string; sessionId: string };
    expect(body.sessionId).toBe('sess-empty');
    expect(body.deeplink).toBe(
      `vscode://${PACKAGE_JSON.publisher}.${PACKAGE_JSON.name}/chat?sessionId=sess-empty`
    );
    expect(body.hint).toContain('IDE');
  });

  it('密钥有：X-At-Ops-Signature = HMAC-SHA256(body)', async () => {
    secrets.set(IM_WEBHOOK_SECRET_KEY, 'super-secret');
    await sendApprovalWebhook(ctx, VIEW, 'sess-signed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    expect(headers[IM_SIGNATURE_HEADER]).toBe(expectedSig(body, 'super-secret'));
    expect(headers[IM_SIGNATURE_HEADER]).toBe(hmacSha256Hex(body, 'super-secret'));
    expect(logs.some((line) => line.includes('未加签'))).toBe(false);
  });

  it('webhookUrl 空：零 fetch', async () => {
    configState.webhookUrl = '';
    secrets.set(IM_WEBHOOK_SECRET_KEY, 'ignored');
    await sendApprovalWebhook(ctx, VIEW, 'sess-off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deeplink authority 与 package.json publisher.name 一致', () => {
    expect(`${PACKAGE_JSON.publisher}.${PACKAGE_JSON.name}`).toBe(IM_EXTENSION_ID);
    expect(approvalChatDeeplink('abc')).toBe('vscode://at-series.at-ops-agent/chat?sessionId=abc');
    const body = JSON.parse(buildApprovalWebhookBody(VIEW, 's1', { ts: 1, uriScheme: 'vscode' })) as {
      deeplink: string;
    };
    expect(body.deeplink).toContain('/chat?sessionId=s1');
  });
});

describe('UriHandler 只切会话（不是批准 API）', () => {
  it('解析 /chat?sessionId=', () => {
    expect(parseChatDeeplinkSessionId({ path: '/chat', query: 'sessionId=sess-9' })).toBe('sess-9');
  });

  it('拒绝 /approve 等非 chat path', () => {
    expect(parseChatDeeplinkSessionId({ path: '/approve', query: 'briefId=x' })).toBeUndefined();
    expect(parseChatDeeplinkSessionId({ path: '/chat/approve', query: 'sessionId=x' })).toBeUndefined();
  });

  it('handleChatDeeplink 切会话并 focus，不暴露批准', async () => {
    const switched: string[] = [];
    let focused = 0;
    const logs: string[] = [];
    const outcome = await handleChatDeeplink(
      { path: '/chat', query: 'sessionId=sess-2' },
      {
        switchSession: (id) => {
          switched.push(id);
          return { ok: true };
        },
        focusChat: async () => {
          focused += 1;
        },
        log: (m) => logs.push(m)
      }
    );
    expect(outcome).toBe('switched');
    expect(switched).toEqual(['sess-2']);
    expect(focused).toBe(1);
  });

  it('approve 路径被忽略', async () => {
    const outcome = await handleChatDeeplink(
      { path: '/approve', query: 'briefId=b1' },
      {
        switchSession: () => ({ ok: true }),
        focusChat: async () => undefined,
        log: () => undefined
      }
    );
    expect(outcome).toBe('ignored');
  });
});

describe('T7 禁区：无 inbound 批准监听；密钥不进 settings', () => {
  it('approvalNotify 源文件没有 HTTP listen / createServer', () => {
    expect(SOURCE).not.toMatch(/\bcreateServer\b/);
    expect(SOURCE).not.toMatch(/\.listen\s*\(/);
    expect(SOURCE).not.toMatch(/createServer/);
  });

  it('im.webhookSecret 不在 package.json configuration / configService 白名单', () => {
    expect(PACKAGE_JSON.contributes.configuration.properties['atOpsAgent.im.webhookSecret']).toBeUndefined();
    expect(CONFIG_SOURCE).not.toContain('webhookSecret');
  });
});

describe('T13 GLM/Kimi preset 无真实密钥', () => {
  it('示例只有 SecretStorage 占位符', () => {
    const glm = readFileSync(path.resolve(__dirname, '..', 'media/presets/glm.json'), 'utf8');
    const kimi = readFileSync(path.resolve(__dirname, '..', 'media/presets/kimi.json'), 'utf8');
    for (const raw of [glm, kimi]) {
      expect(raw).toContain('${secret:atOpsAgent.apiKey.');
      expect(raw).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      JSON.parse(raw);
    }
    expect(glm).toContain('"thinkingFormat": "zai"');
    expect(kimi).toContain('"kimi"');
  });
});
