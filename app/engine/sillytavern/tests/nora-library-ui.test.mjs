import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibraryController } from '../../../native-extensions/nora-ui/library-controller.js';

function fixture() {
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { handlers: {}, disabled: false, checked: false,
            addEventListener(type, fn) { this.handlers[type] = fn; } });
        return nodes.get(selector);
    };
    let world = { id: 'world:a', revision: 9, name: 'A' };
    let generating = false;
    let accepted = true;
    let deleteError = null;
    const deleted = [];
    const calls = []; const toasts = []; let content = '';
    const book = { source: { kind: 'card', name: 'card.png' }, source_key: 'library:source', source_name: 'Alice', name: 'Lore', count: 1, revision: 'book-rev', book: { entries: { 0: { content: 'Rule' } } } };
    const standalone = { ...book, source: { kind: 'book', name: 'library-lore' }, source_name: 'Lore' };
    const controller = createLibraryController({
        worlds: { readLibraryWorldbook: async source => source.kind === 'book' ? standalone : book,
            deleteLibraryWorldbook: async (...args) => { if (deleteError) throw deleteError; deleted.push(args); },
            importLibraryItem: async (...args) => calls.push(args), listLibraryWorldbooks: async () => ({ items: [standalone], warnings: [] }) },
        presets: {}, dialogs: { open: (_title, html) => { content = html; return {}; }, confirm: async () => accepted, close() {}, toast: message => toasts.push(message), normalizeError: error => error.message },
        operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        activeWorldModel: () => world, isGenerating: () => generating,
        characterField: (card, field) => card.data[field], openCards() {}, refresh() {},
        select: node, selectAll: selector => selector === '[data-book]' ? [Object.assign(node('[data-book]'), { dataset: { book: '0' } })] : [], escapeHtml: value => String(value).replaceAll('<', '&lt;'),
    });
    return { controller, node, calls, deleted, toasts, html: () => content, setWorld: value => { world = value; }, setGenerating: value => { generating = value; },
        setAccepted: value => { accepted = value; }, setDeleteError: value => { deleteError = value; } };
}

test('embedded book preview returns to its card and allows saving, never deleting the card', async () => {
    const f = fixture();
    let returned = false;
    await f.controller.openBook({ kind: 'card', name: 'card.png' }, null, () => { returned = true; });
    assert.match(f.html(), /返回完整卡/);
    assert.match(f.html(), /Rule/);
    assert.match(f.html(), /data-save-book-copy/);
    assert.doesNotMatch(f.html(), /data-delete-book/);
    f.node('[data-back]').handlers.click();
    assert.equal(returned, true);
    f.node('[data-save-book-copy]').handlers.click();
    assert.match(f.html(), /data-save-book/);
});

