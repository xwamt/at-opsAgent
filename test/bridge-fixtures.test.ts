import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listBridgeRecords, parseBridgeRegistryRecord } from '@at-series/mcp-hub';

import {
  REDACTED_TOKEN,
  listBridgeFixturePluginIds,
  loadAllBridgeFixtures,
  loadBridgeFixture,
  writeBridgeFixture
} from './fixtures/bridges';

// Anything that looks like a real AT Series bridge token (long hex blob).
const REAL_TOKEN_RE = /[0-9a-f]{32,}/i;

describe('bridge registry fixtures', () => {
  it('cover at.grafana / at.terminal / at.database', () => {
    expect(listBridgeFixturePluginIds()).toEqual(['at.database', 'at.grafana', 'at.terminal']);
  });

  it('every fixture is a valid BridgeRegistryRecord per the Hub parser', () => {
    for (const pluginId of listBridgeFixturePluginIds()) {
      const raw = loadBridgeFixture(pluginId);
      const parsed = parseBridgeRegistryRecord(raw);
      expect(parsed, `${pluginId} fixture must parse`).not.toBeNull();
      expect(parsed?.pluginId).toBe(pluginId);
      expect(parsed?.tools.length).toBeGreaterThan(0);
    }
  });

  it('never contains a real-looking token — only the redacted placeholder', () => {
    for (const record of loadAllBridgeFixtures()) {
      expect(record.token).toBe(REDACTED_TOKEN);
      expect(record.token).not.toMatch(REAL_TOKEN_RE);
    }
  });

  it('contains no Jenkins/Nacos write or exec tools (product hard rule)', () => {
    for (const record of loadAllBridgeFixtures()) {
      for (const tool of record.tools) {
        if (/^(jenkins|nacos)_/i.test(tool.name)) {
          expect(tool.risk).toBe('read');
        }
      }
    }
  });

  describe('writeBridgeFixture materializes records the embedded Hub can read', () => {
    let home: string;

    beforeAll(async () => {
      home = await mkdtemp(path.join(tmpdir(), 'at-ops-bridge-fixtures-'));
    });

    afterAll(async () => {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    });

    it('writes into <home>/.at-series/bridges/<hostApp> with a fresh heartbeat', async () => {
      const before = Date.now();
      const written = await writeBridgeFixture({
        home,
        hostApp: 'vscode',
        pluginId: 'at.grafana',
        overrides: { port: 51234 }
      });
      expect(written.updatedAt).toBeGreaterThanOrEqual(before);
      expect(written.pid).toBe(process.pid);
      expect(written.port).toBe(51234);
      expect(written.token).toBe(REDACTED_TOKEN);

      await writeBridgeFixture({ home, hostApp: 'vscode', pluginId: 'at.terminal' });
      await writeBridgeFixture({ home, hostApp: 'cursor', pluginId: 'at.database' });

      // Same reader the embedded HubHost uses; hostApp scoping must hold.
      const vscodeRecords = await listBridgeRecords({ hostApp: 'vscode', home });
      expect(vscodeRecords.map((r) => r.pluginId).sort()).toEqual(['at.grafana', 'at.terminal']);
      const cursorRecords = await listBridgeRecords({ hostApp: 'cursor', home });
      expect(cursorRecords.map((r) => r.pluginId)).toEqual(['at.database']);
    });
  });
});
