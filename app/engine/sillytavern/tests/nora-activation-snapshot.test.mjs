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
                return { avatar, name: 'One' };
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
    assert.deepEqual(result.snapshot.worldbooks.map(book => book.name), ['One Book', 'Shared Book']);
    assert.ok(Number.isFinite(result.timings.character));
    assert.ok(Number.isFinite(result.timings.chat));
    assert.ok(Number.isFinite(result.timings.worldbooks));
});

