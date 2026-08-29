/**
 * 落盘 / 导出 / 回模型文本刮密。纯函数，禁止 import vscode
 * （runtime 与 host 共用；Plan 06 将扩展 sanitizeErrorText）。
 *
 * 刮密不可逆，不要试图还原。规则按顺序应用，hits 计每次替换。
 */

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): { text: string; hits: number } {
  if (text.length === 0) return { text, hits: 0 };
  let hits = 0;
  let out = text;

  const apply = (pattern: RegExp, replace: string | ((match: string, ...groups: string[]) => string)): void => {
    out = out.replace(pattern, (match, ...rest) => {
      hits += 1;
      if (typeof replace === 'string') return replace;
      return replace(match, ...(rest as string[]));
    });
  };

  // 1. PEM 私钥块
  apply(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    REDACTED
  );
  // 2. Authorization: Bearer …（token 字符集与规则 3 对齐，避免 \S+ 吞掉无空格的 JSON 全文）
  apply(
    /Authorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._\-+=/]+/gi,
    `Authorization: Bearer ${REDACTED}`
  );
  // 3. 裸 Bearer token（保留 modelsProbe 的大小写不敏感行为）
  apply(/Bearer\s+[A-Za-z0-9._\-+=/]{8,}/gi, `Bearer ${REDACTED}`);
  // 4. api_key / secret / password / passwd / token 作为键（值不跨引号/空白）
  apply(
    /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*[^\s"'\\]+/gi,
    (_match, key: string) => `${key}=${REDACTED}`
  );
  // 5. 数据库连接串 userinfo
  apply(
    /(mysql|postgres|mongodb|redis):\/\/[^@\s]+@/gi,
    (_match, proto: string) => `${proto}://${REDACTED}@`
  );
  // 6. OpenAI 风格 sk-…
  apply(/sk-[A-Za-z0-9_-]{8,}/g, `sk-${REDACTED}`);
  // 7. 插件系列 token 头
  apply(/x-at-series-token\s*[:=]\s*[^\s"'\\]+/gi, REDACTED);

  return { text: out, hits };
}

/**
 * Prompt / 探测错误上屏入口（Plan 06）。与 redactSecrets 同一套规则
 * （Bearer / sk- / PEM / 连接串），避免 host 与 runtime 两套刮密。
 */
export function sanitizeErrorText(text: string): string {
  return redactSecrets(text).text;
}
