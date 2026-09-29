import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNoraWorldCore, NoraWorldCoreError } from '../src/nora-world-core/index.js';
import { normalizeCreateCommand, materializationFromWorld } from '../src/nora-world-core/domain.js';
import { OperationJournal } from '../src/nora-world-core/operation-journal.js';
import { documentFileName } from '../src/nora-world-core/atomic-json.js';

const SOURCE_SHA = 'a'.repeat(64);

async function temporaryRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-world-core-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

function command(overrides = {}) {
    return {
        name: '测试世界',
        persona: { name: '测试者', description: '用于 Phase 1' },
        source: {
            type: 'character-card',
            sha256: SOURCE_SHA,
            original_name: '测试卡.png',
            format: 'v3-png',
        },
        ...overrides,
    };
}

function materializer({ failOnce = false, deleteFailOnce = false, delay = null, ownership = 'owned', inspectResults = [] } = {}) {
    let calls = 0;
    let settingCalls = 0;
    const deletions = [];
    let inspections = 0;
    const settingBooks = new Map();
    return {
        get calls() {
            return calls;
        },
        get deletions() {
            return deletions;
        },
        get settingCalls() {
            return settingCalls;
        },
        async addWorldSetting(world, setting, { operationId }) {
            settingCalls += 1;
            const result = {
                resource: world.knowledge[0] || {
                    resource_id: `resource:${world.world_id}:settings`,
                    source_key: 'nora:user-settings',
                    engine: 'sillytavern',
                    binding: { name: `${world.name} 自建设定` },
                    ownership: 'owned',
                },
                source_resource_id: world.knowledge[0]?.resource_id || null,
                entry_id: '0',
                entry: { uid: 0, comment: setting.title, content: setting.content, constant: setting.type === 'constant', key: setting.keys },
                book: { entries: { 0: { uid: 0, comment: setting.title, content: setting.content, key: setting.keys } } },
                operation_id: operationId,
            };
            settingBooks.set(world.world_id, result.book);
            return result;
        },
        async readWorldSettingBook(worldId) {
            return structuredClone(settingBooks.get(worldId));
        },
        async inspect() {
            const result = inspectResults[Math.min(inspections, Math.max(0, inspectResults.length - 1))]
                || { ready: true, issues: [] };
            inspections += 1;
            return result;
        },
        async deleteResources(world, plan) {
            deletions.push({ world, plan });
            if (deleteFailOnce && deletions.length === 1) throw new Error('fixture deletion failed');
            return { deleted: [] };
        },
        async materialize(input, context) {
            calls += 1;
            if (delay) await delay(context);
            if (failOnce && calls === 1) throw new Error('fixture materialization failed');
            return {
                runtimeCard: {
                    engine: 'sillytavern',
                    binding: { avatar: `${input.name}.png` },
                    ownership,
                },
                defaultSession: {
                    engine: 'sillytavern',
                    binding: { chat_id: `${context.worldId}-chat` },
                    openingState: 'empty',
                },
                knowledge: [{
                    sourceKey: 'embedded-worldbook:0',
                    engine: 'sillytavern',
                    binding: { name: `${input.name}设定` },
                    ownership: 'owned',
                }],
                declaredCapabilities: ['regex', 'mvu'],
            };
        },
    };
}

test('presents one small World Core interface and hides persistence mechanics', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    const core = createNoraWorldCore({ root, materializer: adapter });

    assert.deepEqual(Object.keys(core).sort(), [
        'importLibraryItem', 'listLibraryWorldbooks', 'readLibraryWorldbook', 'saveLibraryWorldbook', 'deleteLibraryWorldbook',
        'listLibraryCards', 'saveLibraryCard', 'readLibraryCardSource', 'deleteLibraryCard',
        'listLibraryProfiles', 'readLibraryProfile', 'saveLibraryProfile', 'deleteLibraryProfile',
        'addWorldSetting',
        'beginCapabilityAttempt',
        'createWorld',
        'restartWorld',
        'deleteWorld',
        'previewWorldDeletion',
        'editWorldbookEntry',
        'getOperation',
        'getWorld',
        'inspectWorld',
        'listWorlds',
        'prepareOpen',
        'repairWorld',
        'retryOperation',
        'setWorldTheme',
        'settleCapabilityAttempt',
        'submitWorld',
        'updateWorld',
    ].sort());

    const result = await core.createWorld(command(), { idempotencyKey: 'import:test:one' });

    assert.equal(result.reused, false);
    assert.equal(result.world.schema_version, 2);
    assert.equal(result.world.lifecycle.status, 'READY');
    assert.equal(result.world.capabilities.status, 'PENDING');
    assert.deepEqual(result.world.capabilities.declared, ['mvu', 'regex']);
    assert.equal(result.world.sessions.items[0].opening_state, 'empty');
    assert.equal(result.operation.status, 'COMPLETED');
    assert.equal(result.operation.stage, 'COMPLETED');
    assert.equal(adapter.calls, 1);

    const inspected = await core.inspectWorld(result.world.world_id);
    assert.deepEqual(inspected.resource_references.runtime_card.world_ids, [result.world.world_id]);
    assert.deepEqual(inspected.resource_references.knowledge[0].world_ids, [result.world.world_id]);
});

