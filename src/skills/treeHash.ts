/**
 * 技能目录的稳定树哈希：posix 相对路径排序后，逐文件写入
 * `path` + NUL + 原始字节 + NUL，再 sha256 hex。路径分隔一律 `/`。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function posixRel(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

export function listFilesSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => {
    const pa = posixRel(root, a);
    const pb = posixRel(root, b);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}

export function hashDirectoryTree(root: string): string {
  const hash = createHash('sha256');
  for (const file of listFilesSorted(root)) {
    hash.update(posixRel(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
