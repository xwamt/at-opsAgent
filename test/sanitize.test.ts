/**
 * redactSecrets / sanitizeErrorText（Plan 07）：七条规则正例 + 普通巡检零误伤。
 * 夹具用固定 Bearer aabbccdd，不把真实 API key 写进期望。
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets, sanitizeErrorText } from '../src/runtime/sanitize';

describe('redactSecrets', () => {
  it('redacts Bearer tokens and counts hits', () => {
    const auth = redactSecrets('Authorization: Bearer aabbccdd');
    expect(auth.text).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(auth.text).not.toContain('aabbccdd');
    expect(auth.hits).toBeGreaterThanOrEqual(1);

    const bare = redactSecrets('failed Bearer aabbccdd rejected');
    expect(bare.text).toBe(`failed Bearer ${REDACTED} rejected`);
    expect(bare.hits).toBeGreaterThanOrEqual(1);
  });

  it('redacts PEM private key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0000fixture',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n');
    const out = redactSecrets(`key=\n${pem}\nnext`);
    expect(out.text).toBe(`key=\n${REDACTED}\nnext`);
    expect(out.text).not.toContain('PRIVATE KEY');
    expect(out.text).not.toContain('MIIEowIBAAKCAQEA0000fixture');
    expect(out.hits).toBeGreaterThanOrEqual(1);
  });

  it('redacts password= and mysql://user:pass@host', () => {
    const out = redactSecrets('password=hunter2 mysql://user:pass@db.local:3306/app');
    expect(out.text).toBe(`password=${REDACTED} mysql://${REDACTED}@db.local:3306/app`);
    expect(out.text).not.toContain('hunter2');
    expect(out.text).not.toContain('user:pass');
    expect(out.hits).toBeGreaterThanOrEqual(2);

    const postgres = redactSecrets('postgres://alice:s3cret@pg/main');
    expect(postgres.text).toBe(`postgres://${REDACTED}@pg/main`);
    expect(postgres.hits).toBeGreaterThanOrEqual(1);
  });

  it('redacts sk- keys and x-at-series-token headers', () => {
    const sk = redactSecrets('key sk-abcdefgh1234 leaked');
    expect(sk.text).toBe(`key sk-${REDACTED} leaked`);
    expect(sk.text).not.toContain('sk-abcdefgh1234');
    expect(sk.hits).toBeGreaterThanOrEqual(1);

    const header = redactSecrets('x-at-series-token: series-secret-value');
    expect(header.text).toBe(REDACTED);
    expect(header.text).not.toContain('series-secret-value');
    expect(header.hits).toBeGreaterThanOrEqual(1);

    const apiKey = redactSecrets('api_key=abcdEFGH');
    expect(apiKey.text).toBe(`api_key=${REDACTED}`);
    expect(apiKey.hits).toBeGreaterThanOrEqual(1);
  });

  it('does not swallow the rest of minified JSON after a Bearer value', () => {
    const json = JSON.stringify({
      ok: true,
      result: { header: 'Authorization: Bearer secret-token', blob: 'y'.repeat(80) }
    });
    const out = redactSecrets(json);
    expect(out.text).not.toContain('secret-token');
    expect(out.text).toContain(`Bearer ${REDACTED}`);
    expect(out.text).toContain('"blob"');
    expect(JSON.parse(out.text).result.blob.length).toBe(80);
  });

  it('does not redact ordinary df -h output', () => {
    const df = [
      'Filesystem      Size  Used Avail Use% Mounted on',
      '/dev/sda1        50G   20G   28G  42% /',
      'tmpfs            16G     0   16G   0% /dev/shm'
    ].join('\n');
    expect(redactSecrets(df)).toEqual({ text: df, hits: 0 });
    expect(redactSecrets('')).toEqual({ text: '', hits: 0 });
  });

  it('sanitizeErrorText aliases redact for Bearer', () => {
    const input = 'failed: Bearer aabbccdd rejected';
    expect(sanitizeErrorText(input)).toBe(redactSecrets(input).text);
    expect(sanitizeErrorText(input)).not.toContain('aabbccdd');
    expect(sanitizeErrorText(input)).toContain(`Bearer ${REDACTED}`);
  });
});
