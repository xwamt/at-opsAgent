/**
 * Redacted Bridge registry fixtures.
 *
 * Shape matches `BridgeRegistryRecord` from @at-series/mcp-hub (the same
 * files AT Series plugins publish under `~/.at-series/bridges/<hostApp>/`).
 *
 * Security invariants (enforced by test/bridge-fixtures.test.ts):
 * - `token` is always the literal REDACTED_TOKEN — never a real bridge token,
 *   so nothing secret can leak into test output or snapshots.
 * - `port` / `pid` / `updatedAt` are placeholders. The registry treats
 *   heartbeats older than ~90s as stale, so tests must materialize records
 *   with `writeBridgeFixture` (which stamps a fresh `updatedAt`) instead of
 *   copying the JSON files verbatim.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BridgeRegistryRecord } from '@at-series/mcp-hub';

export const REDACTED_TOKEN = 'test-token-redacted';

const FIXTURES_DIR = __dirname;

/** pluginIds with a checked-in fixture (at.grafana / at.terminal / at.database). */
export function listBridgeFixturePluginIds(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
}

/** Load one fixture as parsed JSON (no validation — tests validate). */
export function loadBridgeFixture(pluginId: string): BridgeRegistryRecord {
  const file = path.join(FIXTURES_DIR, `${pluginId}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as BridgeRegistryRecord;
}

export function loadAllBridgeFixtures(): BridgeRegistryRecord[] {
  return listBridgeFixturePluginIds().map((pluginId) => loadBridgeFixture(pluginId));
}

export type WriteBridgeFixtureOptions = {
  /** Temp directory standing in for `os.homedir()`. */
  home: string;
  hostApp: string;
  pluginId: string;
  /** Patched on top of the fixture — e.g. a live fake-bridge port. */
  overrides?: Partial<BridgeRegistryRecord>;
};

/**
 * Materialize a fixture into `<home>/.at-series/bridges/<hostApp>/` the way
 * a live plugin would publish it: fresh `updatedAt`, current `pid`, and the
 * caller's `hostApp`, plus any explicit overrides (typically `port`).
 * Returns the record as written.
 */
export async function writeBridgeFixture(
  options: WriteBridgeFixtureOptions
): Promise<BridgeRegistryRecord> {
  const record: BridgeRegistryRecord = {
    ...loadBridgeFixture(options.pluginId),
    hostApp: options.hostApp,
    pid: process.pid,
    updatedAt: Date.now(),
    ...options.overrides
  };
  const dir = path.join(options.home, '.at-series', 'bridges', options.hostApp);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${record.bridgeId}.json`), JSON.stringify(record, null, 2), 'utf8');
  return record;
}
