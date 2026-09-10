import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyWorlds } from '../updater/verify-worlds.mjs';
import { createNoraWorldCore } from '../../app/engine/sillytavern/src/nora-world-core/index.js';

const app = fileURLToPath(new URL('../../app', import.meta.url));

async function fixture(t) {
    const native = await fs.mkdtemp(path.join(os.tmpdir(), 'update-worlds-'));
    t.after(() => fs.rm(native, { recursive: true, force: true }));
    const root = path.join(native, 'default-user/nora-world-core');
    const core = createNoraWorldCore({ root, materializer: {
        async materialize() {
            return {
                runtimeCard: { engine: 'sillytavern', binding: { avatar: 'fixture.png' }, ownership: 'owned' },
                defaultSession: { engine: 'sillytavern', binding: { chat_id: 'fixture-chat' }, openingState: 'empty' },
                knowledge: [], declaredCapabilities: [],
            };
        },
    } });
    await core.createWorld({ name: 'Fixture', persona: {},
        source: { type: 'character-card', sha256: 'a'.repeat(64), original_name: 'fixture.png', format: 'v3-png' },
    }, { idempotencyKey: 'fixture-operation' });
    return { native, root };
}

test('verification reads existing worlds and sessions using the product loader', async t => {
    const { native, root } = await fixture(t);
    const files = await fs.readdir(path.join(root, 'worlds'));
    const bytes = await fs.readFile(path.join(root, 'worlds', files[0]));
    const result = await verifyWorlds(app, native);
    assert.equal(result['default-user'].length, 1);
    assert.equal(result['default-user'][0].sessions.length, 1);
    assert.deepEqual(await fs.readFile(path.join(root, 'worlds', files[0])), bytes);
});

test('incompatible worlds fail verification without moving or rewriting the file', async t => {
    const { native, root } = await fixture(t);
    const file = path.join(root, 'worlds/broken.json');
    await fs.writeFile(file, '{broken');
    const quarantine = await fs.readdir(path.join(root, 'quarantine/worlds'));
    await assert.rejects(verifyWorlds(app, native), /World validation failed/);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    assert.deepEqual(await fs.readdir(path.join(root, 'quarantine/worlds')), quarantine);
});

test('every account is verified, not only default-user', async t => {
    const { native, root } = await fixture(t);
    await fs.cp(path.dirname(root), path.join(native, 'second-user'), { recursive: true });
    assert.deepEqual(Object.keys(await verifyWorlds(app, native)).sort(), ['default-user', 'second-user']);
});
