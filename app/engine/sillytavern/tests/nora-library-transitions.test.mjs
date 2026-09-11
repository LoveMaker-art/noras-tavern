import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryController } from '../../../native-extensions/nora-ui/library-controller.js';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture() {
    const pending = [], renders = [], errors = [];
    const node = { addEventListener() {}, remove() {} };
    const dialogs = {
        version: 0,
        open(title, markup, className, options) {
            this.version++;
            renders.push({ title, markup, className, options });
            return {};
        },
        close() { this.version++; },
        toast: error => errors.push(error), normalizeError: error => error.message,
    };
    const load = () => { const request = deferred(); pending.push(request); return request.promise; };
    const shared = { dialogs, operations: { isBusy: () => false }, activeWorldModel: () => null,
        isGenerating: () => false, select: () => node, selectAll: () => [], escapeHtml: String };
    const library = createLibraryController({ ...shared, worlds: { listLibraryProfiles: load, listLibraryWorldbooks: load } });
    const cards = createCharacterController({ ...shared, cards: { refreshCharacters: load },
        readState: () => ({ characters: [] }), characterField: () => '', icons: {} });
    return { library, cards, dialogs, pending, renders, errors };
}

test('a slower role response cannot replace the subsequently selected worldbooks', async () => {
    const f = fixture();
    const role = f.library.openProfiles('character');
    const books = f.library.openWorldbooks();
    f.pending[1].resolve({ items: [], warnings: [] });
    await books;
    f.pending[0].resolve({ items: [], warnings: [] });
    await role;
    assert.equal(f.renders.length, 1);
    assert.match(f.renders[0].markup, /data-book-search/);
});

for (const action of ['close', 'other-dialog']) {
    test(`pending library reads cannot reopen after ${action}`, async () => {
        const f = fixture();
        const request = f.library.openProfiles('persona');
        if (action === 'close') f.dialogs.close();
        else f.dialogs.open('Editor', '<form></form>');
        const before = f.renders.length;
        f.pending[0].resolve({ items: [], warnings: [] });
        await request;
        assert.equal(f.renders.length, before);
    });
}

test('world cards and profiles share the same navigation request ordering', async () => {
    const f = fixture();
    const cards = f.cards.openLibrary();
    const role = f.library.openProfiles('persona');
    f.pending[1].resolve({ items: [], warnings: [] });
    await role;
    f.pending[0].resolve();
    await cards;
    assert.equal(f.renders.length, 1);
    assert.match(f.renders[0].markup, /data-profile-search/);
});

test('stale read errors do not interrupt the current category', async () => {
    const f = fixture();
    const role = f.library.openProfiles('character');
    const books = f.library.openWorldbooks();
    f.pending[1].resolve({ items: [], warnings: [] });
    await books;
    f.pending[0].reject(new Error('Old request failed'));
    await role;
    assert.deepEqual(f.errors, []);
});

test('list navigation requests a stable shell, but a contextual picker does not reuse it', async () => {
    const f = fixture();
    const role = f.library.openProfiles('persona');
    f.pending[0].resolve({ items: [], warnings: [] });
    await role;
    const books = f.library.openWorldbooks();
    f.pending[1].resolve({ items: [], warnings: [] });
    await books;
    assert.equal(f.renders[0].options?.reuseKey, 'world-library');
    assert.equal(f.renders[1].options?.reuseKey, 'world-library');
    const picker = f.library.openProfiles('persona', { id: 'world:a', name: 'A' });
    f.pending[2].resolve({ items: [], warnings: [] });
    await picker;
    assert.equal(f.renders[2].options?.reuseKey, undefined);
});
