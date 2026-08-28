/**
 * 发现空转软顶（docs/13 §4.4，DeepSeek 式 advisory nudge）纯函数单测：
 * 同一发现工具 + 规范化参数连续 ≥2 次空结果 → 结果 JSON 附加 nudge；
 * 换参数 / 换工具 / 非空结果重置计数；绝不 block、绝不改写原字段。
 */
import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_NUDGE_TEXT,
  DISCOVERY_NUDGE_THRESHOLD,
  applyDiscoveryNudge,
  canonicalArgsKey,
  createDiscoveryNudgeState,
  isEmptyDiscoveryResult,
  recordDiscoveryOutcome
} from '../src/runtime/discovery-nudge';

describe('recordDiscoveryOutcome（纯计数器）', () => {
  it('同一 toolName+argsKey 第 2 次连续空结果起返回 nudge', () => {
    const state = createDiscoveryNudgeState();
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBe(
      DISCOVERY_NUDGE_TEXT
    );
    // 第 3 次仍空：继续提醒（advisory，不 block）
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBe(
      DISCOVERY_NUDGE_TEXT
    );
    expect(DISCOVERY_NUDGE_THRESHOLD).toBe(2);
  });

  it('不同参数重置计数（连续性按 toolName+argsKey 判定）', () => {
    const state = createDiscoveryNudgeState();
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k2', true)).toBeUndefined();
    // 换回 k1 也算重新起步（中间被 k2 打断，不再连续）
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBe(
      DISCOVERY_NUDGE_TEXT
    );
  });

  it('不同工具名不算同一连续序列', () => {
    const state = createDiscoveryNudgeState();
    expect(recordDiscoveryOutcome(state, 'ops_search_tools', 'k1', true)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_get_tool', 'k1', true)).toBeUndefined();
  });

  it('非空结果重置计数', () => {
    const state = createDiscoveryNudgeState();
    expect(recordDiscoveryOutcome(state, 'ops_get_tool', 'k1', true)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_get_tool', 'k1', false)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_get_tool', 'k1', true)).toBeUndefined();
    expect(recordDiscoveryOutcome(state, 'ops_get_tool', 'k1', true)).toBe(DISCOVERY_NUDGE_TEXT);
  });
});

describe('canonicalArgsKey（参数规范化）', () => {
  it('键顺序无关；undefined 字段忽略；值不同则 key 不同', () => {
    expect(canonicalArgsKey({ query: 'ssh', limit: 5 })).toBe(
      canonicalArgsKey({ limit: 5, query: 'ssh' })
    );
    expect(canonicalArgsKey({ query: 'ssh', pluginId: undefined })).toBe(
      canonicalArgsKey({ query: 'ssh' })
    );
    expect(canonicalArgsKey({ query: 'ssh' })).not.toBe(canonicalArgsKey({ query: 'scp' }));
    // 嵌套结构同样稳定
    expect(canonicalArgsKey({ a: { y: 2, x: 1 }, b: [1, 2] })).toBe(
      canonicalArgsKey({ b: [1, 2], a: { x: 1, y: 2 } })
    );
  });
});

describe('isEmptyDiscoveryResult（空结果判定）', () => {
  it('ops_search_tools：total===0 为空', () => {
    expect(isEmptyDiscoveryResult('ops_search_tools', { total: 0, returned: 0, tools: [] })).toBe(
      true
    );
    expect(
      isEmptyDiscoveryResult('ops_search_tools', { total: 3, returned: 3, tools: [{}] })
    ).toBe(false);
  });

  it('ops_get_tool：NOT_FOUND 与 NOT_IN_LIVE_CATALOG 为空；正常 descriptor 非空', () => {
    expect(isEmptyDiscoveryResult('ops_get_tool', { error: 'NOT_FOUND', message: 'x' })).toBe(true);
    expect(
      isEmptyDiscoveryResult('ops_get_tool', {
        error: 'NOT_IN_LIVE_CATALOG',
        pluginId: 'at.terminal',
        healthy: false
      })
    ).toBe(true);
    expect(isEmptyDiscoveryResult('ops_get_tool', { name: 'list_ssh_servers' })).toBe(false);
  });

  it('其它工具 / 非对象结果一律非空', () => {
    expect(isEmptyDiscoveryResult('ops_list_providers', { providers: [] })).toBe(false);
    expect(isEmptyDiscoveryResult('ops_search_tools', 'oops')).toBe(false);
    expect(isEmptyDiscoveryResult('ops_search_tools', null)).toBe(false);
  });
});