test('an interrupted deletion prevents another World acquiring its resources and remains retryable', async t => {
    const root = await temporaryRoot(t);
    const adapter = materializer({ deleteFailOnce: true });
    const core = createNoraWorldCore({ root, materializer: adapter });
    const { world } = await core.createWorld(command(), { idempotencyKey: 'delete:reference-original' });
    await assert.rejects(core.deleteWorld(world.world_id, { idempotencyKey: 'delete:reference-scope' }));
    await assert.rejects(core.createWorld(command(), { idempotencyKey: 'delete:reference-new-sharer' }), { code: 'NORA_WORLD_RESOURCE_DELETING' });
    await assert.rejects(core.repairWorld(world.world_id, { idempotencyKey: 'delete:cannot-repair' }), { code: 'NORA_WORLD_NOT_READY' });
    await core.deleteWorld(world.world_id, { idempotencyKey: 'delete:reference-scope' });
    assert.equal(adapter.deletions.at(-1).plan.runtime_card.delete, true);
    assert.deepEqual(await core.listWorlds(), []);
});

test('character array CRUD persists across reopen with revision protection and intact legacy resources', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    const core = createNoraWorldCore({ root, materializer: adapter });
    const { world: original } = await core.createWorld(command(), { idempotencyKey: 'characters:crud' });
    const toggled = await core.updateWorld(original.world_id, { cardProfileEnabled: false }, { expectedRevision: original.revision });
    assert.equal(toggled.story_context.card_profile_enabled, false);
    assert.deepEqual(toggled.runtime_card, original.runtime_card);
    const enabled = await core.updateWorld(original.world_id, { cardProfileEnabled: true }, { expectedRevision: toggled.revision });
    await assert.rejects(() => core.updateWorld(original.world_id, { cardProfileEnabled: 'false' }, { expectedRevision: enabled.revision }), { code: 'NORA_WORLD_INVALID' });
    const actor = (id, mode) => ({ operation: 'create', id, patch: { name: id, description: 'profile', personality: 'calm',
        activation: { mode, keys: mode === 'triggered' ? ['shop'] : [] } } });
    let world = await core.updateWorld(original.world_id, { character: actor('actor:a', 'constant') }, { expectedRevision: enabled.revision });
    world = await core.updateWorld(world.world_id, { character: actor('actor:b', 'triggered') }, { expectedRevision: world.revision });
    assert.equal(world.story_context.characters.length, 2);
    assert.deepEqual(world.runtime_card, original.runtime_card);
    assert.deepEqual(world.sessions, original.sessions);
    const revisionBeforeRemoval = world.revision;
    world = await core.updateWorld(world.world_id, { removeSetting: 'scenario' }, { expectedRevision: world.revision });
    assert.deepEqual(world.story_context.removed_card_fields, ['scenario']);
    world = await core.updateWorld(world.world_id, { removeSetting: 'card-profile' }, { expectedRevision: world.revision });
    assert.deepEqual(new Set(world.story_context.removed_card_fields), new Set(['description', 'personality', 'scenario']));
    assert.deepEqual((await createNoraWorldCore({ root, materializer: adapter }).getWorld(world.world_id)).story_context.removed_card_fields, world.story_context.removed_card_fields);
    assert.deepEqual(world.runtime_card, original.runtime_card);
    await assert.rejects(() => core.updateWorld(world.world_id, { removeSetting: 'card-profile' }, { expectedRevision: revisionBeforeRemoval }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    await assert.rejects(() => core.updateWorld(world.world_id, { removeSetting: 'all' }, { expectedRevision: world.revision }), { code: 'NORA_WORLD_INVALID' });
    assert.deepEqual(world.knowledge, original.knowledge);
    assert.deepEqual(world.persona, original.persona);
    await assert.rejects(() => core.updateWorld(world.world_id, { character: actor('actor:c', 'constant') }, { expectedRevision: original.revision }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    const reopened = createNoraWorldCore({ root, materializer: adapter });
    assert.deepEqual((await reopened.getWorld(world.world_id)).story_context, world.story_context);
    const other = await core.createWorld(command(), { idempotencyKey: 'characters:other-world' });
    const activation = world.story_context.characters[1].activation;
    world = await reopened.updateWorld(world.world_id, { character: { id: 'actor:b', patch: { activation: { ...activation, enabled: false } } } }, { expectedRevision: world.revision });
    assert.equal((await createNoraWorldCore({ root, materializer: adapter }).getWorld(world.world_id)).story_context.characters[1].activation.enabled, false);
    assert.deepEqual(await core.getWorld(other.world.world_id), other.world, 'toggling one World leaves the other manifest unchanged');
    assert.deepEqual(world.runtime_card, original.runtime_card);
    assert.deepEqual(world.knowledge, original.knowledge);
    world = await reopened.updateWorld(world.world_id, { character: { id: 'actor:b', patch: { activation: { mode: 'constant' } } } }, { expectedRevision: world.revision });
    assert.equal(world.story_context.characters[1].activation.mode, 'constant');
    world = await reopened.updateWorld(world.world_id, { character: { id: 'actor:a', operation: 'delete' } }, { expectedRevision: world.revision });
    assert.deepEqual(world.story_context.characters.map(actor => actor.id), ['actor:b']);
    assert.deepEqual(world.sessions, original.sessions);
});

test('appends a setting without replacing the knowledge binding and deduplicates retries', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    const core = createNoraWorldCore({ root, materializer: adapter });
    const created = await core.createWorld(command(), { idempotencyKey: 'import:setting-target' });
    const input = { type: 'trigger', title: '雨夜', content: '雨夜里的街道更危险。', keys: ['雨', '街道'] };

    const added = await core.addWorldSetting(created.world.world_id, input, {
        expectedRevision: created.world.revision,
        idempotencyKey: 'setting:add:one',
    });

    assert.equal(added.reused, false);
    assert.equal(added.world.knowledge[0].source_key, 'embedded-worldbook:0');
    assert.equal(added.world.knowledge[0].ownership, 'owned');
    assert.equal(added.world.knowledge.length, 1);
    assert.deepEqual(added.world.knowledge, created.world.knowledge);
    assert.equal(added.entry.comment, '雨夜');
    assert.deepEqual(added.entry.key, ['雨', '街道']);
    assert.equal(adapter.settingCalls, 1);

    const reopened = createNoraWorldCore({ root, materializer: adapter });
    const operationFiles = await fs.readdir(path.join(root, 'mutations'));
    const receipt = JSON.parse(await fs.readFile(path.join(root, 'mutations', operationFiles[0]), 'utf8'));
    assert.equal(receipt.schema, 'nora-world-operation/v2');
    assert.equal(receipt.command, undefined);
    const repeated = await reopened.addWorldSetting(created.world.world_id, input, {
        expectedRevision: created.world.revision,
        idempotencyKey: 'setting:add:one',
    });
    assert.equal(repeated.reused, true);
    assert.equal(repeated.entry_id, added.entry_id);
    assert.equal(adapter.settingCalls, 1);

    await assert.rejects(reopened.addWorldSetting(created.world.world_id, { ...input, content: 'Changed' }, {
        expectedRevision: created.world.revision,
        idempotencyKey: 'setting:add:one',
    }), { code: 'NORA_OPERATION_CONFLICT' });

    await assert.rejects(core.addWorldSetting(created.world.world_id, input, {
        expectedRevision: created.world.revision,
        idempotencyKey: 'setting:add:stale',
    }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
});

test('deletes one World through a durable idempotent backend command and leaves a tombstone', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    const core = createNoraWorldCore({ root, materializer: adapter });
    const created = await core.createWorld(command(), { idempotencyKey: 'import:delete-target' });

    const deleted = await core.deleteWorld(created.world.world_id, { idempotencyKey: 'delete:target' });
    assert.equal(deleted.operation.type, 'DELETE_WORLD');
    assert.equal(deleted.operation.status, 'COMPLETED');
    assert.equal(deleted.world.lifecycle.status, 'DELETED');
    assert.deepEqual(await core.listWorlds(), []);
    assert.equal(adapter.deletions.length, 1);
    assert.equal(adapter.deletions[0].plan.runtime_card.delete, true);
    assert.equal(adapter.deletions[0].plan.sessions[0].delete, true);

    const repeated = await core.deleteWorld(created.world.world_id, { idempotencyKey: 'delete:target' });
    assert.equal(repeated.operation.operation_id, deleted.operation.operation_id);
    assert.equal(repeated.reused, true);
    assert.equal(adapter.deletions.length, 1);
    const mutationPath = path.join(root, 'mutations', (await fs.readdir(path.join(root, 'mutations')))[0]);
    const legacy = JSON.stringify({ ...deleted.operation, schema: 'nora-world-operation/v1' });
    await fs.writeFile(mutationPath, legacy);
    const restarted = createNoraWorldCore({ root, materializer: adapter });
    assert.equal((await restarted.getOperation(deleted.operation.operation_id)).status, 'COMPLETED');
    assert.equal((await restarted.deleteWorld(created.world.world_id, { idempotencyKey: 'delete:target' })).reused, true);
    assert.equal(await fs.readFile(mutationPath, 'utf8'), legacy);
    assert.equal(adapter.deletions.length, 1);
});

test('completed operations and deleted Worlds retain compact replay evidence without their story content', async t => {
    const root = await temporaryRoot(t);
    const input = command({ persona: { name: 'Player', description: 'private-profile-'.repeat(2000) },
        payload: { arbitrary_story: 'private-story-'.repeat(20000) } });
    const adapter = materializer();
    const core = createNoraWorldCore({ root, materializer: adapter });
    const created = await core.createWorld(input, { idempotencyKey: 'compact:source' });
    const operationPath = path.join(root, 'operations', (await fs.readdir(path.join(root, 'operations')))[0]);
    const receipt = JSON.parse(await fs.readFile(operationPath, 'utf8'));
    assert.equal(receipt.schema, 'nora-world-operation/v2');
    assert.equal(receipt.command, undefined);
    assert.equal(receipt.materialization, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 3000);
    t.diagnostic(`creation command ${Buffer.byteLength(JSON.stringify(input))} bytes -> receipt ${Buffer.byteLength(JSON.stringify(receipt))} bytes`);
    await core.deleteWorld(created.world.world_id, { idempotencyKey: 'compact:delete' });
    const worldPath = path.join(root, 'worlds', (await fs.readdir(path.join(root, 'worlds')))[0]);
    const tombstone = JSON.parse(await fs.readFile(worldPath, 'utf8'));
    assert.equal(tombstone.schema, 'nora-world-tombstone/1');
    assert.equal(JSON.stringify(tombstone).includes('private-profile'), false);
    t.diagnostic(`live manifest ${Buffer.byteLength(JSON.stringify(created.world))} bytes -> tombstone ${Buffer.byteLength(JSON.stringify(tombstone))} bytes`);
    const reopened = createNoraWorldCore({ root, materializer: adapter });
    const replay = await reopened.createWorld(input, { idempotencyKey: 'compact:source' });
    assert.equal(replay.world.world_id, created.world.world_id);
    assert.equal(replay.world.lifecycle.status, 'DELETED');
    assert.deepEqual(await reopened.listWorlds(), []);
    assert.equal(adapter.calls, 1);
    await assert.rejects(reopened.createWorld(command({ name: 'Different' }), { idempotencyKey: 'compact:source' }), { code: 'NORA_OPERATION_CONFLICT' });
    const legacyDeleted = JSON.stringify({ ...created.world, revision: tombstone.revision, lifecycle: { status: 'DELETED', error: null } });
    await fs.writeFile(worldPath, legacyDeleted);
    const legacyReader = createNoraWorldCore({ root, materializer: adapter });
    assert.equal((await legacyReader.getWorld(created.world.world_id)).lifecycle.status, 'DELETED');
    assert.equal(await fs.readFile(worldPath, 'utf8'), legacyDeleted, 'legacy tombstones are read without startup conversion');
    await fs.writeFile(worldPath, JSON.stringify(tombstone));
    // The tombstone is a second independent anti-replay witness if a journal is lost.
    await fs.unlink(operationPath);
    const recovered = createNoraWorldCore({ root, materializer: adapter });
    assert.equal((await recovered.createWorld(input, { idempotencyKey: 'compact:source' })).world.lifecycle.status, 'DELETED');
    assert.equal(adapter.calls, 1);
});

test('never schedules shared resources for physical deletion', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer({ ownership: 'shared' });
    const core = createNoraWorldCore({ root, materializer: adapter });
    const first = await core.createWorld(command(), { idempotencyKey: 'import:delete-shared:one' });
    await core.createWorld(command(), { idempotencyKey: 'import:delete-shared:two' });

    await core.deleteWorld(first.world.world_id, { idempotencyKey: 'delete:shared:one' });
    assert.equal(adapter.deletions[0].plan.runtime_card.delete, false);
});

test('a slow repair cannot resurrect a World deleted by a concurrent mutation', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    let enterInspection;
    let releaseInspection;
    const entered = new Promise(resolve => { enterInspection = resolve; });
    const barrier = new Promise(resolve => { releaseInspection = resolve; });
    adapter.inspect = async () => { enterInspection(); await barrier; return { ready: true, issues: [] }; };
    const core = createNoraWorldCore({ root, materializer: adapter });
    const { world } = await core.createWorld(command(), { idempotencyKey: 'import:repair-delete' });
    const repair = core.repairWorld(world.world_id, { idempotencyKey: 'repair:race' });
    await entered;
    const deletion = core.deleteWorld(world.world_id, { idempotencyKey: 'delete:race' });
    // Old code completes deletion while repair is suspended; fixed code queues it.
    let timer;
    await Promise.race([deletion, new Promise(resolve => { timer = setTimeout(resolve, 150); })]);
    clearTimeout(timer);
    releaseInspection();
    await Promise.all([repair, deletion]);
    assert.equal((await core.getWorld(world.world_id)).lifecycle.status, 'DELETED');
    assert.deepEqual(await core.listWorlds(), []);
});

test('retries a failed deletion from its durable stage without recreating the World', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer({ deleteFailOnce: true });
    const core = createNoraWorldCore({ root, materializer: adapter });
    const created = await core.createWorld(command(), { idempotencyKey: 'import:delete-retry' });
    let failure;
    try {
        await core.deleteWorld(created.world.world_id, { idempotencyKey: 'delete:retry' });
    } catch (error) {
        failure = error;
    }

    assert.equal(failure?.code, 'NORA_WORLD_DELETE_FAILED');
    const failed = await core.getOperation(failure.details.operationId);
    assert.equal(failed.stage, 'WORLD_MARKED_DELETING');
    assert.equal((await core.getWorld(created.world.world_id)).lifecycle.status, 'FAILED');

    const deleted = await core.retryOperation(failed.operation_id);
    assert.equal(deleted.operation.status, 'COMPLETED');
    assert.equal(deleted.world.lifecycle.status, 'DELETED');
    assert.equal(adapter.deletions.length, 2);
});

