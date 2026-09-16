import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';
import { createWorldCoreClient } from '../public/scripts/nora-worlds/world-core-client.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';
import { stageCardBuffer } from '../src/nora-world-core/st-import-staging.js';
import { createStoryContext, editStoryCharacter } from '../public/scripts/nora-worlds/story-context.js';
import { createWorldPreset } from '../public/scripts/nora-worlds/world-preset.js';
import { isWorldCardProfileEnabled, setWorldCharacterContext } from '../public/scripts/nora-worlds/character-activation.js';

async function fixture(t, { fail = () => {}, authoredWorld = false } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-restart-test-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const directories = Object.fromEntries(['characters', 'chats', 'worlds', 'userImages'].map(key => [key, path.join(root, key)]));
    const stagingRoot = path.join(root, 'staging');
    await Promise.all([...Object.values(directories), stagingRoot].map(p => fs.mkdir(p, { recursive: true })));
    const materializer = createStBackendMaterializer({ directories, stagingRoot, checkpoint: fail });
    const core = createNoraWorldCore({ root: path.join(root, 'core'), materializer });
    let context = editStoryCharacter(createStoryContext({ name: 'Player', description: 'Author persona' }), { id: 'actor:a', operation: 'create',
        patch: { name: 'Actor', description: 'Original profile', persistent_status: { hp: 4 }, activation: { mode: 'constant', enabled: false } } });
    context.player.persistent_status = { gold: 999 };
    context.relationships = [{ id: 'rel:a', participants: ['__user__', 'actor:a'], description: 'Progressed relationship' }];
    if (authoredWorld) context.card_format = 'nora-world-card/2';
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {
        name: 'Restart fixture', description: 'Setting', personality: '', scenario: 'Initial scenario',
        first_mes: 'Authored opening', alternate_greetings: ['Alternate opening'], mes_example: '', creator_notes: '',
        system_prompt: '', post_history_instructions: '', tags: [], creator: 'Test', character_version: '1',
        extensions: { nora_world: { ...(authoredWorld ? { format: 'nora-world-card/2' } : {}), story_context: context } },
        character_book: { name: 'Init', extensions: {}, entries: [{ id: 0, keys: [], secondary_keys: [], comment: '[initvar]',
            content: 'hp: 100', enabled: false, insertion_order: 100, position: 'before_char', extensions: {} }] },
    } };
    const command = await stageCardBuffer({ buffer: Buffer.from(JSON.stringify(card)), originalName: 'fixture.json', sourceType: 'character-card',
        idempotencyKey: 'test:original', persona: authoredWorld ? { name: '', description: '' } : { name: 'Player', description: 'Author persona' }, worldName: 'Original', stagingRoot });
    let world = (await core.createWorld(command, { idempotencyKey: 'test:original' })).world;
    world = await core.updateWorld(world.world_id, { preset: createWorldPreset('Mine', {
        openai_max_context: 30000, openai_max_tokens: 4000, temperature: 0.8, top_p: 0.9, prompts: [], prompt_order: [{ character_id: 100001, order: [] }],
    }) }, { expectedRevision: world.revision });
    world = await core.setWorldTheme(world.world_id, { theme: { accent: '#123456' }, assets: { background: 'https://example.com/bg.png' } }, { expectedRevision: world.revision });
    const session = world.sessions.items[0];
    const chatPath = path.join(directories.chats, path.parse(session.binding.avatar).name, `${session.binding.chat_id}.jsonl`);
    const oldChat = [{ chat_metadata: { nora_world: { id: world.world_id }, scenario: 'Custom authored scenario', variables: { stat_data: { hp: 4 } }, summary: 'Old plot' } },
        { mes: 'Edited historical opening', extra: { stat_data: { hp: 4 } } }, { mes: 'Old story' }].map(v => JSON.stringify(v)).join('\n') + '\n';
    await fs.writeFile(chatPath, oldChat);
    return { core, world, directories, chatPath, oldChat };
}

async function complete(core, receipt) {
    let operation = receipt.operation;
    for (let i = 0; i < 200 && operation.status === 'RUNNING'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        operation = await core.getOperation(operation.operation_id);
    }
    assert.equal(operation.status, 'COMPLETED', JSON.stringify(operation.error));
    return core.getWorld(operation.world_id);
}

