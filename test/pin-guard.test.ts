/**
 * Pin guard: the pi runtime stack must stay pinned to exact versions.
 *
 * The extension embeds `@earendil-works/pi-coding-agent` and links against the
 * matching `pi-agent-core` / `pi-ai` internals; even a patch-level drift
 * between the three can break the extension-host integration at runtime.
 * This test fails loudly if anyone loosens the pins to a range.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PINNED_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai'
] as const;

/** Exact semver only: `1.2.3` plus optional pre-release/build metadata. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const manifestPath = path.resolve(__dirname, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('pi runtime dependency pins (package.json)', () => {
  for (const name of PINNED_PACKAGES) {
    it(`pins ${name} to an exact version`, () => {
      const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
      expect(
        version,
        `${name} is missing from package.json dependencies — the pi runtime stack must be ` +
          `declared and pinned to an exact version.`
      ).toBeDefined();
      expect(
        EXACT_VERSION.test(version ?? ''),
        `${name} is declared as "${version}" in package.json, but the pi runtime stack must be ` +
          `pinned to an exact version (no ^, ~, >=, ranges, or dist-tags). A loosened pin lets ` +
          `npm silently upgrade one package out of lockstep with the other two and break the ` +
          `extension-host integration. To upgrade intentionally, bump all three pi packages ` +
          `together to the same new exact version.`
      ).toBe(true);
    });
  }

  it('keeps all three pi packages on the same version (lockstep upgrade)', () => {
    const versions = PINNED_PACKAGES.map(
      (name) => manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
    );
    expect(
      new Set(versions).size,
      `The pi packages must move in lockstep, but package.json declares mixed versions: ` +
        PINNED_PACKAGES.map((name, i) => `${name}@${versions[i]}`).join(', ')
    ).toBe(1);
  });
});