test('persists a failed repair and retries the same operation after resources are restored', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer({
        inspectResults: [
            { ready: false, issues: [{ code: 'NORA_WORLD_RUNTIME_CARD_MISSING', message: 'missing' }] },
            { ready: true, issues: [] },
        ],
    });
    const core = createNoraWorldCore({ root, materializer: adapter });
    const created = await core.createWorld(command(), { idempotencyKey: 'import:repair-target' });
    let failure;
    try {
        await core.repairWorld(created.world.world_id, { idempotencyKey: 'repair:target' });
    } catch (error) {
        failure = error;
    }

    assert.equal(failure?.code, 'NORA_WORLD_NEEDS_REPAIR');
    const failed = await core.getOperation(failure.details.operationId);
    assert.equal(failed.type, 'REPAIR_WORLD');
    assert.equal(failed.status, 'FAILED');
    assert.equal((await core.getWorld(created.world.world_id)).lifecycle.status, 'FAILED');

    const repaired = await core.retryOperation(failed.operation_id);
    assert.equal(repaired.operation.status, 'COMPLETED');
    assert.equal(repaired.world.lifecycle.status, 'READY');
    assert.equal(repaired.world.lifecycle.error, null);
});

test('persists capability attempts, evidence, timings and stale-attempt protection without changing World readiness', async (t) => {
    const root = await temporaryRoot(t);
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 7, 29, 0, 0, tick++)).toISOString();
    const core = createNoraWorldCore({ root, materializer: materializer(), now });
    const created = await core.createWorld(command(), { idempotencyKey: 'import:capability-state' });

    const firstMvu = await core.beginCapabilityAttempt(created.world.world_id, 'mvu');
    assert.equal(firstMvu.world.lifecycle.status, 'READY');
    assert.equal(firstMvu.world.capabilities.items.mvu.status, 'PENDING');
    assert.equal(firstMvu.world.capabilities.items.mvu.attempts, 1);

    const degraded = await core.settleCapabilityAttempt(
        created.world.world_id,
        'mvu',
        firstMvu.attempt.attempt_id,
        {
            status: 'DEGRADED',
            duration_ms: 5000.04,
            error: {
                code: 'NORA_MVU_TIMEOUT',
                message: 'MVU runtime did not initialize in time.',
                retryable: true,
            },
            evidence: { runtime_source: 'embedded', api_visible: false },
        },
    );
    assert.equal(degraded.lifecycle.status, 'READY');
    assert.equal(degraded.capabilities.status, 'DEGRADED');
    assert.equal(degraded.capabilities.items.mvu.duration_ms, 5000);
    assert.equal(degraded.capabilities.items.mvu.error.code, 'NORA_MVU_TIMEOUT');

    const retry = await core.beginCapabilityAttempt(created.world.world_id, 'mvu');
    assert.equal(retry.world.capabilities.items.mvu.attempts, 2);
    assert.equal(retry.world.capabilities.items.mvu.status, 'PENDING');
    await assert.rejects(
        core.settleCapabilityAttempt(created.world.world_id, 'mvu', firstMvu.attempt.attempt_id, {
            status: 'READY',
            duration_ms: 1,
            error: null,
            evidence: { runtime_source: 'embedded', api_visible: true },
        }),
        error => error?.code === 'NORA_CAPABILITY_ATTEMPT_CONFLICT',
    );

    const mvuReady = await core.settleCapabilityAttempt(created.world.world_id, 'mvu', retry.attempt.attempt_id, {
        status: 'READY',
        duration_ms: 12.34,
        error: null,
        evidence: { runtime_source: 'embedded', api_visible: true },
    });
    assert.equal(mvuReady.capabilities.items.mvu.status, 'READY');
    assert.equal(mvuReady.capabilities.status, 'PENDING', 'regex remains unsettled');

    const regex = await core.beginCapabilityAttempt(created.world.world_id, 'regex');
    const ready = await core.settleCapabilityAttempt(created.world.world_id, 'regex', regex.attempt.attempt_id, {
        status: 'READY',
        duration_ms: 3,
        error: null,
        evidence: { extension_active: true, script_count: 2, character_allowed: true },
    });
    assert.equal(ready.lifecycle.status, 'READY');
    assert.equal(ready.capabilities.status, 'READY');
    assert.equal(ready.capabilities.items.regex.attempts, 1);
});

