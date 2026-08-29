/**
 * T12：skills.lock.json 与 vendor 树哈希对齐。
 * 改 skills/vendor/super-ops@0.1.0 任意一字必须走 diff 仪式并更新锁文件。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashDirectoryTree } from '../src/skills/treeHash';

const VENDOR_DIR = join(__dirname, '..', 'skills/vendor/super-ops@0.1.0');
const LOCK_PATH = join(__dirname, '..', 'skills/skills.lock.json');
const LOCK_MISMATCH = 'vendor 升级走 diff 仪式';

describe('skills.lock.json', () => {
  it('super-ops@0.1.0 树哈希与锁文件一致', () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as {
      vendor?: { 'super-ops'?: { version?: string; sha256?: string } };
    };
    const entry = lock.vendor?.['super-ops'];
    expect(entry?.version).toBe('0.1.0');
    const actual = hashDirectoryTree(VENDOR_DIR);
    expect(actual, LOCK_MISMATCH).toBe(entry?.sha256);
  });
});
