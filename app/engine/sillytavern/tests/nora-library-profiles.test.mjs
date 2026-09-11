import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfileLibrary } from '../src/nora-world-core/library-profiles.js';
import { KeyedLock } from '../src/nora-world-core/locks.js';
import { createLibraryController } from '../../../native-extensions/nora-ui/library-controller.js';

test('profile templates persist, deduplicate concurrent writes, reject conflicts, preserve activation and isolate copies', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-profiles-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const make = () => createProfileLibrary({ root, locks: new KeyedLock() });
    const library = make();
    assert.deepEqual(await library.list('character'), { items: [], warnings: [] });
    const input = { kind: 'character', name: 'Reusable', data: { name: 'Alice', description: 'Identity', personality: 'Quiet',
        activation: { mode: 'triggered', enabled: false, keys: ['rain'], secondaryKeys: ['night'], selectiveLogic: 3, scanDepth: 5, sticky: 2, delay: 1 } } };
    const saved = await Promise.all(Array.from({ length: 5 }, () => library.save(input)));
    assert.equal(saved.filter(result => !result.reused).length, 1);
    assert.equal((await library.list('character')).items.length, 1);
    assert.equal((await library.list('persona')).items.length, 0);
    const item = await make().read(saved[0].item.id);
    assert.deepEqual(item.data, input.data);
    item.data.activation.enabled = true;
    assert.equal((await library.read(item.id)).data.activation.enabled, false);
    await assert.rejects(library.save({ ...input, data: { ...input.data, description: 'Different' } }), /同名/);
    const persona = await library.save({ kind: 'persona', name: input.name, data: { name: 'Player', description: 'Explorer' } });
    assert.notEqual(persona.item.id, item.id, 'Different types have separate names');
    await assert.rejects(library.remove(item.id, 'stale'), /changed/);
    await library.remove(item.id, item.revision);
    assert.equal((await library.list('character')).items.length, 0);
    assert.equal((await library.list('persona')).items.length, 1);
    assert.equal(item.data.description, 'Identity', 'Previously copied values survive template deletion');
    const rich = await library.save({ kind: 'character', name: 'Rich', data: { name: 'Alice', description: 'Updated',
        profile: { identity: { name: 'Old', appearance: 'Silver hair' }, preferences: { favorite: 'Rain' } } } });
    assert.equal(rich.item.data.profile.identity.name, 'Alice');
    assert.equal(rich.item.data.profile.identity.description, 'Updated');
    assert.equal(rich.item.data.profile.identity.appearance, 'Silver hair');
    assert.deepEqual(rich.item.data.profile.preferences, { favorite: 'Rain' });
});

test('profile storage rejects invalid input, traversal, symlinks and reports damaged items', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-profiles-invalid-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const library = createProfileLibrary({ root, locks: new KeyedLock() });
    const input = { kind: 'persona', name: 'Player', data: { name: 'P', description: '' } };
    for (const value of [null, { ...input, kind: 'card' }, { ...input, name: '' }, { ...input, data: { name: 'P', scripts: [] } },
        { ...input, data: { name: 'P', description: 123 } }, { ...input, data: { name: 'P', description: 'x'.repeat(100001) } },
        { ...input, kind: 'character', data: { name: 'P', activation: { mode: 'triggered', keys: [] } } }]) {
        await assert.rejects(library.save(value));
    }
    await assert.rejects(library.read('../secret'));
    await assert.rejects(library.list('other'));
    const { item } = await library.save(input);
    const file = path.join(root, 'library-profiles', `${item.id}.json`);
    await fs.writeFile(file, '{broken');
    assert.equal((await library.list('persona')).warnings.length, 1);
    await assert.rejects(library.save(input), 'Never overwrite unreadable records');
    await fs.unlink(file);
    await fs.symlink(path.join(root, 'missing'), file);
    await assert.rejects(library.read(item.id), /Unsafe/);
});