test('submits a durable operation before background materialization completes', async (t) => {
    const root = await temporaryRoot(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const adapter = materializer({ delay: () => gate });
    const core = createNoraWorldCore({ root, materializer: adapter });

    const submitted = await core.submitWorld(command(), { idempotencyKey: 'import:submitted' });
    assert.equal(submitted.operation.status, 'RUNNING');
    assert.equal(submitted.operation.stage, 'RECEIVED');
    assert.equal(submitted.world, null);
    assert.equal((await core.getOperation(submitted.operation.operation_id)).operation_id, submitted.operation.operation_id);

    release();
    let completed;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        completed = await core.getOperation(submitted.operation.operation_id);
        if (completed.status === 'COMPLETED') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(completed.status, 'COMPLETED');
    assert.equal((await core.listWorlds()).length, 1);

    const repeated = await core.submitWorld(command(), { idempotencyKey: 'import:submitted' });
    assert.equal(repeated.reused, true);
    assert.equal(repeated.operation.operation_id, submitted.operation.operation_id);
    assert.equal(repeated.operation.status, 'COMPLETED');
    assert.equal(repeated.world.world_id, completed.world_id);
});

test('returns one canonical Activation Plan without requiring capability readiness', async (t) => {
    const root = await temporaryRoot(t);
    const core = createNoraWorldCore({ root, materializer: materializer() });
    const created = await core.createWorld(command(), { idempotencyKey: 'import:activation-plan' });

    const plan = await core.prepareOpen(created.world.world_id);
    assert.equal(plan.schema, 'nora-world-activation/v1');
    assert.equal(plan.world_id, created.world.world_id);
    assert.equal(plan.world_revision, created.world.revision);
    assert.equal(plan.runtime_card.resource_id, created.world.runtime_card.resource_id);
    assert.equal(plan.session.session_id, created.world.sessions.default_session_id);
    assert.deepEqual(plan.capabilities, {
        declared: ['mvu', 'regex'],
        status: 'PENDING',
    });
    assert.equal(Object.hasOwn(plan, 'wait_for_capabilities'), false);
});

test('serializes the same operation and returns one World for concurrent retries', async (t) => {
    const root = await temporaryRoot(t);
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const adapter = materializer({ delay: () => gate });
    const core = createNoraWorldCore({ root, materializer: adapter });

    const first = core.createWorld(command(), { idempotencyKey: 'import:concurrent' });
    const second = core.createWorld(command(), { idempotencyKey: 'import:concurrent' });
    await new Promise(resolve => setImmediate(resolve));
    release();
    const [left, right] = await Promise.all([first, second]);

    assert.equal(left.world.world_id, right.world.world_id);
    assert.equal(left.operation.operation_id, right.operation.operation_id);
    assert.equal(adapter.calls, 1);
    assert.equal((await core.listWorlds()).length, 1);
});

test('allows an explicit second World from the same source with a new operation key', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    const core = createNoraWorldCore({ root, materializer: adapter });

    const first = await core.createWorld(command(), { idempotencyKey: 'import:same-source:one' });
    const second = await core.createWorld(command(), { idempotencyKey: 'import:same-source:two' });

    assert.notEqual(first.world.world_id, second.world.world_id);
    assert.equal(adapter.calls, 2);
    assert.equal((await core.listWorlds()).length, 2);
});