describe('applyDiscoveryNudge（runtime 包装入口）', () => {
  const emptySearch = JSON.stringify({ total: 0, returned: 0, tools: [] });

  it('连续 2 次同参空 search → 第 2 次结果 JSON 附加 nudge，原字段保留', () => {
    const state = createDiscoveryNudgeState();
    const first = applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh' }, emptySearch);
    expect(JSON.parse(first)).toEqual({ total: 0, returned: 0, tools: [] });

    const second = applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh' }, emptySearch);
    const parsed = JSON.parse(second) as Record<string, unknown>;
    expect(parsed.total).toBe(0);
    expect(parsed.tools).toEqual([]);
    expect(parsed.nudge).toBe(DISCOVERY_NUDGE_TEXT);
    expect(String(parsed.nudge)).toContain('ops_select_tools');
    expect(String(parsed.nudge)).toContain('桥未就绪');
  });

  it('参数键顺序不同仍算同一调用（规范化）', () => {
    const state = createDiscoveryNudgeState();
    applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh', limit: 5 }, emptySearch);
    const second = applyDiscoveryNudge(
      state,
      'ops_search_tools',
      { limit: 5, query: 'ssh' },
      emptySearch
    );
    expect((JSON.parse(second) as Record<string, unknown>).nudge).toBe(DISCOVERY_NUDGE_TEXT);
  });

  it('换关键词后计数重置，不误伤新查询', () => {
    const state = createDiscoveryNudgeState();
    applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh' }, emptySearch);
    const other = applyDiscoveryNudge(state, 'ops_search_tools', { query: 'scp' }, emptySearch);
    expect((JSON.parse(other) as Record<string, unknown>).nudge).toBeUndefined();
  });

  it('get_tool 的 NOT_IN_LIVE_CATALOG 连续 2 次同名 → 附加 nudge', () => {
    const state = createDiscoveryNudgeState();
    const notLive = JSON.stringify({
      error: 'NOT_IN_LIVE_CATALOG',
      pluginId: 'at.terminal',
      healthy: false,
      next: { tool: 'ops_select_tools', args: { pluginIds: ['at.terminal'], mode: 'add' } }
    });
    applyDiscoveryNudge(state, 'ops_get_tool', { name: 'list_ssh_servers' }, notLive);
    const second = applyDiscoveryNudge(state, 'ops_get_tool', { name: 'list_ssh_servers' }, notLive);
    const parsed = JSON.parse(second) as Record<string, unknown>;
    expect(parsed.error).toBe('NOT_IN_LIVE_CATALOG');
    expect(parsed.next).toBeDefined();
    expect(parsed.nudge).toBe(DISCOVERY_NUDGE_TEXT);
  });

  it('命中结果（非空）不加 nudge 且重置计数', () => {
    const state = createDiscoveryNudgeState();
    applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh' }, emptySearch);
    const hit = JSON.stringify({ total: 1, returned: 1, tools: [{ name: 'list_ssh_servers' }] });
    const hitResult = applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh' }, hit);
    expect((JSON.parse(hitResult) as Record<string, unknown>).nudge).toBeUndefined();
    const emptyAgain = applyDiscoveryNudge(state, 'ops_search_tools', { query: 'ssh' }, emptySearch);
    expect((JSON.parse(emptyAgain) as Record<string, unknown>).nudge).toBeUndefined();
  });

  it('非发现工具 / 非 JSON 结果原样返回', () => {
    const state = createDiscoveryNudgeState();
    expect(applyDiscoveryNudge(state, 'ops_list_providers', {}, '{"providers":[]}')).toBe(
      '{"providers":[]}'
    );
    expect(applyDiscoveryNudge(state, 'ops_search_tools', { query: 'x' }, 'not-json')).toBe(
      'not-json'
    );
  });
});
