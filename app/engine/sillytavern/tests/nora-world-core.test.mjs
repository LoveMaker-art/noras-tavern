import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNoraWorldCore, NoraWorldCoreError } from '../src/nora-world-core/index.js';

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
    const deletions = [];
    let inspections = 0;
    return {
        get calls() {
            return calls;
        },
        get deletions() {
            return deletions;
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
        'beginCapabilityAttempt',
        'createWorld',
        'deleteWorld',
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
    ]);

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
    const interrupted = JSON.parse(await fs.readFile(operationPath, 'utf8'));
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

test('quarantines a journal whose persisted command no longer matches its digest', async (t) => {
    const root = await temporaryRoot(t);
    const firstCore = createNoraWorldCore({ root, materializer: materializer() });
    const created = await firstCore.createWorld(command(), { idempotencyKey: 'import:corrupt-journal' });
    const operationFiles = await fs.readdir(path.join(root, 'operations'));
    const operationPath = path.join(root, 'operations', operationFiles[0]);
    const corrupted = JSON.parse(await fs.readFile(operationPath, 'utf8'));
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
