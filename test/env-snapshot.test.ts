/**
 * L-env 现场注入（docs/13 P0）：formatEnvSnapshot + composeSystemPrompt envLayer
 * + L0/L2 新契约（先 select，不对声明名 get_tool/search 空转）。
 */
import { describe, expect, it } from 'vitest';

import {
  ENV_SNAPSHOT_MAX_LINES,
  formatEnvSnapshot,
  type EnvSnapshotInput
} from '../src/prompts/env-snapshot';
import {
  L0_IDENTITY,
  L2_TOOL_DISCOVERY,
  composeSystemPrompt
} from '../src/prompts/layers';

function unhealthyTerminalInput(): EnvSnapshotInput {
  return {
    hostApp: 'vscode',
    catalogLiveToolCount: 0,
    exposed: [],
    providers: [
      {
        pluginId: 'at.terminal',
        displayName: 'AT Terminal',
        healthy: false,
        bridgeCount: 4,
        connectedTargets: 0,
        liveToolCount: 0,
        toolNames: [
          'list_ssh_servers',
          'get_terminal_context',
          'run_remote_command',
          'read_terminal_output',
          'sftp_read_file',
          'sftp_write_file',
          'sftp_list_dir',
          'open_terminal',
          'close_terminal',
          'resize_terminal',
          'send_terminal_input'
        ]
      }
    ]
  };
}

describe('formatEnvSnapshot（docs/13 §4.2）', () => {
  it('unhealthy at.terminal + 声明 list_ssh_servers + catalog=0 → 指向 select，禁止 get_tool 空转', () => {
    const snapshot = formatEnvSnapshot(unhealthyTerminalInput());

    expect(snapshot.startsWith('# L-env 现场（host 注入，不必再发现）')).toBe(true);
    expect(snapshot).toContain('at.terminal');
    expect(snapshot).toContain('list_ssh_servers');
    expect(snapshot).toContain('healthy=false');
    expect(snapshot).toContain('live catalog 工具数: 0');
    // 明确下一步：select，而不是继续发现
    expect(snapshot).toContain('ops_select_tools {pluginIds:["at.terminal"]}');
    expect(snapshot).toContain('禁止 ops_get_tool / ops_search_tools 空转');
    expect(snapshot).toContain('exposed 仍空则告知用户桥未就绪');
  });

  it('exposed 为空显示「无」；有 hint 时带 hint；行数 ≤ 软顶', () => {
    const input = unhealthyTerminalInput();
    input.hint = '巡检应 select at.terminal';
    const snapshot = formatEnvSnapshot(input);

    expect(snapshot).toContain('已暴露工具（exposed）: 无');
    expect(snapshot).toContain('hint: 巡检应 select at.terminal');
    expect(snapshot.split('\n').length).toBeLessThanOrEqual(ENV_SNAPSHOT_MAX_LINES);
  });

  it('健康且 live>0 的插件不触发「必须 select」尾注；exposed 名单原样列出', () => {
    const snapshot = formatEnvSnapshot({
      hostApp: 'vscode',
      catalogLiveToolCount: 11,
      exposed: ['list_ssh_servers', 'run_remote_command'],
      providers: [
        {
          pluginId: 'at.terminal',
          healthy: true,
          bridgeCount: 4,
          connectedTargets: 1,
          liveToolCount: 11,
          toolNames: ['list_ssh_servers', 'run_remote_command']
        }
      ]
    });
    expect(snapshot).toContain('list_ssh_servers, run_remote_command');
    expect(snapshot).not.toContain('下一步（必须）');
    expect(snapshot).not.toContain('禁止 ops_get_tool');
  });

  it('声明工具超过 8 个只展示前 8 个并标注总数', () => {
    const snapshot = formatEnvSnapshot(unhealthyTerminalInput());
    expect(snapshot).toContain('共 11 个');
    expect(snapshot).not.toContain('send_terminal_input');
  });
});

describe('composeSystemPrompt · envLayer（docs/13 §4.2）', () => {
  it('L0 → envLayer → playbookLayer 相对顺序；空白层被忽略', () => {
    const prompt = composeSystemPrompt({ envLayer: 'X-ENV-LAYER', playbookLayer: 'Y-PB-LAYER' });
    const l0At = prompt.indexOf(L0_IDENTITY);
    const envAt = prompt.indexOf('X-ENV-LAYER');
    const pbAt = prompt.indexOf('Y-PB-LAYER');
    expect(l0At).toBeGreaterThanOrEqual(0);
    expect(envAt).toBeGreaterThan(l0At);
    expect(pbAt).toBeGreaterThan(envAt);

    expect(composeSystemPrompt({ envLayer: '   ' })).toBe(composeSystemPrompt());
  });
});

describe('L0/L2 新契约（docs/13 §4.3）', () => {
  it('L2 不再要求调用前先 ops_get_tool 确认参数', () => {
    expect(L2_TOOL_DISCOVERY).not.toContain('先确认参数');
    expect(L2_TOOL_DISCOVERY).not.toContain('先看清参数');
  });

  it('L2：providers/L-env 后立刻 select；get_tool 仅限 live catalog；同工具连败即停', () => {
    expect(L2_TOOL_DISCOVERY).toContain('立刻 ops_select_tools');
    expect(L2_TOOL_DISCOVERY).toContain('live catalog 里已存在');
    expect(L2_TOOL_DISCOVERY).toContain('不要 get_tool——直接 select');
    expect(L2_TOOL_DISCOVERY).toContain('只在工具名完全未知');
    expect(L2_TOOL_DISCOVERY).toContain('连续 2 次空结果/失败');
    expect(L2_TOOL_DISCOVERY).toContain('桥未就绪');
  });

  it('L0 不再要求 select 前调用 list_ssh_servers；改为先读 L-env → select → 一等工具名', () => {
    expect(L0_IDENTITY).not.toContain('对健康的 at.terminal 调用 list_ssh_servers');
    expect(L0_IDENTITY).toContain('L-env');
    expect(L0_IDENTITY).toContain('ops_select_tools');
    // select 出现在 list_ssh_servers 之前：声明工具不是已可调用的工具面
    expect(L0_IDENTITY.indexOf('ops_select_tools')).toBeLessThan(
      L0_IDENTITY.indexOf('list_ssh_servers')
    );
    expect(L0_IDENTITY).toContain('healthy:false ≠ 没有这个插件');
  });
});
