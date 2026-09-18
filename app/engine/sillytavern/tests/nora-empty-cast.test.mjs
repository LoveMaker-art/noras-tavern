import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelController } from '../../../native-extensions/nora-ui/panel-controller.js';

function fixture(description = '') {
    const body = { innerHTML: '' };
    let edit;
    const opened = [];
    const card = { name: 'World card', description };
    const panel = createPanelController({
        select: () => body,
        selectAll: selector => selector === '[data-edit-section="cast"]'
            ? [{ addEventListener: (_event, handler) => { edit = handler; } }] : [],
        escapeHtml: String, icons: {}, settings: () => ({}),
        readState: () => ({ activeCharacterId: 0 }),
        activeWorldModel: () => ({ id: 'world', storyContext: { characters: [] } }),
        currentCharacter: () => card, characterField: (value, key) => value?.[key],
        currentWorldPersona: () => ({}), worldbookSummary: () => '', worldbookController: { open() {} },
        closeDrawers() {}, openCharacterEditor: id => opened.push(id),
    });
    panel.render();
    return { body, panel, opened, edit: () => edit({ stopPropagation() {} }) };
}

test('empty cast has no whole-card editor and keeps the add-character route', () => {
    const f = fixture();
    assert.doesNotMatch(f.body.innerHTML, /data-cast-edit=/);
    f.edit();
    assert.doesNotMatch(f.body.innerHTML, /data-cast-edit=|emptyEditRow/);
    assert.match(f.body.innerHTML, /data-action="add-character"/);
    f.panel.runAction('add-character');
    assert.deepEqual(f.opened, ['new-world-character']);
    f.edit();
    assert.doesNotMatch(f.body.innerHTML, /data-action="add-character"/);
});

test('nonempty legacy card profile retains its editor and injection switch', () => {
    const f = fixture('Existing character profile');
    f.edit();
    assert.match(f.body.innerHTML, /data-cast-edit="0"/);
    assert.match(f.body.innerHTML, /data-cast-toggle="card-profile"/);
});
