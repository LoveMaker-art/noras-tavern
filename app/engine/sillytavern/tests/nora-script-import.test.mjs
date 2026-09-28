import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareScriptImport } from '../public/scripts/nora-controls/script-import.js';

test('Helper script/folder export keeps code, buttons, data and child states but disables root and replaces IDs', () => {
    let id = 0;
    const child = { type: 'script', id: 'nora-mvu-headless-runtime', enabled: true, name: 'Map', content: 'notExecuted()', info: 'info',
        button: { enabled: false, buttons: [{ name: 'Go', visible: false }] }, data: { a: [1, 2] }, export_with: { data: false, button: true } };
    const input = { type: 'folder', enabled: true, id: 'folder', name: 'Maps', color: '#ffffff', icon: 'fa-map', scripts: [child] };
    const result = prepareScriptImport(input, () => String(++id));
    assert.equal(result.enabled, false);
    assert.equal(result.id, '1');
    assert.equal(result.scripts[0].id, '2');
    assert.equal(result.scripts[0].enabled, true);
    assert.deepEqual(result.scripts[0], { ...child, id: '2' });
    result.scripts[0].data.a.push(3);
    assert.deepEqual(input.scripts[0].data.a, [1, 2]);
    assert.equal(prepareScriptImport(child).enabled, false);
});

test('legacy standalone Helper export converts buttons without losing data', () => {
    const result = prepareScriptImport({ name: 'Old', enabled: true, content: 'code', buttons: [{ name: 'Go', visible: true }], data: { x: 2 } });
    assert.equal(result.type, 'script');
    assert.equal(result.enabled, false);
    assert.deepEqual(result.button, { enabled: true, buttons: [{ name: 'Go', visible: true }] });
    assert.deepEqual(result.data, { x: 2 });
});

test('malformed files/cards/unsupported trees fail before any write', () => {
    for (const input of [null, [], {}, { spec: 'chara_card_v3', data: {} }, { type: 'script', content: {} },
        { type: 'folder', scripts: [{ type: 'folder', scripts: [] }] },
        { type: 'script', content: 'x', button: { buttons: [null] } },
        { type: 'script', content: 'x', enabled: 'yes' }]) {
        assert.throws(() => prepareScriptImport(input), { code: 'NORA_SCRIPT_IMPORT_INVALID' });
    }
});
