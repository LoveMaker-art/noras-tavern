import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinPlugins, pluginCatalog, pluginLibraryStatus, ledgerPhase } from '../public/scripts/nora-controls/plugin-catalog.js';

test('one ordered catalog keeps missing and disabled builtins visible and excludes infrastructure', () => {
    const items = pluginCatalog([{ name: 'third-party/z', type: 'local' }, { name: 'memory', type: 'system' },
        { name: 'third-party/nora-ui', managed: true }, { name: 'third-party/a', type: 'global' },
        { name: 'third-party/nora-ledger', libraryEnabled: false }]);
    assert.deepEqual(items.slice(0, 5).map(item => item.name), Object.keys(builtinPlugins));
    assert.deepEqual(items.slice(5).map(item => item.name), ['third-party/a', 'third-party/z']);
    assert.equal(items[3].builtin.title, '剧情账本');
    assert.equal(pluginLibraryStatus(items[0]), '组件缺失');
    assert.equal(pluginLibraryStatus(items[3]), '已停用');
});

test('missing observations never imply loaded, healthy, or enabled session tasks', () => {
    assert.equal(pluginLibraryStatus({}), '加载状态未读取');
    assert.equal(pluginLibraryStatus({ runtimeReadFailed: true }), '加载状态读取失败');
    assert.equal(pluginLibraryStatus({}, { enabled: true, loaded: true }), '本页已加载');
    assert.equal(ledgerPhase({ enabled: true, taskPhase: 'paused' }), '失败暂停');
    assert.equal(ledgerPhase({ enabled: false }), '已关闭');
});