function uiFixture() {
    const nodes = new Map(); const writes = [], notices = [], confirmations = [];
    let markup = '', world = { id: 'world:a', name: 'A', revision: 6 }, generating = false, confirm = true;
    let onConfirm = () => {};
    const item = { id: 'a'.repeat(64), kind: 'persona', name: 'Player template', revision: 'rev', data: { name: 'P', description: '<b>Player</b>' } };
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { disabled: false, handlers: {}, elements: {}, dataset: {},
            addEventListener(event, fn) { this.handlers[event] = fn; }, insertAdjacentHTML(_at, html) { markup += html; }, remove() {} });
        return nodes.get(selector);
    };
    const controller = createLibraryController({ worlds: {
        listLibraryProfiles: async () => ({ items: [{ ...item, character_name: 'P' }], warnings: [] }),
        readLibraryProfile: async () => structuredClone(item),
        saveLibraryProfile: async value => writes.push(['save', structuredClone(value)]),
        updateActive: async (...args) => writes.push(['apply', ...args]),
        importLibraryItem: async (...args) => writes.push(['character', ...args]),
    }, presets: {}, dialogs: { open: (_title, html) => { markup = html; return {}; }, close() {}, toast: text => notices.push(text), normalizeError: e => e.message,
        confirm: async value => { confirmations.push(value); onConfirm(); return confirm; } },
    operations: { isBusy: () => false, run: async (_key, fn) => fn() }, activeWorldModel: () => world, isGenerating: () => generating,
    characterField: (c, field) => c.data?.[field], openCards() {}, refresh() {}, select: node,
    selectAll: selector => selector === '[data-profile]' ? [Object.assign(node('[data-profile]'), { dataset: { profile: item.id } })] : [],
    escapeHtml: value => String(value).replaceAll('<', '&lt;'), });
    return { controller, node, item, writes, notices, confirmations, html: () => markup, world: () => world,
        switch: () => { world = { id: 'world:b', name: 'B', revision: 2 }; }, generate: () => { generating = true; },
        setConfirm: value => { confirm = value; }, onConfirm: fn => { onConfirm = fn; } };
}

for (const scenario of ['success', 'cancel', 'generating', 'switched', 'switch-during-confirm', 'generate-during-confirm']) {
    test(`persona contextual picker ${scenario}: confirmation, revision and world guards`, async () => {
        const f = uiFixture();
        await f.controller.openProfiles('persona', f.world());
        assert.doesNotMatch(f.html(), /创建新世界|data-library-tab|data-profile-new/);
        await f.node('[data-profile]').handlers.click();
        assert.match(f.html(), /&lt;b>/);
        assert.doesNotMatch(f.html(), /data-profile-delete/);
        if (scenario === 'cancel') f.setConfirm(false);
        if (scenario === 'generating') f.generate();
        if (scenario === 'switched') f.switch();
        if (scenario === 'switch-during-confirm') f.onConfirm(f.switch);
        if (scenario === 'generate-during-confirm') f.onConfirm(f.generate);
        await f.node('[data-use]').handlers.click({ currentTarget: f.node('[data-use]') });
        assert.equal(f.writes.length, scenario === 'success' ? 1 : 0);
        if (scenario === 'success') assert.deepEqual(f.writes[0], ['apply', { persona: f.item.data }, { expectedRevision: 6 }]);
    });
}

test('saving a template while generating never applies it to the current world', async () => {
    const f = uiFixture(); f.generate();
    f.controller.openSaveProfile('persona', f.item.data);
    const form = f.node('[data-save-profile]');
    form.elements = { name: { value: 'Player' }, description: { value: 'New description' }, label: { value: 'Personal template' } };
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.deepEqual(f.writes, [['save', { kind: 'persona', name: 'Personal template', data: { name: 'Player', description: 'New description' } }]]);
    assert.match(f.notices.at(-1), /当前世界未修改/);
});

test('saved role preview retains disabled state and advanced triggers when applied', async () => {
    const f = uiFixture(); f.item.kind = 'character';
    f.item.data = { name: 'Alice', description: '', personality: '', activation: { mode: 'triggered', enabled: false, keys: ['rain'], secondaryKeys: ['night'], cooldown: 3 } };
    await f.controller.openProfiles('character', f.world());
    await f.node('[data-profile]').handlers.click();
    await f.node('[data-use]').handlers.click({ currentTarget: f.node('[data-use]') });
    const form = f.node('[data-library-role]');
    form.elements = { name: { value: 'Alice' }, description: { value: '' }, personality: { value: '' }, mode: { value: 'triggered' }, keys: { value: 'rain' }, enabled: { checked: false } };
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(f.writes[0][0], 'character');
    assert.deepEqual(f.writes[0][2].character.patch.activation, f.item.data.activation);
});