test('indexes one shared Runtime Card Resource across explicit Worlds', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer({ ownership: 'shared' });
    const core = createNoraWorldCore({ root, materializer: adapter });

    const first = await core.createWorld(command(), { idempotencyKey: 'import:shared:one' });
    const second = await core.createWorld(command(), { idempotencyKey: 'import:shared:two' });
    const inspected = await core.inspectWorld(first.world.world_id);

    assert.equal(first.world.runtime_card.resource_id, second.world.runtime_card.resource_id);
    assert.deepEqual(inspected.resource_references.runtime_card.world_ids.sort(), [
        first.world.world_id,
        second.world.world_id,
    ].sort());
});

test('rejects reuse of an operation key with a different command', async (t) => {
    const root = await temporaryRoot(t);
    const core = createNoraWorldCore({ root, materializer: materializer() });
    await core.createWorld(command(), { idempotencyKey: 'import:conflict' });

    await assert.rejects(
        core.createWorld(command({ name: '另一个世界' }), { idempotencyKey: 'import:conflict' }),
        error => error?.code === 'NORA_OPERATION_CONFLICT',
    );
});

test('persists a failed operation and retries with the original World identity', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer({ failOnce: true });
    const core = createNoraWorldCore({ root, materializer: adapter });
    let failure;
    try {
        await core.createWorld(command(), { idempotencyKey: 'import:retry' });
    } catch (error) {
        failure = error;
    }

    assert.equal(failure?.code, 'NORA_WORLD_MATERIALIZATION_FAILED');
    assert.ok(failure?.details?.operationId);
    const failed = await core.getOperation(failure.details.operationId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.stage, 'VALIDATED');

    const retried = await core.retryOperation(failed.operation_id);
    assert.equal(retried.operation.operation_id, failed.operation_id);
    assert.equal(retried.world.world_id, failed.world_id);
    assert.equal(retried.operation.attempts, 2);
    assert.equal(retried.operation.status, 'COMPLETED');
});

