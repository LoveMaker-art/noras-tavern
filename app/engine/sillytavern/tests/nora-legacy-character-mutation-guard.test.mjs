import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { setConfigFilePath } from '../src/util.js';

const directories = { root: '/tmp/nora-user' };
setConfigFilePath(path.resolve('default/config.yaml'));

function core(worlds) {
    return { listWorlds: async () => structuredClone(worlds) };
}

test('legacy character delete cannot remove a runtime card and chat directory owned by a Nora World', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-character-guard-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDirectories = { root };
    for (const name of ['characters', 'chats', 'thumbnailsAvatar', 'backups', 'worlds']) {
        userDirectories[name] = path.join(root, name);
        fs.mkdirSync(userDirectories[name], { recursive: true });
    }
    const avatar = 'managed.png';
    const cardPath = path.join(userDirectories.characters, avatar);
    const chatsPath = path.join(userDirectories.chats, 'managed');
    fs.writeFileSync(cardPath, 'fixture-card');
    fs.mkdirSync(chatsPath);
    fs.writeFileSync(path.join(chatsPath, 'session.jsonl'), '{}');

    const coreRoot = path.join(root, 'nora-world-core');
    const worldCore = createNoraWorldCore({
        root: coreRoot,
        materializer: {
            async materialize() {
                return {
                    runtimeCard: { engine: 'sillytavern', binding: { avatar }, ownership: 'owned' },
                    defaultSession: { engine: 'sillytavern', binding: { avatar, chat_id: 'session' }, openingState: 'empty' },
                    knowledge: [],
                    declaredCapabilities: [],
                };
            },
        },
    });
    await worldCore.createWorld({
        name: 'Managed world',
        persona: { name: '', description: '' },
        source: { type: 'character-card', sha256: 'a'.repeat(64), original_name: avatar, format: 'v3-png' },
    }, { idempotencyKey: 'managed-world' });

    const { router } = await import('../src/endpoints/characters.js');
    const route = router.stack.find(layer => layer.route?.path === '/delete' && layer.route.methods.post);
    const handler = route.route.stack.at(-1).handle;
    const reply = { statusCode: 200, payload: null };
    const response = {
        status(code) { reply.statusCode = code; return this; },
        json(payload) { reply.payload = payload; return this; },
        send(payload) { reply.payload = payload; return this; },
        sendStatus(code) { reply.statusCode = code; return this; },
    };
    await handler({
        body: { avatar_url: avatar, delete_chats: true },
        user: { directories: userDirectories },
    }, response);

    assert.equal(reply.statusCode, 409);
    assert.equal(reply.payload?.error?.code, 'NORA_WORLD_RESOURCE_IN_USE');
    assert.equal(fs.existsSync(cardPath), true);
    assert.equal(fs.existsSync(chatsPath), true);
});

test('legacy character mutation rejects an avatar referenced by a Nora World runtime card', async () => {
    const { assertLegacyCharacterMutationAllowed } = await import('../src/nora-world-core/legacy-resource-guard.js');
    const worlds = [{
        world_id: 'world-1',
        runtime_card: { binding: { avatar: 'managed.png' } },
        sessions: { items: [{ binding: { avatar: 'managed.png', chat_id: 'session-1' } }] },
    }];

    await assert.rejects(
        assertLegacyCharacterMutationAllowed(directories, 'managed.png', { resolveCore: () => core(worlds) }),
        error => error?.code === 'NORA_WORLD_RESOURCE_IN_USE'
            && error?.status === 409
            && error?.details?.worldIds?.[0] === 'world-1',
    );
});

test('native card deletion cleans library records and replays safely while preserving chats unless requested', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-library-native-delete-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    for (const name of ['characters', 'chats', 'worlds', 'thumbnailsAvatar']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name]);
    }
    const { resolveNoraWorldCore } = await import('../src/nora-world-core/runtime.js');
    const core = resolveNoraWorldCore(directories);
    const card = await core.saveLibraryCard({ format: 'json', buffer: Buffer.from(JSON.stringify({
        spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Native fixture', description: 'fixture', first_mes: '', extensions: {} },
    })) });
    const chats = path.join(directories.chats, path.parse(card.avatar).name);
    fs.mkdirSync(chats);
    fs.writeFileSync(path.join(chats, 'plain.jsonl'), 'keep');
    const { router } = await import('../src/endpoints/characters.js');
    const handler = router.stack.find(layer => layer.route?.path === '/delete').route.stack.at(-1).handle;
    async function remove(deleteChats) {
        const result = { status: 200, body: null };
        const response = { status(code) { result.status = code; return this; },
            sendStatus(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
        await handler({ user: { directories }, body: { avatar_url: card.avatar, delete_chats: deleteChats } }, response);
        return result;
    }
    const first = await remove(false);
    assert.equal(first.status, 200);
    assert.equal(first.body.archive, 'deleted');
    assert.deepEqual((await core.listLibraryCards()).items, []);
    assert.equal(fs.readFileSync(path.join(chats, 'plain.jsonl'), 'utf8'), 'keep');
    const repeated = await remove(true);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.alreadyAbsent, true);
    assert.equal(fs.existsSync(chats), false);
});

test('legacy character mutation also protects a session binding and allows an unreferenced card', async () => {
    const { assertLegacyCharacterMutationAllowed } = await import('../src/nora-world-core/legacy-resource-guard.js');
    const worlds = [{
        world_id: 'world-2',
        runtime_card: { binding: { avatar: 'other.png' } },
        sessions: { items: [{ binding: { avatar: 'session-card.png', chat_id: 'session-2' } }] },
    }];
    const resolveCore = () => core(worlds);

    await assert.rejects(
        assertLegacyCharacterMutationAllowed(directories, 'session-card.png', { resolveCore }),
        { code: 'NORA_WORLD_RESOURCE_IN_USE' },
    );
    await assert.doesNotReject(
        assertLegacyCharacterMutationAllowed(directories, 'unused.png', { resolveCore }),
    );
});

test('legacy character rename and delete routes guard before touching files', () => {
    const source = fs.readFileSync(new URL('../src/endpoints/characters.js', import.meta.url), 'utf8');
    const renameStart = source.lastIndexOf('router.post(\'/rename\'');
    const renameEnd = source.indexOf('router.post(\'/edit\'', renameStart);
    const rename = source.slice(renameStart, renameEnd);
    const deleteStart = source.indexOf('router.post(\'/delete\'');
    const deleteEnd = source.indexOf('/**', deleteStart);
    const deletion = source.slice(deleteStart, deleteEnd);

    assert.ok(rename.indexOf('assertLegacyCharacterMutationAllowed') < rename.indexOf('writeCharacterData'));
    assert.ok(deletion.indexOf('assertLegacyCharacterMutationAllowed') < deletion.indexOf('.deleteLibraryCard('));
});
