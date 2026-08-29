/**
 * Plan 02 T5：能力插件桥断开 / 恢复 notice。
 * removed ∩ 当前 selected → emit；added ∩ 曾选 → 对偶 emit。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback
    })
  }
}));

import {
  ConfigService,
  diffCatalogSelectionNotices
} from '../src/host/services/configService';
import type { HostContext } from '../src/host/services/context';

describe('diffCatalogSelectionNotices', () => {
  it('removed ∩ selected → disconnected; added ∩ previouslySelected → restored', () => {
    const first = diffCatalogSelectionNotices({
      previousNames: new Set(['keep', 'grafana_query', 'unselected']),
      currentNames: ['keep'],
      selected: ['grafana_query', 'keep'],
      previouslySelected: new Set()
    });
    expect(first.disconnected).toEqual(['grafana_query']);
    expect(first.restored).toEqual([]);
    expect([...first.nextPreviouslySelected]).toEqual(['grafana_query']);

    const second = diffCatalogSelectionNotices({
      previousNames: new Set(['keep']),
      currentNames: ['keep', 'grafana_query', 'brand_new'],
      selected: [],
      previouslySelected: first.nextPreviouslySelected
    });
    expect(second.disconnected).toEqual([]);
    expect(second.restored).toEqual(['grafana_query']);
    expect([...second.nextPreviouslySelected]).toEqual([]);
  });
});

describe('ConfigService.handleToolCatalogChange · 断桥 notice', () => {
  function makeService(opts: {
    tools: Array<{ name: string; pluginId: string }>;
    selected: string[];
    emit: (text: string) => void;
  }): ConfigService {
    const ctx = {
      hub: {
        listAllTools: () => opts.tools,
        listExposedTools: () => opts.tools,
        selection: {
          state: () => ({
            selected: opts.selected,
            mode: 'auto',
            threshold: 20,
            exposedBusinessToolCount: opts.tools.length,
            idleMs: 0,
            maxCalls: 0
          }),
          select: async () => ({ selected: opts.selected, exposed: opts.tools.map((t) => t.name) })
        }
      },
      log: () => {},
      emitAssistantNotice: opts.emit
    } as unknown as HostContext;
    return new ConfigService(ctx);
  }

  it('removed ∩ selected → emit 断桥 notice；恢复 added ∩ 曾选 → 对偶 notice', () => {
    const catalog: Array<{ name: string; pluginId: string }> = [
      { name: 'grafana_query', pluginId: 'at.grafana' },
      { name: 'grafana_list_instances', pluginId: 'at.grafana' }
    ];
    const selected = ['grafana_query'];
    const emit = vi.fn();
    const svc = makeService({ tools: catalog, selected, emit });

    svc.handleToolCatalogChange();
    expect(emit).not.toHaveBeenCalled();

    catalog.splice(0, catalog.length);
    svc.handleToolCatalogChange();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('能力插件桥断开，1 个工具暂不可用');

    catalog.push({ name: 'grafana_query', pluginId: 'at.grafana' });
    selected.length = 0;
    svc.handleToolCatalogChange();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('能力插件桥已恢复，1 个工具重新可用');
  });

  it('未选中的工具离线不发 notice', () => {
    const catalog = [{ name: 'other_tool', pluginId: 'at.other' }];
    const emit = vi.fn();
    const svc = makeService({ tools: catalog, selected: ['grafana_query'], emit });
    svc.handleToolCatalogChange();
    catalog.splice(0, catalog.length);
    svc.handleToolCatalogChange();
    expect(emit).not.toHaveBeenCalled();
  });
});