test('persists a terminal creation failure, releases its staged input, and refuses retry', async (t) => {
    const root = await temporaryRoot(t);
    let releases = 0;
    let materializations = 0;
    const core = createNoraWorldCore({
        root,
        materializer: {
            async materialize() {
                materializations += 1;
                throw new NoraWorldCoreError('NORA_CARD_INVALID', 'Invalid card');
            },
            async releaseStagedInput() {
                releases += 1;
            },
        },
    });

    let failure;
    try {
        await core.createWorld(command(), { idempotencyKey: 'import:terminal-failure' });
    } catch (error) {
        failure = error;
    }
    assert.equal(failure?.code, 'NORA_CARD_INVALID');
    assert.equal(failure?.retryable, false);
    const failed = await core.getOperation(failure.details.operationId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.error.retryable, false);
    assert.ok(failed.input_released_at);
    assert.equal(releases, 1);
    await assert.rejects(
        core.retryOperation(failed.operation_id),
        error => error?.code === 'NORA_CARD_INVALID' && error?.retryable === false,
    );
    await assert.rejects(
        core.createWorld(command(), { idempotencyKey: 'import:terminal-failure' }),
        error => error?.code === 'NORA_CARD_INVALID' && error?.retryable === false,
    );
    assert.equal(materializations, 1);
    assert.equal(releases, 1);
});

test('does not fail a valid World when staged-input cleanup is temporarily unavailable', async (t) => {
    const root = await temporaryRoot(t);
    const adapter = materializer();
    adapter.releaseStagedInput = async () => {
        throw new Error('fixture cleanup interruption');
    };
    const core = createNoraWorldCore({ root, materializer: adapter });

    const created = await core.createWorld(command(), { idempotencyKey: 'import:cleanup-does-not-block' });

    assert.equal(created.operation.status, 'COMPLETED');
    assert.equal(created.world.lifecycle.status, 'READY');
    assert.equal(created.operation.input_released_at, null);
});

