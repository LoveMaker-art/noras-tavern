import assert from 'node:assert/strict';
import test from 'node:test';

import { readActivationSnapshot } from '../src/nora-world-core/activation-snapshot.js';

function plan() {
    return {
        schema: 'nora-world-activation/v1',
        world_id: 'world:one',
        world_revision: 4,
        runtime_card: { binding: { avatar: 'one.png' } },
        session: { binding: { avatar: 'one.png', chat_id: 'chat-one' } },
        knowledge: [{ binding: { name: 'One Book' } }, { binding: { name: 'Shared Book' } }],
    };
}

test('reads character, bounded chat and all Worldbooks concurrently behind one snapshot', async () => {
    const started = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = readActivationSnapshot(plan(), {
        characters: '/data/characters',
        chats: '/data/chats',
        worlds: '/data/worlds',
    }, {
        revision: 'revision-one',
        readers: {
            character: async (_directories, avatar) => {
                started.push(`character:${avatar}`);
                await gate;
                return {
                    avatar,
                    name: 'One',
                    data: {
                        extensions: {
                            existing: true,
                            tavern_helper: {
                                variables: { stat_data: { hp: 100 } },
                                scripts: [
                                    { type: 'script', name: 'Remote MVU loader', enabled: true, content: "import 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'" },
                                    { type: 'script', name: 'Character schema', enabled: true, content: "import 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js'" },
                                ],
                            },
                        },
                    },
                };
            },
            chat: async (_file, options) => {
                started.push(`chat:${options.limit}`);
                await gate;
                return { header: { chat_metadata: {} }, messages: [], start: 0, total: 0 };
            },
            worldbook: async (_directories, name) => {
                started.push(`worldbook:${name}`);
                await gate;
                return { entries: {} };
            },
        },
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started.sort(), [
        'character:one.png',
        'chat:40',
        'worldbook:One Book',
        'worldbook:Shared Book',
    ]);
    release();
    const result = await pending;
    assert.equal(result.snapshot.schema, 'nora-world-snapshot/v1');
    assert.equal(result.snapshot.revision, 'revision-one');
    const extensions = result.snapshot.character.data.extensions;
    assert.equal(extensions.existing, true);
    assert.equal(extensions.world, 'One Book');
    assert.deepEqual(extensions.tavern_helper.variables, { stat_data: { hp: 100 } });
    assert.equal(extensions.tavern_helper.scripts[0].enabled, false);
    assert.equal(extensions.tavern_helper.scripts[1].enabled, true);
    assert.equal(
        extensions.tavern_helper.scripts[1].content,
        "import '/scripts/extensions/third-party/nora-mvu/mvu-zod.js?v=4.1.11-nora1'",
    );
    assert.equal(extensions.nora_mvu_compatibility.managed_runtime, true);
    assert.equal(extensions.nora_mvu_compatibility.schema_runtime_localized, true);
    assert.deepEqual(result.snapshot.worldbooks.map(book => book.name), ['One Book', 'Shared Book']);
    assert.ok(Number.isFinite(result.timings.character));
    assert.ok(Number.isFinite(result.timings.chat));
    assert.ok(Number.isFinite(result.timings.worldbooks));
});

test('deduplicates an embedded Character Book only when the bound Worldbook preserves the exact original', async () => {
    const embeddedBook = {
        name: 'One Book',
        entries: [{ id: 0, keys: ['one'], secondary_keys: [], content: 'large shared content', enabled: true }],
    };
    const result = await readActivationSnapshot(plan(), {
        characters: '/data/characters',
        chats: '/data/chats',
        worlds: '/data/worlds',
    }, {
        revision: 'revision-one',
        readers: {
            character: async () => ({
                avatar: 'one.png',
                name: 'One',
                data: { character_book: structuredClone(embeddedBook), extensions: {} },
            }),
            chat: async () => ({ header: { chat_metadata: {} }, messages: [], start: 0, total: 0 }),
            worldbook: async (_directories, name) => name === 'One Book'
                ? { entries: {}, originalData: structuredClone(embeddedBook) }
                : { entries: {}, originalData: { name, entries: [] } },
        },
    });

    assert.equal(result.snapshot.character.data.character_book, undefined);
    assert.deepEqual(result.snapshot.embedded_worldbook_binding, { name: 'One Book' });
    assert.deepEqual(result.snapshot.worldbooks[0].data.originalData, embeddedBook);
});

test('keeps both embedded and bound Worldbooks when their contents have diverged', async () => {
    const embeddedBook = {
        name: 'One Book',
        entries: [{ id: 0, keys: ['one'], secondary_keys: [], content: 'card copy', enabled: true }],
    };
    const result = await readActivationSnapshot(plan(), {
        characters: '/data/characters',
        chats: '/data/chats',
        worlds: '/data/worlds',
    }, {
        revision: 'revision-one',
        readers: {
            character: async () => ({
                avatar: 'one.png',
                name: 'One',
                data: { character_book: structuredClone(embeddedBook), extensions: {} },
            }),
            chat: async () => ({ header: { chat_metadata: {} }, messages: [], start: 0, total: 0 }),
            worldbook: async (_directories, name) => ({
                entries: {},
                originalData: { name, entries: [{ ...embeddedBook.entries[0], content: 'edited copy' }] },
            }),
        },
    });

    assert.deepEqual(result.snapshot.character.data.character_book, embeddedBook);
    assert.equal(result.snapshot.embedded_worldbook_binding, undefined);
});