test('authored World import and repeated restart preserve persona, presets and summary-only semantics', async t => {
    const { core, world } = await fixture(t, { authoredWorld: true });
    t.after(() => setWorldCharacterContext(null));
    assert.deepEqual(world.persona, { name: 'Player', description: 'Author persona' });
    let current = world;
    for (let i = 0; i < 2; i++) {
        current = await complete(core, await core.restartWorld(current.world_id, {
            name: `Authored restart ${i}`, idempotencyKey: `test:authored-restart:${i}`, expectedRevision: current.revision,
        }));
        assert.deepEqual(current.persona, world.persona);
        assert.deepEqual(current.story_context.player.profile.identity, world.persona);
        assert.deepEqual(current.preset, world.preset);
        assert.deepEqual(current.ui, world.ui);
        assert.equal(current.story_context.card_format, 'nora-world-card/2');
        assert.deepEqual(current.story_context.characters[0].profile, world.story_context.characters[0].profile);
        setWorldCharacterContext(current.story_context, current.world_id);
        assert.equal(isWorldCardProfileEnabled(current.world_id, 'description'), false);
    }
});

test('restart copies independent settings and authored opening, not chat or progressed state', async t => {
    const { core, world, directories, chatPath, oldChat } = await fixture(t);
    const before = await core.getWorld(world.world_id);
    const libraryBefore = await core.listLibraryCards();
    const args = { name: 'Original · New', idempotencyKey: 'test:restart', expectedRevision: world.revision };
    const receipts = await Promise.all([core.restartWorld(world.world_id, args), core.restartWorld(world.world_id, args)]);
    assert.equal(receipts[0].operation.world_id, receipts[1].operation.world_id);
    const next = await complete(core, receipts[0]);
    assert.notEqual(next.world_id, world.world_id);
    assert.notEqual(next.runtime_card.binding.avatar, world.runtime_card.binding.avatar);
    assert.deepEqual(next.persona, world.persona);
    assert.deepEqual(next.preset, world.preset);
    assert.deepEqual(next.ui, world.ui);
    assert.deepEqual(next.story_context.characters[0].profile, world.story_context.characters[0].profile);
    assert.equal(next.story_context.characters[0].activation.enabled, false);
    assert.deepEqual(next.story_context.characters[0].persistent_status, {});
    assert.deepEqual(next.story_context.player.persistent_status, {});
    assert.deepEqual(next.story_context.relationships, []);
    const session = next.sessions.items[0];
    const chat = (await fs.readFile(path.join(directories.chats, path.parse(session.binding.avatar).name, `${session.binding.chat_id}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(chat.length, 2);
    assert.equal(chat[1].mes, 'Authored opening');
    assert.deepEqual(chat[1].swipes, ['Authored opening', 'Alternate opening']);
    assert.deepEqual(chat[1].extra, {});
    assert.equal(chat[0].chat_metadata.variables, undefined);
    assert.equal(chat[0].chat_metadata.summary, undefined);
    assert.equal(chat[0].chat_metadata.scenario, 'Custom authored scenario');
    assert.equal(next.capabilities.items.mvu.attempts, 0);
    const originalBookPath = path.join(directories.worlds, world.knowledge[0].binding.name + '.json');
    const nextBookPath = path.join(directories.worlds, next.knowledge[0].binding.name + '.json');
    assert.notEqual(originalBookPath, nextBookPath);
    assert.equal(next.knowledge[0].ownership, 'owned');
    const book = JSON.parse(await fs.readFile(nextBookPath));
    assert.equal(book.entries['0'].content, 'hp: 100');
    assert.equal(book.entries['0'].disable, true);
    book.entries['0'].content = 'new edit';
    await fs.writeFile(nextBookPath, JSON.stringify(book));
    assert.equal(JSON.parse(await fs.readFile(originalBookPath)).entries['0'].content, 'hp: 100');
    assert.deepEqual(await core.getWorld(world.world_id), before);
    assert.equal(await fs.readFile(chatPath, 'utf8'), oldChat);
    assert.deepEqual(await core.listLibraryCards(), libraryBefore);
    await core.updateWorld(world.world_id, { name: 'Changed after restart' }, { expectedRevision: world.revision });
    const replay = await core.restartWorld(world.world_id, args);
    assert.equal(replay.world.world_id, next.world_id);
    assert.equal((await core.listWorlds()).length, 2);
    await assert.rejects(core.restartWorld(world.world_id, { ...args, name: 'Different intent' }), { code: 'NORA_OPERATION_CONFLICT' });
});

test('stale source and missing source fail before creating a new World', async t => {
    const { core, world } = await fixture(t);
    await assert.rejects(core.restartWorld(world.world_id, { name: 'New', idempotencyKey: 'test:stale', expectedRevision: -1 }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    await assert.rejects(core.restartWorld('world:missing', { name: 'New', idempotencyKey: 'test:missing', expectedRevision: 0 }), { code: 'NORA_WORLD_NOT_FOUND' });
    assert.equal((await core.listWorlds()).length, 1);
});

test('browser client reaches the real restart route, polls completion and replays one World', async t => {
    const { core, world } = await fixture(t);
    const app = express();
    app.use(express.json());
    app.use('/api/nora-worlds-v2', createNoraWorldsV2Router({ resolveCore: () => core }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const client = createWorldCoreClient(() => ({ 'Content-Type': 'application/json' }), {
        fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, options),
        pollIntervalMs: 5, pendingStore: null,
    });
    const args = { worldId: world.world_id, name: 'HTTP restart', expectedRevision: world.revision, idempotencyKey: 'test:http' };
    const first = await client.restartWorld(args);
    const replay = await client.restartWorld(args);
    assert.equal(first.operation.status, 'COMPLETED');
    assert.equal(first.world.world_id, replay.world.world_id);
    assert.equal((await core.listWorlds()).length, 2);
});

test('retry after materialization failure uses the same identity and cleans incomplete owned files', async t => {
    let shouldFail = false;
    const { core, world, directories, chatPath, oldChat } = await fixture(t, { fail: stage => {
        if (shouldFail && stage === 'SESSION_CREATED') { shouldFail = false; throw new Error('Injected disk interruption'); }
    } });
    shouldFail = true;
    const args = { name: 'Retry', expectedRevision: world.revision, idempotencyKey: 'test:interrupted' };
    const first = await core.restartWorld(world.world_id, args);
    let operation;
    for (let i = 0; i < 200; i++) {
        operation = await core.getOperation(first.operation.operation_id);
        if (operation.status !== 'RUNNING') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(operation.status, 'FAILED');
    assert.equal((await fs.readdir(directories.worlds)).filter(name => name.startsWith('Nora_Restart')).length, 0);
    const next = await complete(core, await core.restartWorld(world.world_id, args));
    assert.equal(next.world_id, operation.world_id);
    assert.equal((await core.listWorlds()).length, 2);
    assert.equal(await fs.readFile(chatPath, 'utf8'), oldChat);
});

test('new playthrough owns user lore and survives deleting the original World', async t => {
    const { core, world, directories } = await fixture(t);
    const added = await core.addWorldSetting(world.world_id, { type: 'constant', title: 'Rule', content: 'Independent lore' },
        { expectedRevision: world.revision, idempotencyKey: 'test:add-rule' });
    const next = await complete(core, await core.restartWorld(world.world_id, {
        name: 'With lore', expectedRevision: added.world.revision, idempotencyKey: 'test:with-lore',
    }));
    assert.equal(next.knowledge.length, 2);
    const lore = next.knowledge.find(item => item.source_key === 'nora:user-settings');
    const filePath = path.join(directories.worlds, lore.binding.name + '.json');
    const book = JSON.parse(await fs.readFile(filePath));
    assert.equal(book.extensions.nora_resource.world_id, next.world_id);
    assert.equal(book.extensions.nora_resource.kind, 'world-settings');
    assert.equal(Object.values(book.entries)[0].content, 'Independent lore');
    await core.deleteWorld(world.world_id, { idempotencyKey: 'test:delete-original' });
    assert.deepEqual(JSON.parse(await fs.readFile(filePath)), book);
    assert.equal((await core.prepareOpen(next.world_id)).world_id, next.world_id);
    assert.equal((await core.getWorld(next.world_id)).name, 'With lore');
});