for (const interruption of ['before-rename', 'after-rename']) {
    test(`completed receipt survives ${interruption} interruption and retries without recreating its World`, async t => {
        const root = await temporaryRoot(t);
        const adapter = materializer();
        adapter.releaseStagedInput = async () => { throw new Error('keep legacy pending-release record'); };
        const input = command({ payload: { story: 'original input retained until release' } });
        const key = `receipt-interruption:${interruption}`;
        const created = await createNoraWorldCore({ root, materializer: adapter }).createWorld(input, { idempotencyKey: key });
        const operationPath = path.join(root, 'operations', documentFileName(created.operation.operation_id));
        const original = await fs.readFile(operationPath, 'utf8');
        let intercepted = 0;
        const journal = new OperationJournal({ root, fileSystem: {
            ...fs,
            async rename(from, to) {
                if (to !== operationPath) return fs.rename(from, to);
                intercepted += 1;
                if (interruption === 'after-rename') await fs.rename(from, to);
                throw Object.assign(new Error('injected receipt commit interruption'), { code: 'EIO' });
            },
        } });
        await assert.rejects(journal.markInputReleased(created.operation.operation_id), /injected receipt/);
        assert.equal(intercepted, 1);
        const interrupted = await fs.readFile(operationPath, 'utf8');
        if (interruption === 'before-rename') assert.equal(interrupted, original);
        else assert.equal(JSON.parse(interrupted).schema, 'nora-world-operation/v2');

        delete adapter.releaseStagedInput;
        const reopened = createNoraWorldCore({ root, materializer: adapter });
        const retried = await reopened.createWorld(input, { idempotencyKey: key });
        assert.equal(retried.world.world_id, created.world.world_id);
        assert.equal(retried.world.lifecycle.status, 'READY');
        assert.equal(retried.operation.schema, 'nora-world-operation/v2');
        assert.equal(adapter.calls, 1);
        const committed = await fs.readFile(operationPath, 'utf8');
        const again = createNoraWorldCore({ root, materializer: adapter });
        await again.createWorld(input, { idempotencyKey: key });
        assert.equal(await fs.readFile(operationPath, 'utf8'), committed, 'replay must not rewrite the compact receipt');
        assert.equal((await again.listWorlds()).length, 1);
        assert.deepEqual(await fs.readdir(path.join(root, 'quarantine', 'operations')), []);
        assert.deepEqual(await fs.readdir(path.join(root, 'operations')), [path.basename(operationPath)]);
    });
}

test('retries an unfinished terminal staged-input release after restart', async (t) => {
    const root = await temporaryRoot(t);
    const firstCore = createNoraWorldCore({
        root,
        materializer: {
            async materialize() {
                throw new NoraWorldCoreError('NORA_CARD_INVALID', 'Invalid card');
            },
            async releaseStagedInput() {
                throw new Error('fixture cleanup interruption');
            },
        },
    });

    let failure;
    try {
        await firstCore.createWorld(command(), { idempotencyKey: 'import:cleanup-recovery' });
    } catch (error) {
        failure = error;
    }
    const beforeRestart = await firstCore.getOperation(failure.details.operationId);
    assert.equal(beforeRestart.status, 'FAILED');
    assert.equal(beforeRestart.input_released_at, null);

    let recoveredReleases = 0;
    const restartedCore = createNoraWorldCore({
        root,
        materializer: {
            async materialize() {
                assert.fail('a terminal operation must not materialize after restart');
            },
            async releaseStagedInput() {
                recoveredReleases += 1;
            },
        },
    });
    const recovered = await restartedCore.getOperation(beforeRestart.operation_id);
    assert.equal(recovered.input_released_at === null, false);
    assert.equal(recoveredReleases, 1);
});

test('restores Worlds and completed operations after constructing a new core', async (t) => {
    const root = await temporaryRoot(t);
    const firstAdapter = materializer();
    const firstCore = createNoraWorldCore({ root, materializer: firstAdapter });
    const created = await firstCore.createWorld(command(), { idempotencyKey: 'import:restart' });

    const secondAdapter = {
        async materialize() {
            throw new Error('completed operation must not materialize again');
        },
    };
    const secondCore = createNoraWorldCore({ root, materializer: secondAdapter });
    const reused = await secondCore.createWorld(command(), { idempotencyKey: 'import:restart' });

    assert.equal(reused.reused, true);
    assert.equal(reused.world.world_id, created.world.world_id);
    assert.equal((await secondCore.listWorlds()).length, 1);

    const worldsDirectory = path.join(root, 'worlds');
    const movedDirectory = path.join(root, 'worlds-hidden-after-load');
    await fs.rename(worldsDirectory, movedDirectory);
    assert.equal((await secondCore.listWorlds()).length, 1, 'list must use the startup index instead of rescanning');
    await fs.rename(movedDirectory, worldsDirectory);
});

test('recovers after a World manifest commit when journal completion was interrupted', async (t) => {
    const root = await temporaryRoot(t);
    const firstCore = createNoraWorldCore({ root, materializer: materializer() });
    const created = await firstCore.createWorld(command(), { idempotencyKey: 'import:commit-gap' });
    const operationFiles = await fs.readdir(path.join(root, 'operations'));
    assert.equal(operationFiles.length, 1);
    const operationPath = path.join(root, 'operations', operationFiles[0]);
    const interrupted = { ...JSON.parse(await fs.readFile(operationPath, 'utf8')), schema: 'nora-world-operation/v1',
        command: normalizeCreateCommand(command()), materialization: materializationFromWorld(created.world) };
    delete interrupted.request;
    interrupted.stage = 'MATERIALIZED';
    interrupted.status = 'RUNNING';
    await fs.writeFile(operationPath, `${JSON.stringify(interrupted, null, 2)}\n`, 'utf8');

    const restarted = createNoraWorldCore({
        root,
        materializer: {
            async materialize() {
                throw new Error('committed World must recover without materializing again');
            },
        },
    });
    const recovered = await restarted.retryOperation(created.operation.operation_id);

    assert.equal(recovered.world.world_id, created.world.world_id);
    assert.equal(recovered.operation.stage, 'COMPLETED');
    assert.equal(recovered.operation.status, 'COMPLETED');
});

