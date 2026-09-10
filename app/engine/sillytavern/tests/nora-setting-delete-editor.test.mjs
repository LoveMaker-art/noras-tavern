import assert from 'node:assert/strict';
import test from 'node:test';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';
import { createStoryContext, editStoryCharacter } from '../public/scripts/nora-worlds/story-context.js';

for (const type of ['legacy', 'character', 'scenario', 'worldbook']) {
    test(`${type}: delete is first in the persistent toolbar and calls the existing guarded mutation`, async () => {
        const nodes = new Map();
        const element = selector => {
            if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', value: 'constant', handlers: {},
                addEventListener(name, fn) { this.handlers[name] = fn; },
                querySelector: element, classList: { toggle() {} },
            });
            return nodes.get(selector);
        };
        if (type === 'legacy') element('#nora-character-form').querySelector = key => key === '[data-character-trigger]' ? null : element(key);
        const card = { name: 'Original', data: { description: 'Profile', scenario: 'Background', extensions: { world: 'book' } } };
        const context = editStoryCharacter(createStoryContext(), { id: 'alice', operation: 'create', patch: { name: 'Alice' } });
        const world = { id: 'world:a', revision: 4, storyContext: context };
        const book = { entries: { 0: { comment: 'Rule', content: 'Details', constant: true } } };
        let html = ''; let closed = 0; const mutations = [];
        const deps = {
            activeWorldModel: () => world, readState: () => ({ activeCharacterId: 0, characters: [card], world: { metadata: { nora_world: { id: world.id } } } }),
            currentCharacter: () => card, characterField: (c, key) => c.data?.[key] || '',
            select: element, selectAll: () => [], escapeHtml: String, icons: {},
            operations: { isBusy: () => false, run: async (_key, fn) => fn() },
            dialogs: { open: (_title, content) => { html = content; return {}; }, close: () => closed++,
                confirm: async options => { assert.equal(options.restoreSheet, true); return true; }, toast() {}, normalizeError: e => e.message },
            reloadWorlds: async () => {}, refresh() {}, onChanged() {},
            updateWorld: async patch => mutations.push(patch), worldRuntime: { updateActive: async patch => mutations.push(patch) },
            store: { cachedWorldbook: () => book, cacheWorldbook() {} },
            worldbook: { loadWorldbook: async () => book, saveWorldbookEntry: async (...args) => {
                mutations.push(args); return { book: { entries: {} }, resource: { binding: { name: 'book' } } };
            } },
        };
        if (type === 'legacy' || type === 'character') {
            createCharacterController(deps).openEditor(type === 'legacy' ? 0 : 'world-character:alice');
            assert.ok(html.indexOf('data-delete-character') > html.indexOf('nora-editor-toolbar'));
            assert.ok(html.indexOf('data-delete-character') < html.indexOf('data-cancel-character'));
            assert.ok(html.indexOf('data-cancel-character') < html.indexOf('type="submit"'));
            assert.match(html, /nora-editor-fields/);
            await element('[data-delete-character]').handlers.click({ currentTarget: element('[data-delete-character]') });
            assert.deepEqual(mutations, [type === 'legacy' ? { removeSetting: 'card-profile' } : { character: { id: 'alice', operation: 'delete' } }]);
        } else {
            await createWorldbookController(deps).openEntryEditor(type === 'scenario' ? 'scenario' : 'embedded', '0');
            html = element('.nora-sheet-body').innerHTML;
            assert.ok(html.indexOf('data-delete-setting') > html.indexOf('nora-editor-toolbar'));
            assert.ok(html.indexOf('data-delete-setting') < html.indexOf('data-cancel-setting'));
            assert.ok(html.indexOf('data-cancel-setting') < html.indexOf('type="submit"'));
            assert.match(html, /nora-editor-fields/);
            await element('[data-delete-setting]').handlers.click({ currentTarget: element('[data-delete-setting]') });
            if (type === 'scenario') assert.deepEqual(mutations, [{ removeSetting: 'scenario' }]);
            else assert.equal(mutations[0][5].operation, 'delete');
        }
        assert.equal(mutations.length, 1);
        assert.equal(closed, 1);
    });
}
