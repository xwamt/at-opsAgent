/**
 * modelsCatalog 单测：设置保存后聊天模型选择器的数据源
 * （listConfiguredModelsFromJson / listConfiguredModels / readLastModel /
 * pickSelectedModel）。不 import vscode，node 环境直测。
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listConfiguredModels,
  listConfiguredModelsFromJson,
  pickSelectedModel,
  readLastModel,
  type ConfiguredModel
} from '../src/host/modelsCatalog';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'models-catalog-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('listConfiguredModelsFromJson（models.json 根对象 → 选择器清单）', () => {
  it('多 provider 多 model：全部展开，label 优先 name、缺省回退 id', () => {
    const models = listConfiguredModelsFromJson({
      providers: {
        'internal-gateway': {
          baseUrl: 'https://llm.example.internal/v1',
          models: [
            { id: 'qwen3-max', name: 'Qwen3 Max', thinking: true },
            { id: 'qwen3-coder' }
          ]
        },
        anthropic: {
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }]
        }
      }
    });
    expect(models).toEqual([
      { provider: 'internal-gateway', model: 'qwen3-max', label: 'Qwen3 Max' },
      { provider: 'internal-gateway', model: 'qwen3-coder', label: 'qwen3-coder' },
      { provider: 'anthropic', model: 'claude-sonnet-4', label: 'Claude Sonnet 4' }
    ]);
  });

  it('脏数据（非对象条目 / 空 id / 空白 name）跳过而不是抛错', () => {
    const models = listConfiguredModelsFromJson({
      providers: {
        p1: {
          models: [
            'not-an-object',
            { id: '' },
            { id: '   ' },
            { name: 'no-id' },
            { id: ' m1 ', name: '   ' }
          ]
        },
        p2: { models: 'not-an-array' },
        p3: 'not-a-record'
      }
    });
    // id 两侧空白裁剪；name 全空白时回退 id 作 label。
    expect(models).toEqual([{ provider: 'p1', model: 'm1', label: 'm1' }]);
  });

  it('模型条目带 reasoning（新字段）或旧 thinking 都不影响清单解析', () => {
    const models = listConfiguredModelsFromJson({
      providers: {
        gw: {
          models: [
            { id: 'qwen3-max', name: 'Qwen3 Max', reasoning: true },
            { id: 'legacy-model', thinking: true }
          ]
        }
      }
    });
    expect(models).toEqual([
      { provider: 'gw', model: 'qwen3-max', label: 'Qwen3 Max' },
      { provider: 'gw', model: 'legacy-model', label: 'legacy-model' }
    ]);
  });

  it('根不是对象 / 缺 providers → []', () => {
    expect(listConfiguredModelsFromJson(null)).toEqual([]);
    expect(listConfiguredModelsFromJson([])).toEqual([]);
    expect(listConfiguredModelsFromJson('providers')).toEqual([]);
    expect(listConfiguredModelsFromJson({})).toEqual([]);
    expect(listConfiguredModelsFromJson({ providers: [] })).toEqual([]);
  });
});

describe('listConfiguredModels（读盘路径）', () => {
  it('文件缺失 → []（不抛错，选择器显示空态）', () => {
    const dir = makeTempDir();
    expect(listConfiguredModels(join(dir, 'does-not-exist.json'))).toEqual([]);
  });

  it('坏 JSON → []', () => {
    const dir = makeTempDir();
    const file = join(dir, 'models.json');
    writeFileSync(file, '{ providers: 不是合法 JSON', 'utf8');
    expect(listConfiguredModels(file)).toEqual([]);
  });

  it('合法文件 → 与 listConfiguredModelsFromJson 一致', () => {
    const dir = makeTempDir();
    const file = join(dir, 'models.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: { gw: { models: [{ id: 'qwen3-max', name: 'Qwen3 Max' }] } }
      }),
      'utf8'
    );
    expect(listConfiguredModels(file)).toEqual([
      { provider: 'gw', model: 'qwen3-max', label: 'Qwen3 Max' }
    ]);
  });
});

describe('readLastModel（agentDir/settings.json 的上次选择）', () => {
  it('settings.json 缺失 → undefined', () => {
    expect(readLastModel(makeTempDir())).toBeUndefined();
  });

  it('坏 JSON / 缺 lastModel / 字段为空 → undefined', () => {
    const dir = makeTempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'not json', 'utf8');
    expect(readLastModel(dir)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ thinkingLevel: 'medium' }), 'utf8');
    expect(readLastModel(dir)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ lastModel: { provider: '', model: 'm' } }), 'utf8');
    expect(readLastModel(dir)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ lastModel: { provider: 'p', model: '  ' } }), 'utf8');
    expect(readLastModel(dir)).toBeUndefined();
  });

  it('合法 lastModel → { provider, model }（两侧空白裁剪）', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ lastModel: { provider: ' gw ', model: ' qwen3-max ' } }),
      'utf8'
    );
    expect(readLastModel(dir)).toEqual({ provider: 'gw', model: 'qwen3-max' });
  });
});

describe('pickSelectedModel（上次选择 vs 清单第一项）', () => {
  const catalog: ConfiguredModel[] = [
    { provider: 'gw', model: 'qwen3-max', label: 'Qwen3 Max' },
    { provider: 'gw', model: 'qwen3-coder', label: 'qwen3-coder' },
    { provider: 'anthropic', model: 'claude-sonnet-4', label: 'Claude Sonnet 4' }
  ];

  it('preferred 仍在清单里 → 保留 preferred（非首项也保留）', () => {
    expect(
      pickSelectedModel(catalog, { provider: 'anthropic', model: 'claude-sonnet-4' })
    ).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
  });

  it('preferred 已不在清单（模型被删 / provider 改名）→ 回落到第一项', () => {
    expect(pickSelectedModel(catalog, { provider: 'gw', model: 'removed-model' })).toEqual({
      provider: 'gw',
      model: 'qwen3-max'
    });
    // provider+model 必须同时命中；只 model 同名不算命中。
    expect(
      pickSelectedModel(catalog, { provider: 'renamed', model: 'claude-sonnet-4' })
    ).toEqual({ provider: 'gw', model: 'qwen3-max' });
  });

  it('无 preferred → 第一项；空清单 → undefined', () => {
    expect(pickSelectedModel(catalog, undefined)).toEqual({ provider: 'gw', model: 'qwen3-max' });
    expect(pickSelectedModel([], { provider: 'gw', model: 'qwen3-max' })).toBeUndefined();
    expect(pickSelectedModel([], undefined)).toBeUndefined();
  });
});