test('standalone book has themed management; picker has no destructive management', async () => {
    const f = fixture();
    await f.controller.openBook({ kind: 'book', name: 'library-lore' });
    assert.match(f.html(), /<summary>管理<\/summary>/);
    assert.match(f.html(), /nora-library-action nora-library-action-danger" data-delete-book/);
    assert.doesNotMatch(f.html(), /nora-delete-button|nora-setting-delete/);
    await f.controller.openBook({ kind: 'book', name: 'library-lore' }, { id: 'world:a' });
    assert.doesNotMatch(f.html(), /data-delete-book|data-save-book-copy|nora-library-management/);
});

test('worldbook delete confirms, carries revision, handles rejection and blocks generation', async () => {
    const f = fixture();
    await f.controller.openBook({ kind: 'book', name: 'library-lore' });
    const button = f.node('[data-delete-book]');
    const click = () => button.handlers.click({ currentTarget: button });
    f.setAccepted(false);
    await click();
    assert.equal(f.deleted.length, 0);
    assert.equal(button.disabled, false);
    f.setAccepted(true);
    f.setGenerating(true);
    await click();
    assert.equal(f.deleted.length, 0);
    f.setGenerating(false);
    f.setDeleteError(new Error('Worldbook is referenced'));
    await click();
    assert.equal(f.toasts.at(-1), 'Worldbook is referenced');
    assert.equal(button.disabled, false);
    assert.match(f.html(), /data-delete-book/);
    f.setDeleteError(null);
    await click();
    assert.deepEqual(f.deleted, [[{ kind: 'book', name: 'library-lore' }, 'book-rev']]);
    assert.equal(f.toasts.at(-1), '库中世界书已删除。');
});

for (const includeBook of [false, true]) {
    test(`role import preview submits only selected fields, withBook=${includeBook}`, async () => {
        const f = fixture();
        const card = { name: 'Alice', avatar: 'card.png', data: { description: '<script>sample</script>', personality: 'Kind', first_mes: 'Opening', character_book: { entries: [] } } };
        await f.controller.openRoleImport(card);
        assert.match(f.html(), /&lt;script>/);
        assert.match(f.html(), /name="withBook"/);
        assert.doesNotMatch(f.html(), /name="withBook" checked/);
        const form = f.node('[data-library-role]');
        form.elements = { name: { value: 'Alice edited' }, description: { value: 'New profile' }, personality: { value: 'Kind' }, withBook: { checked: includeBook } };
        await form.handlers.submit({ preventDefault() {}, currentTarget: form });
        assert.equal(f.calls.length, 1);
        const [worldId, input] = f.calls[0];
        assert.equal(worldId, 'world:a'); assert.equal(input.expected_revision, 9);
        assert.equal(input.character.patch.name, 'Alice edited');
        assert.deepEqual(Object.keys(input.character.patch).sort(), ['activation', 'description', 'name', 'personality']);
        assert.equal(Boolean(input.source), includeBook);
        assert.equal(f.toasts.at(-1), '已添加到当前世界。');
    });
}

for (const state of ['generating', 'switched']) {
    test(`role import blocks ${state} after the preview opens`, async () => {
        const f = fixture();
        await f.controller.openRoleImport({ name: 'Alice', avatar: 'card.png', data: {} });
        if (state === 'generating') f.setGenerating(true);
        else f.setWorld({ id: 'world:b', revision: 3 });
        const form = f.node('[data-library-role]');
        form.elements = { name: { value: 'Alice' }, description: { value: '' }, personality: { value: '' } };
        await form.handlers.submit({ preventDefault() {}, currentTarget: form });
        assert.equal(f.calls.length, 0); assert.equal(f.toasts.length, 1);
    });
}

test('worldbook library has card navigation and JSON import, even with zero cards', async () => {
    const f = fixture();
    await f.controller.openWorldbooks();
    assert.match(f.html(), /data-library-tab="cards"/);
    assert.match(f.html(), /导入世界书/);
    assert.match(f.html(), /Lore/);
    assert.match(f.html(), /独立世界书/);
    assert.doesNotMatch(f.html(), /来自角色卡|来源角色/);
    assert.doesNotMatch(f.html(), /card\.png/);
});

test('attached status uses source identity; book details retain original file and disable duplicate action', async () => {
    const f = fixture();
    f.setWorld({ id: 'world:a', name: 'A', revision: 9, libraryWorldbooks: [{ sourceKey: 'library:source', name: 'copy' }] });
    await f.controller.openWorldbooks();
    assert.match(f.html(), /已添加/);
    await f.node('[data-book]').handlers.click();
    assert.match(f.html(), /data-attach disabled/);
    assert.match(f.html(), /library-lore/);
    assert.match(f.html(), /目标世界：A/);
    await f.node('[data-attach]').handlers.click({ currentTarget: f.node('[data-attach]') });
    assert.equal(f.calls.length, 0);
});

test('role import does not reattach an existing book; name alone never marks it attached', async () => {
    const f = fixture();
    f.setWorld({ id: 'world:a', name: 'A', revision: 9, libraryWorldbooks: [{ sourceKey: 'library:other', name: 'Lore' }] });
    await f.controller.openWorldbooks();
    assert.doesNotMatch(f.html(), /已添加/);
    f.setWorld({ id: 'world:a', name: 'A', revision: 9, libraryWorldbooks: [{ sourceKey: 'library:source' }] });
    await f.controller.openRoleImport({ name: 'Alice', avatar: 'card.png', data: { character_book: { entries: [] } } });
    assert.doesNotMatch(f.html(), /name="withBook"/);
    assert.match(f.html(), /已添加/);
    const form = f.node('[data-library-role]');
    form.elements = { name: { value: 'Alice' }, description: { value: '' }, personality: { value: '' } };
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1].source, undefined);
});

test('worldbook search survives reopening; generation and changed target still block attachment', async () => {
    const f = fixture();
    await f.controller.openWorldbooks();
    f.node('[data-book-search]').value = 'missing';
    await f.node('[data-book-search-form]').handlers.submit({ preventDefault() {} });
    await f.controller.openWorldbooks();
    assert.match(f.html(), /value="missing"/);
    assert.match(f.html(), /没有匹配的世界书/);
    await f.node('[data-book]').handlers.click();
    f.setGenerating(true);
    await f.node('[data-attach]').handlers.click({ currentTarget: f.node('[data-attach]') });
    assert.equal(f.calls.length, 0);
    f.setGenerating(false);
    f.setWorld({ id: 'world:b' });
    await f.node('[data-attach]').handlers.click({ currentTarget: f.node('[data-attach]') });
    assert.equal(f.calls.length, 0);
});
