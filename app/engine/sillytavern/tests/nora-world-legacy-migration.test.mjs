import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateLegacyWorlds } from '../src/nora-world-core/legacy-migration.js';
import { WorldStore } from '../src/nora-world-core/store.js';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-world-migration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = Object.fromEntries(['characters', 'chats', 'worlds', 'nora-worlds', 'nora-world-core']
        .map(name => [name === 'nora-worlds' ? 'noraWorlds' : name === 'nora-world-core' ? 'worldCore' : name, path.join(root, name)]));
    directories.root = root;
    await Promise.all(Object.values(directories).filter(value => value !== root).map(directory => fs.mkdir(directory, { recursive: true })));
    return directories;
}

async function writeCard(directories, avatar, content = avatar) {
    const buffer = Buffer.from(content);
    await fs.writeFile(path.join(directories.characters, avatar), buffer);
    return sha256(buffer);
}

async function writeChat(directories, avatar, chatId, worldId, { messages = ['hello'], worldbook = '' } = {}) {
    const directory = path.join(directories.chats, avatar.replace(/\.png$/i, ''));
    await fs.mkdir(directory, { recursive: true });
    const header = {
        user_name: 'User',
        character_name: avatar.replace(/\.png$/i, ''),
        create_date: '2026-08-01T00:00:00.000Z',
        chat_metadata: {
            nora_world: { id: worldId, version: 1, name: worldId, persona: { name: 'User', description: '' } },
            ...(worldbook ? { world_info: worldbook } : {}),
        },
    };
    const lines = [header, ...messages.map((mes, index) => ({
        name: index % 2 ? 'User' : 'Character',
        is_user: index % 2 === 1,
        is_system: false,
        mes,
    }))];
    await fs.writeFile(path.join(directory, `${chatId}.jsonl`), `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);
}

async function writeRegistry(directories, fileName, {
    id,
    avatar,
    chatId,
    sourceSha,
    worldbooks = [],
} = {}) {
    const document = {
        schema: 'nora-world/v1',
        id,
        name: id,
        persona: { name: 'User', description: '' },
        runtime: { character_avatar: avatar, chat_id: chatId, worldbook_names: worldbooks },
        ownership: { character_card: false, worldbooks: [] },
        source: { sha256: sourceSha, file_name: avatar, format: 'png' },
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-02T00:00:00.000Z',
    };
    await fs.writeFile(path.join(directories.noraWorlds, fileName), JSON.stringify(document));
}

const inspectCard = async (filePath) => ({
    sha256: sha256(await fs.readFile(filePath)),
    declaredCapabilities: path.basename(filePath).startsWith('normal') ? ['mvu', 'regex'] : [],
});

test('classifies legacy registry and chat evidence without merging conflicts or treating same-source Worlds as duplicates', async (t) => {
    const directories = await fixture(t);
    const sharedSource = await writeCard(directories, 'normal-a.png', 'same-card-source');
    await writeCard(directories, 'normal-b.png', 'same-card-source');
    await writeCard(directories, 'duplicate.png', 'duplicate-card');
    await writeCard(directories, 'chat-only.png', 'chat-only-card');
    await writeCard(directories, 'unused.png', 'not-a-world');
    await fs.writeFile(path.join(directories.worlds, 'Known Book.json'), '{}');

    await writeChat(directories, 'normal-a.png', 'chat-a', 'world:normal-a', { worldbook: 'Known Book' });
    await writeChat(directories, 'normal-b.png', 'chat-b', 'world:normal-b');
    await writeChat(directories, 'duplicate.png', 'same-chat', 'world:duplicate-a');
    await writeChat(directories, 'chat-only.png', 'empty-chat', 'world:chat-only', { messages: [] });

    await writeRegistry(directories, 'normal-a.json', {
        id: 'world:normal-a', avatar: 'normal-a.png', chatId: 'chat-a', sourceSha: sharedSource, worldbooks: ['Known Book'],
    });
    await writeRegistry(directories, 'normal-b.json', {
        id: 'world:normal-b', avatar: 'normal-b.png', chatId: 'chat-b', sourceSha: sharedSource,
    });
    await writeRegistry(directories, 'duplicate-a.json', {
        id: 'world:duplicate-a', avatar: 'duplicate.png', chatId: 'same-chat', sourceSha: sha256('duplicate-card'),
    });
    await writeRegistry(directories, 'duplicate-b.json', {
        id: 'world:duplicate-b', avatar: 'duplicate.png', chatId: 'same-chat', sourceSha: sha256('duplicate-card'),
    });
    await writeRegistry(directories, 'missing.json', {
        id: 'world:missing', avatar: 'missing.png', chatId: 'missing-chat', sourceSha: '', worldbooks: ['Missing Book'],
    });
    await fs.writeFile(path.join(directories.noraWorlds, 'corrupt.json'), '{not-json');

    const report = await migrateLegacyWorlds({
        directories,
        worldCoreRoot: directories.worldCore,
        inspectCard,
        now: () => '2026-08-29T00:00:00.000Z',
    });

    assert.equal(report.mode, 'analyze');
    assert.equal(report.summary.candidate_worlds, 6);
    assert.deepEqual(report.categories.same_source_multiple_worlds.find(group => group.includes('world:normal-a')), [
        'world:normal-a',
        'world:normal-b',
    ]);
    assert.deepEqual(report.categories.duplicate_binding.find(group => group.includes('world:duplicate-a')), [
        'world:duplicate-a',
        'world:duplicate-b',
    ]);
    assert.ok(report.categories.orphan_chat.includes('world:chat-only'));
    assert.ok(report.categories.empty_chat.includes('world:chat-only'));
    assert.ok(report.categories.orphan_card.includes('unused.png'));
    assert.ok(report.categories.missing_runtime_card.includes('world:missing'));
    assert.ok(report.categories.missing_chat.includes('world:missing'));
    assert.ok(report.categories.missing_worldbook.includes('world:missing'));
    assert.equal(report.categories.corrupt_record.some(item => item.file.endsWith('corrupt.json')), true);
    assert.equal(report.worlds.find(world => world.world_id === 'world:normal-a').disposition, 'normal');
    assert.equal(report.worlds.find(world => world.world_id === 'world:normal-b').disposition, 'normal');
    assert.equal(report.worlds.find(world => world.world_id === 'world:duplicate-a').disposition, 'needs_repair');
    assert.equal(report.worlds.find(world => world.world_id === 'world:missing').disposition, 'needs_repair');
    assert.deepEqual(report.reconciliation.unexplained, []);
});

test('applies additive v2 manifests idempotently and produces a complete v1/v2 reconciliation', async (t) => {
    const directories = await fixture(t);
    const sourceSha = await writeCard(directories, 'legacy.png', 'legacy-card');
    await writeChat(directories, 'legacy.png', 'legacy-chat', 'world:legacy');
    await writeRegistry(directories, 'legacy.json', {
        id: 'world:legacy', avatar: 'legacy.png', chatId: 'legacy-chat', sourceSha,
    });
    const reportPath = path.join(directories.worldCore, 'migrations', 'report.json');

    const first = await migrateLegacyWorlds({
        directories,
        worldCoreRoot: directories.worldCore,
        apply: true,
        reportPath,
        inspectCard,
        now: () => '2026-08-29T00:00:00.000Z',
    });
    assert.deepEqual(first.migration.applied, ['world:legacy']);
    assert.deepEqual(first.migration.session_projections_applied, ['world:legacy']);
    assert.deepEqual(first.migration.session_projections_already_present, []);
    assert.deepEqual(first.reconciliation.missing_in_v2, []);
    assert.deepEqual(first.reconciliation.binding_mismatch, []);
    assert.deepEqual(first.reconciliation.unexplained, []);

    const store = new WorldStore({ root: directories.worldCore });
    const [manifest] = await store.list();
    assert.equal(manifest.world_id, 'world:legacy');
    assert.equal(manifest.lifecycle.status, 'READY');
    assert.deepEqual(manifest.capabilities.declared, []);
    assert.deepEqual(manifest.runtime_card.binding, { avatar: 'legacy.png' });
    assert.deepEqual(manifest.sessions.items[0].binding, { avatar: 'legacy.png', chat_id: 'legacy-chat' });
    const migratedChatPath = path.join(directories.chats, 'legacy', 'legacy-chat.jsonl');
    const migratedHeader = JSON.parse((await fs.readFile(migratedChatPath, 'utf8')).split('\n', 1)[0]);
    assert.equal(
        migratedHeader.chat_metadata.nora_session.id,
        manifest.sessions.default_session_id,
        'migration must project the authoritative Story Session identity into the bound chat',
    );

    const second = await migrateLegacyWorlds({
        directories,
        worldCoreRoot: directories.worldCore,
        apply: true,
        inspectCard,
        now: () => '2026-08-29T00:01:00.000Z',
    });
    assert.deepEqual(second.migration.applied, []);
    assert.deepEqual(second.migration.already_present, ['world:legacy']);
    assert.deepEqual(second.migration.session_projections_applied, []);
    assert.deepEqual(second.migration.session_projections_already_present, ['world:legacy']);
    assert.equal(second.summary.v2_after, 1);
    assert.deepEqual(second.reconciliation.unexplained, []);
    assert.equal(JSON.parse(await fs.readFile(reportPath, 'utf8')).schema, 'nora-world-migration/v1');
});

test('never overwrites an existing v2 World when its legacy binding disagrees', async (t) => {
    const directories = await fixture(t);
    const sourceSha = await writeCard(directories, 'legacy.png', 'legacy-card');
    await writeChat(directories, 'legacy.png', 'legacy-chat', 'world:legacy');
    await writeRegistry(directories, 'legacy.json', {
        id: 'world:legacy', avatar: 'legacy.png', chatId: 'legacy-chat', sourceSha,
    });
    const store = new WorldStore({ root: directories.worldCore });
    await store.put({
        schema_version: 2,
        world_id: 'world:legacy',
        revision: 0,
        name: 'Existing v2',
        persona: { name: '', description: '' },
        lifecycle: { status: 'READY', error: null },
        source: { type: 'manual', sha256: '', original_name: '', format: '' },
        runtime_card: { resource_id: 'resource:existing', engine: 'sillytavern', binding: { avatar: 'other.png' }, ownership: 'external' },
        sessions: {
            default_session_id: 'session:existing',
            items: [{ session_id: 'session:existing', engine: 'sillytavern', binding: { avatar: 'other.png', chat_id: 'other-chat' }, opening_state: 'empty' }],
        },
        knowledge: [],
        capabilities: { declared: [], status: 'READY', items: {} },
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
    }, { expectedRevision: 0 });

    const report = await migrateLegacyWorlds({
        directories,
        worldCoreRoot: directories.worldCore,
        apply: true,
        store,
        inspectCard,
        now: () => '2026-08-29T00:00:00.000Z',
    });
    assert.deepEqual(report.migration.applied, []);
    assert.deepEqual(report.reconciliation.binding_mismatch, ['world:legacy']);
    assert.deepEqual(report.reconciliation.unexplained, [{ world_id: 'world:legacy', reason: 'v1_v2_binding_mismatch' }]);
    assert.equal((await store.get('world:legacy')).runtime_card.binding.avatar, 'other.png');
});
