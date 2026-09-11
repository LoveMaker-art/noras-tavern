import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createPanelController } from '../../../native-extensions/nora-ui/panel-controller.js';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';

function fixture() {
    let $;
    const nodes = new WeakMap();
    function wrap(el) {
        if (!el) return null;
        if (nodes.has(el)) return nodes.get(el);
        const node = {
            el, handlers: {}, classList: { toggle() {}, add() {}, remove() {} },
            get dataset() { return Object.fromEntries(Object.entries(el.attribs || {}).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); },
            get value() { return $(el).val(); }, set value(value) { $(el).val(value); },
            get innerHTML() { return $(el).html(); }, set innerHTML(value) { $(el).html(value); },
            addEventListener(type, fn) { this.handlers[type] = fn; },
            querySelector(selector) { return select(selector, node); },
            insertAdjacentHTML(position, markup) {
                assert.equal(position, 'beforeend', 'Library actions must append beside the existing label');
                $(el).append(markup);
            },
        };
        nodes.set(el, node); return node;
    }
    const select = (selector, root) => wrap((root?.el ? $(root.el).find(selector) : $(selector))[0]);
    const selectAll = (selector, root) => (root?.el ? $(root.el).find(selector) : $(selector)).toArray().map(wrap);
    const errors = [], picked = [], world = { id: 'world:a', revision: 1 };
    const common = {
        dialogs: { open: (_title, markup) => { $ = load(`<main><div class="nora-sheet-body">${markup}</div></main>`); return wrap($('main')[0]); },
            toast: value => errors.push(value), close() {}, normalizeError: error => error.message },
        select, selectAll, escapeHtml: String, icons: {}, activeWorldModel: () => world,
        operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        characterField: (card, key) => card?.data?.[key] || '',
        openProfileLibrary: (...args) => picked.push(args), openLibrary: (...args) => picked.push(args),
    };
    function field(selector, inputId) {
        const action = $(selector);
        assert.equal(action.length, 1);
        const heading = action.closest('.nora-library-heading');
        assert.equal(heading.length, 1);
        assert.equal(heading.children(`label[for="${inputId}"]`).length, 1);
        assert.equal(heading.parent().children(`input#${inputId}`).length, 1);
        assert.equal(action.closest('label').length, 0, 'An action must not be nested in the input label');
        assert.equal(action.attr('type'), 'button');
    }
    function back(selector, backSelector) {
        const action = $(selector);
        assert.equal(action.length, 1);
        assert.equal(action.closest('.nora-library-heading').children(backSelector).length, 1);
    }
    return { common, select, picked, world, field, back, errors, query: selector => $(selector) };
}

test('persona library actions share the name label row and preserve the current-world save', async () => {
    const f = fixture();
    createPanelController({ ...f.common, currentWorldPersona: () => ({ name: 'Player', description: 'Identity' }) }).openPersona();
    f.field('[data-pick-persona]', 'nora-persona-name');
    f.field('[data-save-persona]', 'nora-persona-name');
    assert.equal(f.query('#nora-persona-form > button[type="submit"]').length, 1);
    f.select('[data-pick-persona]').handlers.click();
    assert.deepEqual(f.picked, [['persona', f.world]]);
});

test('new role library actions share the name label row without moving the editor footer', () => {
    const f = fixture();
    createCharacterController({ ...f.common, readState: () => ({}), settings: () => ({}) }).openEditor('new-world-character');
    f.field('[data-pick-role]', 'nora-character-name');
    f.field('[data-save-role]', 'nora-character-name');
    assert.equal(f.query('.nora-editor-toolbar [data-cancel-character]').length, 1);
    assert.equal(f.query('.nora-editor-toolbar button[type="submit"]').length, 1);
    f.select('[data-pick-role]').handlers.click();
    assert.deepEqual(f.picked, [['character', f.world]]);
});

test('worldbook import shares the title row; whole-book and entry saves share their back rows', async () => {
    const f = fixture();
    const book = { name: 'Lore', entries: { '0': { comment: 'Rule', content: 'Content', constant: true, key: [] } } };
    const controller = createWorldbookController({ ...f.common,
        readState: () => ({ world: { metadata: { nora_world: { id: f.world.id } } } }),
        currentCharacter: () => ({ data: { extensions: { world: 'Lore' } } }),
        worldbook: { loadWorldbook: async () => book }, store: { cacheWorldbook() {}, cachedWorldbook: () => book },
    });
    controller.openAdd();
    f.field('[data-pick-book]', 'nora-setting-title');
    f.select('[data-pick-book]').handlers.click();
    assert.deepEqual(f.picked, [[f.world]]);
    await controller.openNamed('Lore');
    f.back('[data-save-whole-book]', '[data-back-world-settings]');
    await controller.openEntryEditor('embedded', '0');
    f.back('[data-save-entry-library]', '[data-back-entries]');
    assert.equal(f.query('.nora-editor-toolbar [data-delete-setting]').length, 1);
    assert.equal(f.query('.nora-editor-toolbar button[type="submit"]').length, 1);
    assert.deepEqual(f.errors, []);
});
