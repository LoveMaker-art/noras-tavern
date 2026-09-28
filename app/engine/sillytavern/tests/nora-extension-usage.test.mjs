import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptUsage, regexUsage } from '../../../native-extensions/nora-ui/extension-usage.js';

test('script usage respects scope consent, individual switches, parent folders and managed core exclusion', () => {
    const trees = [
        { id: 'nora-mvu-headless-runtime', enabled: true },
        { id: 'a', enabled: true }, { id: 'b', enabled: false },
        { type: 'folder', enabled: false, scripts: [{ id: 'c', enabled: true }] },
        { type: 'folder', enabled: true, scripts: [{ id: 'd', enabled: true }] },
    ];
    assert.deepEqual(scriptUsage({ trees, enabled: true }), { total: 4, enabled: 2 });
    assert.deepEqual(scriptUsage({ trees, enabled: false }), { total: 4, enabled: 0 });
    assert.deepEqual(scriptUsage({ trees }), { total: 4, enabled: 0 });
    assert.deepEqual(scriptUsage({ trees: [trees[0]], enabled: true }), { total: 0, enabled: 0 });
});

test('preset, world and global regex permissions count only allowed enabled rules', () => {
    assert.deepEqual(regexUsage([
        { scope: 'character', scripts: [{ disabled: false }], allowed: false },
        { scope: 'preset', scripts: [{ disabled: false }, { disabled: true }], allowed: true },
        { scope: 'global', scripts: [{ disabled: false }], allowed: true },
    ]), { total: 4, enabled: 2 });
    assert.deepEqual(regexUsage([{ scripts: [{}] }]), { total: 1, enabled: 0 });
});
