/**
 * Compile/export smoke test: importing every public factory from its module
 * root catches missing exports and broken cross-module imports without
 * spinning up any runtime (no Hub start, no pi session, no processes).
 */
import { describe, expect, it } from 'vitest';

import { createAtSeriesHubHost, mapHubProviders, toolAnnotationsForRisk } from '../src/hub-host';
import { createOrchestrator, loadPlaybooks } from '../src/orchestrator';
import { buildSystemPrompt, createOpsRuntime } from '../src/runtime';
import { evaluatePolicy } from '../src/policy';
import { filterMcpServers, shouldSkipAtSeriesMcpServer } from '../src/mcp-client';

describe('public factory exports', () => {
  it('src/hub-host exposes createAtSeriesHubHost and helpers', () => {
    expect(typeof createAtSeriesHubHost).toBe('function');
    expect(typeof mapHubProviders).toBe('function');
    expect(typeof toolAnnotationsForRisk).toBe('function');
  });

  it('src/orchestrator exposes createOrchestrator and loadPlaybooks', () => {
    expect(typeof createOrchestrator).toBe('function');
    expect(typeof loadPlaybooks).toBe('function');
  });

  it('src/runtime exposes createOpsRuntime and buildSystemPrompt', () => {
    expect(typeof createOpsRuntime).toBe('function');
    expect(typeof buildSystemPrompt).toBe('function');
  });

  it('src/policy exposes evaluatePolicy', () => {
    expect(typeof evaluatePolicy).toBe('function');
  });

  it('src/mcp-client exposes shouldSkipAtSeriesMcpServer and filterMcpServers', () => {
    expect(typeof shouldSkipAtSeriesMcpServer).toBe('function');
    expect(typeof filterMcpServers).toBe('function');
  });

  it('buildSystemPrompt composes a non-empty prompt without any runtime', () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
