/**
 * walkthrough 英文文件名必须是 doc.nls.en.md（vscode#129461），
 * 旧的 *.en.md 永不加载。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'media', 'walkthrough');

describe('walkthrough nls 英文文件名', () => {
  it('configure-model.nls.en.md 存在且 .en.md 不存在', () => {
    expect(existsSync(join(ROOT, 'configure-model.nls.en.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'configure-model.en.md'))).toBe(false);
  });

  it('install-plugins / first-playbook 同样改名', () => {
    expect(existsSync(join(ROOT, 'install-plugins.nls.en.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'install-plugins.en.md'))).toBe(false);
    expect(existsSync(join(ROOT, 'first-playbook.nls.en.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'first-playbook.en.md'))).toBe(false);
  });
});