test('quarantines invalid manifests instead of exposing partial Worlds', async (t) => {
    const root = await temporaryRoot(t);
    const worldsDirectory = path.join(root, 'worlds');
    await fs.mkdir(worldsDirectory, { recursive: true });
    await fs.writeFile(path.join(worldsDirectory, 'broken.json'), '{not-json', 'utf8');
    const core = createNoraWorldCore({ root, materializer: materializer() });

    assert.deepEqual(await core.listWorlds(), []);
    const quarantine = await fs.readdir(path.join(root, 'quarantine', 'worlds'));
    assert.equal(quarantine.length, 1);
    assert.match(quarantine[0], /broken\.json\..+\.invalid$/);
});

test('legacy completed records remain readable without startup migration, while failed operations keep retry inputs', async t => {
    const root = await temporaryRoot(t);
    const core = createNoraWorldCore({ root, materializer: materializer() });
    const created = await core.createWorld(command(), { idempotencyKey: 'legacy-completed' });
    const operationPath = path.join(root, 'operations', (await fs.readdir(path.join(root, 'operations')))[0]);
    const legacy = { ...created.operation, schema: 'nora-world-operation/v1', command: normalizeCreateCommand(command()),
        materialization: materializationFromWorld(created.world) };
    delete legacy.request;
    const oldBytes = JSON.stringify(legacy);
    await fs.writeFile(operationPath, oldBytes);
    const modern = await core.createWorld(command({ name: 'New format companion' }), { idempotencyKey: 'modern-companion' });
    const retired = await core.createWorld(command({ name: 'Deleted companion' }), { idempotencyKey: 'deleted-companion' });
    await core.deleteWorld(retired.world.world_id, { idempotencyKey: 'delete-companion' });
    const recordsBefore = new Map();
    for (const folder of ['operations', 'mutations', 'worlds']) {
        for (const name of await fs.readdir(path.join(root, folder))) {
            const file = path.join(root, folder, name);
            recordsBefore.set(file, await fs.readFile(file, 'utf8'));
        }
    }
    const reopened = createNoraWorldCore({ root, materializer: materializer() });
    assert.equal((await reopened.getOperation(created.operation.operation_id)).schema, 'nora-world-operation/v1');
    assert.equal((await reopened.getOperation(modern.operation.operation_id)).schema, 'nora-world-operation/v2');
    assert.equal((await reopened.getWorld(retired.world.world_id)).lifecycle.status, 'DELETED');
    assert.deepEqual(new Set((await reopened.listWorlds()).map(item => item.world_id)), new Set([created.world.world_id, modern.world.world_id]));
    assert.equal(await fs.readFile(operationPath, 'utf8'), oldBytes, 'reading old files must not silently rewrite them');
    for (const [file, bytes] of recordsBefore) assert.equal(await fs.readFile(file, 'utf8'), bytes);

    const failedRoot = await temporaryRoot(t);
    const failing = createNoraWorldCore({ root: failedRoot, materializer: materializer({ failOnce: true }) });
    let operationId;
    await assert.rejects(failing.createWorld(command({ payload: { retry_input: 'keep-this' } }), { idempotencyKey: 'keep-retry-input' }), error => {
        operationId = error.details.operationId;
        return true;
    });
    const failed = await failing.getOperation(operationId);
    assert.equal(failed.schema, 'nora-world-operation/v1');
    assert.equal(failed.command.payload.retry_input, 'keep-this');
    assert.equal((await failing.retryOperation(operationId)).operation.schema, 'nora-world-operation/v2');
});

test('quarantines a journal whose persisted command no longer matches its digest', async (t) => {
    const root = await temporaryRoot(t);
    const firstCore = createNoraWorldCore({ root, materializer: materializer() });
    const created = await firstCore.createWorld(command(), { idempotencyKey: 'import:corrupt-journal' });
    const operationFiles = await fs.readdir(path.join(root, 'operations'));
    const operationPath = path.join(root, 'operations', operationFiles[0]);
    const corrupted = { ...JSON.parse(await fs.readFile(operationPath, 'utf8')), schema: 'nora-world-operation/v1',
        command: normalizeCreateCommand(command()), materialization: materializationFromWorld(created.world) };
    delete corrupted.request;
    corrupted.command.name = 'tampered without updating the digest';
    await fs.writeFile(operationPath, `${JSON.stringify(corrupted, null, 2)}\n`, 'utf8');

    const restarted = createNoraWorldCore({ root, materializer: materializer() });
    assert.equal(await restarted.getOperation(created.operation.operation_id), null);
    assert.equal((await restarted.listWorlds()).length, 1, 'a valid committed World remains authoritative');
    const quarantine = await fs.readdir(path.join(root, 'quarantine', 'operations'));
    assert.equal(quarantine.length, 1);

    const recoveryAdapter = materializer();
    const recoveredCore = createNoraWorldCore({ root, materializer: recoveryAdapter });
    await assert.rejects(
        recoveredCore.createWorld(command({ name: '不允许替换原命令' }), { idempotencyKey: 'import:corrupt-journal' }),
        error => error?.code === 'NORA_OPERATION_CONFLICT',
    );
    const recovered = await recoveredCore.createWorld(command(), { idempotencyKey: 'import:corrupt-journal' });
    assert.equal(recovered.world.world_id, created.world.world_id);
    assert.equal(recovered.operation.status, 'COMPLETED');
    assert.equal(recoveryAdapter.calls, 0, 'the operation index must recover without duplicating compatibility resources');
    assert.equal((await recoveredCore.listWorlds()).length, 1);
});
