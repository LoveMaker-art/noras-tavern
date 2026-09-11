import assert from 'node:assert/strict';
import test from 'node:test';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createStCardAdapter } from '../public/scripts/nora-adapters/st-card-adapter.js';

function fixture(options = {}) {
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
        return nodes.get(selector);
    };
    let markup = ''; let modalClass = ''; let world = { id: 'world:a', name: 'Target' }; let generating = false;
    const imported = []; const created = []; const roles = []; const deleted = []; const toasts = [];
    const characters = [{ name: 'Alice', avatar: 'alice.png', data: { description: 'Long description', creator: 'Author' } }];
    const controller = createCharacterController({
        listLibraryCards: options.listLibraryCards,
        cards: { refreshCharacters: async () => {}, importLibraryCard: async file => imported.push(file),
            deleteCharacterCards: async input => deleted.push(input) },
        operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        dialogs: { open: (_title, content, css) => { markup = content; modalClass = css; return {}; },
            confirm: async () => true, close() {}, toast: value => toasts.push(value), normalizeError: error => error.message },
        readState: () => ({ characters }), settings: () => ({}), characterField: (card, field) => card.data?.[field] || '',
        characterCapabilities: () => ({ regexScripts: [], helperScripts: [] }), worldbookEntries: () => [],
        select: node, selectAll: () => [], escapeHtml: value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
        icons: {}, reloadWorlds: async () => {}, refresh() {}, isCharacterInWorld: () => Boolean(world),
        createWorldFromCard: card => created.push(card), addRoleFromCard: card => roles.push(card),
        activeWorldModel: () => world, isGenerating: () => generating,
    });
    return { controller, characters, node, imported, created, roles, deleted, toasts, markup: () => markup, css: () => modalClass,
        setWorld: value => { world = value; }, setGenerating: value => { generating = value; } };
}

test('card list and detail share frame; deletion stays in detail and protects in-use cards', async () => {
    const f = fixture();
    await f.controller.openLibrary();
    assert.match(f.css(), /nora-world-library-modal/);
    assert.match(f.markup(), /data-library-search/);
    assert.match(f.markup(), /data-library-import/);
    assert.doesNotMatch(f.markup(), /data-library-delete/);
    f.controller.openSheet(0, true);
    assert.match(f.css(), /nora-world-library-modal/);
    assert.match(f.markup(), /<details class="nora-library-book-entry"><summary>[^<]+<\/summary><p>Long description/);
    assert.match(f.markup(), /nora-library-footer/);
    assert.match(f.markup(), /目标世界：Target/);
    assert.match(f.markup(), /data-library-delete type="button" disabled/);
    await f.node('[data-library-delete]').handlers.click();
    assert.equal(f.deleted.length, 0);
    f.node('[data-card-create-world]').handlers.click({ currentTarget: {} });
    f.node('[data-card-add-role]').handlers.click();
    assert.equal(f.created.length, 1);
    assert.equal(f.roles.length, 1);
    f.setWorld(null);
    f.controller.openSheet(0, true);
    assert.match(f.markup(), /data-card-add-role type="button" disabled/);
    await f.node('[data-library-delete]').handlers.click();
    assert.deepEqual(f.deleted, [{ avatars: ['alice.png'], deleteChats: true }]);
});

test('backend catalog excludes runtime copies even when cards are shallow, and preserves distinct originals', async () => {
    const f = fixture({ listLibraryCards: async () => ({ items: [{ avatar: 'alice.png' }, { avatar: 'other-cover.png' }] }) });
    f.characters[0].shallow = true;
    f.characters.push({ ...f.characters[0], avatar: 'other-cover.png' }, { ...f.characters[0], avatar: 'alice--nora-0123456789.png' });
    await f.controller.openLibrary();
    assert.equal((f.markup().match(/data-library-character=/g) || []).length, 2);
    assert.doesNotMatch(f.markup(), /nora-card-duplicate|alice--nora-/);
    for (const character of f.characters) character.shallow = false;
    await f.controller.openLibrary();
    assert.equal((f.markup().match(/data-library-character=/g) || []).length, 2);
});

test('library-only card import blocks generation and does not create or activate a world', async () => {
    const f = fixture();
    await f.controller.openLibrary();
    f.node('[data-library-import]').handlers.click();
    const form = f.node('[data-card-import-form]');
    const file = new File(['card'], 'alice.png');
    form.elements = { file: { files: [file] } };
    f.setGenerating(true);
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(f.imported.length, 0);
    f.setGenerating(false);
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(f.imported[0], file);
    assert.equal(f.created.length, 0);
    assert.equal(f.roles.length, 0);
});

test('native store-only import uses multipart and CSRF, rejects invalid files and HTTP-200 errors', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const requests = [];
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); return Response.json({ file_name: 'alice' }); };
    const adapter = createStCardAdapter(() => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-token' }) }));
    const file = new File(['card'], 'ALICE.PNG');
    await adapter.importLibraryCard(file);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/nora-worlds-v2/library/cards/import');
    assert.equal(requests[0].init.headers.get('Content-Type'), null);
    assert.equal(requests[0].init.headers.get('X-CSRF-Token'), 'fixture-token');
    assert.equal(requests[0].init.body.get('file_type'), 'png');
    assert.equal(requests[0].init.body.get('avatar').name, 'ALICE.PNG');
    assert.equal(requests[0].init.body.has('preserved_name'), false);
    await assert.rejects(adapter.importLibraryCard(new File(['x'], 'bad.exe')));
    await assert.rejects(adapter.importLibraryCard(new File([], 'empty.png')));
    await assert.rejects(adapter.importLibraryCard({ name: 'big.png', size: 33 * 1024 * 1024 }));
    assert.equal(requests.length, 1);
    globalThis.fetch = async () => Response.json({ error: true });
    await assert.rejects(adapter.importLibraryCard(file), /无法识别/);
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(adapter.importLibraryCard(file), /403/);
});
