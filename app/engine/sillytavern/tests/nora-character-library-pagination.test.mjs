import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';

function buttonsFrom(body, attribute, datasetKey) {
    return [...body.matchAll(new RegExp(`${attribute}="(\\d+)"`, 'g'))]
        .map((match) => {
            const button = { dataset: { [datasetKey]: match[1] } };
            button.addEventListener = (_type, listener) => { button.listener = listener; };
            return button;
        });
}

function groupedLibrary(characters, usedAvatars = []) {
    const opened = [];
    const deleted = [];
    const state = { characters };
    const controller = createCharacterController({
        cards: {
            deleteCharacterCards: async request => {
                deleted.push(request);
                state.characters = state.characters.filter(card => !request.avatars.includes(card.avatar));
            },
        },
        operations: { isBusy: () => false, run: async (_key, operation) => operation() },
        dialogs: {
            open: (_title, body) => {
                const modal = { body, deletes: buttonsFrom(body, 'data-library-delete', 'libraryDelete') };
                opened.push(modal);
                return modal;
            },
            confirm: async () => true,
            toast() {},
            normalizeError: String,
        },
        readState: () => state,
        settings: () => ({}),
        characterField: (card, field) => card.data?.[field] || card[field] || '',
        resolveCharacter: () => assert.fail('library grouping must not expand cards'),
        selectAll: (selector, modal) => selector === '[data-library-delete]' ? modal.deletes : [],
        escapeHtml: String,
        icons: { trash: 'delete' },
        isCharacterInWorld: card => usedAvatars.includes(card.avatar),
        reloadWorlds: async () => {},
        refresh() {},
    });
    return { controller, opened, deleted };
}

function libraryCard(avatar, description, fingerprint = 'original-file') {
    return {
        avatar,
        name: 'Saved Card',
        data: { name: 'Saved Card', description, extensions: { nora_import: { source_sha256: fingerprint } } },
    };
}

test('library keeps shallow copies and edited contents separate even with the same source fingerprint', async () => {
    const app = groupedLibrary([
        { ...libraryCard('shallow-1.png', ''), shallow: true },
        { ...libraryCard('shallow-2.png', ''), shallow: true },
        libraryCard('original.png', 'original contents'),
        libraryCard('edited.png', 'edited contents'),
    ]);
    await app.controller.openLibrary();
    assert.equal(app.opened[0].deletes.length, 4);
    assert.doesNotMatch(app.opened[0].body, /nora-card-duplicate/);
    assert.equal('findDuplicate' in app.controller, false);
    assert.equal('identity' in app.controller, false, 'group identity is internal to the library');
});

test('library cleanup groups full content, ignores import provenance and preserves cards used by Worlds', async () => {
    const app = groupedLibrary([
        libraryCard('unused-copy.png', 'same contents', 'first-file'),
        libraryCard('in-use.png', 'same contents', 'other-file'),
        libraryCard('edited.png', 'different contents'),
    ], ['in-use.png']);
    await app.controller.openLibrary();
    assert.equal(app.opened[0].deletes.length, 2);
    assert.match(app.opened[0].body, /nora-card-duplicate">2份/);
    assert.match(app.opened[0].body, /data-library-character="1"/);
    await app.opened[0].deletes[0].listener();
    assert.deepEqual(app.deleted, [{ avatars: ['unused-copy.png'], deleteChats: false }]);
    assert.match(app.opened[1].body, /title="正在被世界使用" disabled/);
    await app.opened[1].deletes[0].listener();
    assert.equal(app.deleted.length, 1, 'even a programmatic click cannot delete the in-use card');
});

test('character library renders at most eight cards per page', async () => {
    const state = {
        activeCharacterId: 0,
        characters: Array.from({ length: 10 }, (_, index) => ({
            shallow: true,
            avatar: `card-${index}.png`,
            name: `角色 ${index}`,
            data: { name: `角色 ${index}`, creator: 'Nora', extensions: {} },
        })),
    };
    const opened = [];
    const expanded = [];
    const dialogs = {
        open: (_title, body) => {
            const modal = {
                body,
                characters: buttonsFrom(body, 'data-library-character', 'libraryCharacter'),
                deletes: buttonsFrom(body, 'data-library-delete', 'libraryDelete'),
                pages: buttonsFrom(body, 'data-library-page', 'libraryPage'),
            };
            opened.push(modal);
            return modal;
        },
        toast: () => {},
        confirm: async () => false,
        close: () => {},
        normalizeError: (error) => String(error?.message || error),
    };
    const resolveCharacter = async (index) => {
        expanded.push(index);
        state.characters[index] = { ...state.characters[index], shallow: false };
        return state.characters[index];
    };
    const controller = createCharacterController({
        cards: { resolveCharacter },
        operations: { isBusy: () => false, run: async (_key, operation) => operation() },
        dialogs,
        readState: () => state,
        settings: () => ({ blankCharacterAvatar: '__blank__.png' }),
        characterField: (character, field) => character?.data?.[field] || character?.[field] || '',
        characterCapabilities: () => ({ regexScripts: [], helperScripts: [], regexAllowed: true, helperAllowed: true }),
        resolveCharacter,
        enableCharacterCapabilities: async () => {},
        worldbookEntries: () => [],
        select: () => null,
        selectAll: (selector, modal) => ({
            '[data-library-character]': modal.characters,
            '[data-library-delete]': modal.deletes,
            '[data-library-page]': modal.pages,
        }[selector] || []),
        escapeHtml: (value) => String(value),
        icons: { trash: 'delete', left: 'left', right: 'right' },
        reloadWorlds: async () => {},
        refresh: () => {},
    });

    await controller.openLibrary();
    assert.deepEqual(expanded, [], 'opening a paged library must not fetch every full card');
    assert.equal(opened[0].characters.length, 8);
    assert.match(opened[0].body, /第 1 \/ 2 页/);
    assert.match(opened[0].body, /--nora-library-columns:4;--nora-library-mobile-columns:2/);

    const next = opened[0].pages.find((button) => button.dataset.libraryPage === '1');
    assert.ok(next?.listener, 'next-page control must be bound');
    await next.listener();

    assert.deepEqual(expanded, [], 'changing pages must remain shallow');
    assert.equal(opened[1].characters.length, 2);
    assert.match(opened[1].body, /第 2 \/ 2 页/);
    assert.match(opened[1].body, /--nora-library-columns:2;--nora-library-mobile-columns:2/);

    const originalMatchMedia = globalThis.matchMedia;
    try {
        globalThis.matchMedia = () => ({ matches: true });
        await controller.openLibrary(0);
        assert.deepEqual(expanded, [], 'mobile pagination must remain shallow');
        assert.equal(opened[2].characters.length, 4);
        assert.match(opened[2].body, /第 1 \/ 3 页/);
        assert.match(opened[2].body, /--nora-library-columns:4;--nora-library-mobile-columns:2/);
    } finally {
        if (originalMatchMedia) globalThis.matchMedia = originalMatchMedia;
        else delete globalThis.matchMedia;
    }

    await opened[2].characters[0].listener();
    assert.deepEqual(expanded, [0], 'opening one detail should expand only that card');
});
