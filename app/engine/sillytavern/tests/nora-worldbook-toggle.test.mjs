import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';
import { prepareWorldbookEntryEdit } from '../src/nora-world-core/worldbook-entry-edit.js';

function fixture({ saveError = null, switchWorld = false, generating = false, startDuringLoad = false, busy = false } = {}) {
    let worldId = 'world-a';
    let book = { entries: { 0: { comment: 'Enabled', constant: true }, 1: { comment: 'Disabled', disable: true, key: ['rain'] } } };
    const character = { data: { extensions: { world: 'book' } } };
    const saves = [];
    const notices = [];
    const controller = createWorldbookController({
        isGenerating: () => generating,
        readState: () => ({ world: { metadata: { nora_world: { id: worldId } } } }),
        currentCharacter: () => character, characterField: () => '', escapeHtml: String, icons: { edit: 'edit', plus: '+' },
        store: { cachedWorldbook: () => book, cacheWorldbook: (_name, value) => { book = value; } },
        operations: { isBusy: () => busy, run: async (_key, fn) => fn() },
        worldbook: {
            loadWorldbook: async () => { if (switchWorld) worldId = 'world-b'; if (startDuringLoad) generating = true; return book; },
            saveWorldbookEntry: async (name, source, id, patch, world) => {
                saves.push({ name, id, patch, world });
                if (saveError) throw saveError;
                const result = structuredClone(source);
                Object.assign(result.entries[id], patch);
                return { book: result, resource: { binding: { name: 'private-book' } } };
            },
        },
        reloadWorlds: async () => {}, onChanged: () => {},
        dialogs: { toast: message => notices.push(message), normalizeError: error => error.message },
    });
    return { controller, character, saves, notices };
}

function button(pressed = false) {
    const attributes = { 'aria-pressed': String(pressed) };
    return { getAttribute: name => attributes[name], setAttribute: (name, value) => { attributes[name] = value; }, removeAttribute: name => { delete attributes[name]; } };
}

test('disabled entries remain visible; switches exist only in editing mode', () => {
    const { controller, character } = fixture();
    const browsing = controller.summary(character, false);
    assert.match(browsing, /Disabled/);
    assert.match(browsing, /is-disabled/);
    assert.doesNotMatch(browsing, /data-worldbook-toggle/);
    assert.doesNotMatch(browsing, /data-worldbook-delete-kind/);
    assert.doesNotMatch(browsing, /data-add-world-setting/);
    const editing = controller.summary(character, true);
    assert.equal((editing.match(/data-worldbook-toggle=/g) || []).length, 2);
    assert.match(editing, /data-worldbook-toggle="0" aria-pressed="true"/);
    assert.match(editing, /data-worldbook-toggle="1" aria-pressed="false"/);
    assert.doesNotMatch(editing, /type="checkbox"|role="switch"/);
    assert.match(editing, /data-worldbook-edit-kind/);
    assert.doesNotMatch(editing, /data-worldbook-delete-kind|data-delete-setting/);
    assert.match(editing, /data-add-world-setting/);
});

test('toggle saves only the disable field and restores control after failure', async () => {
    for (const saveError of [null, new Error('Rejected')]) {
        const { controller, saves } = fixture({ saveError });
        const control = button();
        await controller.toggleEntry('1', control);
        assert.deepEqual(saves, [{ name: 'book', id: '1', patch: { disable: false }, world: 'world-a' }]);
        assert.equal(control.getAttribute('aria-pressed'), String(!saveError));
        assert.equal(control.disabled, false);
    }
});

test('changing world while loading does not save to another world', async () => {
    const { controller, saves } = fixture({ switchWorld: true });
    const control = button();
    await controller.toggleEntry('1', control);
    assert.equal(saves.length, 0);
    assert.equal(control.getAttribute('aria-pressed'), 'false');
});

test('generating, generation starting during read, and busy saves block toggling', async () => {
    for (const options of [{ generating: true }, { startDuringLoad: true }, { busy: true }]) {
        const { controller, saves, notices } = fixture(options);
        const control = button();
        await controller.toggleEntry('1', control);
        assert.equal(saves.length, 0);
        assert.equal(control.getAttribute('aria-pressed'), 'false');
        assert.equal(notices.length, 1);
    }
});

test('toggle creates an isolated copy, preserves rules, rejects malformed state and stale revision', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-toggle-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = { entries: { 1: { disable: true, constant: false, key: ['rain'], content: 'Rule', depth: 7 } } };
    const text = JSON.stringify(source);
    await fs.writeFile(path.join(directory, 'shared.json'), text);
    const world = { world_id: 'a', knowledge: [{ resource_id: 'shared', ownership: 'external', binding: { name: 'shared' } }] };
    const input = { name: 'shared', entry_id: '1', patch: { disable: false }, expected_revision: crypto.createHash('sha256').update(text).digest('hex') };
    for (const value of ['false', null, 0]) {
        await assert.rejects(prepareWorldbookEntryEdit({ world, directory, input: { ...input, patch: { disable: value } } }), /Invalid Worldbook entry changes/);
    }
    await assert.rejects(prepareWorldbookEntryEdit({ world, directory, input: { ...input, expected_revision: 'stale' } }), /changed/);
    const result = await prepareWorldbookEntryEdit({ world, directory, input });
    assert.notEqual(result.resource.binding.name, 'shared');
    assert.deepEqual(result.book.entries[1], { ...source.entries[1], disable: false });
    assert.equal(await fs.readFile(path.join(directory, 'shared.json'), 'utf8'), text);
    assert.equal(result.resource.ownership, 'owned');
});
