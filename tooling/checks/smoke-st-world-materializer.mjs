#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createNoraWorldCore } from '../../app/engine/sillytavern/src/nora-world-core/index.js';
import { createStBackendMaterializer } from '../../app/engine/sillytavern/src/nora-world-core/st-backend-materializer.js';
import { createStCardCodec } from '../../app/engine/sillytavern/src/nora-world-core/st-card-codec.js';
import { stageStCardImport } from '../../app/engine/sillytavern/src/nora-world-core/st-import-staging.js';

const compactOutput = process.argv.includes('--compact');
const cardPaths = process.argv.slice(2).filter(value => value !== '--compact').map(value => path.resolve(value));
const engineRoot = path.resolve(import.meta.dirname, '../../app/engine/sillytavern');
if (!cardPaths.length) {
    console.error('Usage: node ops/scripts/smoke-st-world-materializer.mjs <card.png> [more cards]');
    process.exit(2);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-st-world-smoke-'));
const directories = {
    characters: path.join(root, 'data', 'characters'),
    chats: path.join(root, 'data', 'chats'),
    worlds: path.join(root, 'data', 'worlds'),
};
const stagingRoot = path.join(root, 'staging');
await Promise.all([...Object.values(directories), stagingRoot].map(directory => fs.mkdir(directory, { recursive: true })));

function percentile(values, quantile) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] || 0;
}

async function waitForOperation(core, operationId) {
    let operation;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        operation = await core.getOperation(operationId);
        if (operation.status !== 'RUNNING') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(
        operation.status,
        'COMPLETED',
        `World import failed at ${operation.stage}: ${operation.error?.code || 'UNKNOWN'} ${operation.error?.message || ''}`.trim(),
    );
    return operation;
}

try {
    const materializer = createStBackendMaterializer({
        directories,
        stagingRoot,
        cardCodec: createStCardCodec({ serverRoot: engineRoot }),
        now: () => '2026-08-28T12:00:00.000Z',
    });
    const coreRoot = path.join(root, 'core');
    let core = createNoraWorldCore({ root: coreRoot, materializer });
    const results = [];
    for (const [index, sourcePath] of cardPaths.entries()) {
        const worldCountBefore = (await core.listWorlds()).length;
        const idempotencyKey = `smoke:${index}:${path.basename(sourcePath)}`;
        const importStartedAt = performance.now();
        const command = await stageStCardImport({
            uploadedFile: { path: sourcePath, originalname: path.basename(sourcePath) },
            idempotencyKey,
            persona: { name: 'Smoke Test', description: '' },
            stagingRoot,
        });
        const [firstReceipt, secondReceipt] = await Promise.all([
            core.submitWorld(command, { idempotencyKey }),
            core.submitWorld(command, { idempotencyKey }),
        ]);
        assert.equal(firstReceipt.operation.operation_id, secondReceipt.operation.operation_id);
        const operation = await waitForOperation(core, firstReceipt.operation.operation_id);
        const importDurationMs = performance.now() - importStartedAt;
        const world = await core.getWorld(operation.world_id);
        const openStartedAt = performance.now();
        const plan = await core.prepareOpen(world.world_id);
        const prepareOpenDurationMs = performance.now() - openStartedAt;
        const created = { operation, world };

        const avatar = created.world.runtime_card.binding.avatar;
        const session = created.world.sessions.items[0];
        const chatPath = path.join(directories.chats, path.parse(avatar).name, `${session.binding.chat_id}.jsonl`);
        const chatLines = (await fs.readFile(chatPath, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(created.operation.status, 'COMPLETED');
        assert.ok(created.world.name && created.world.name !== path.parse(sourcePath).name, 'the authoritative World name must come from the decoded card');
        assert.equal(plan.world_id, created.world.world_id);
        assert.equal(plan.session.session_id, created.world.sessions.default_session_id);
        assert.equal(plan.runtime_card.binding.avatar, avatar);
        assert.equal((await fs.stat(path.join(directories.characters, avatar))).isFile(), true);
        assert.equal(chatLines[0].chat_metadata.nora_world.id, created.world.world_id);
        assert.equal(chatLines.length, session.opening_state === 'empty' ? 1 : 2);
        for (const knowledge of created.world.knowledge) {
            assert.equal((await fs.stat(path.join(directories.worlds, `${knowledge.binding.name}.json`))).isFile(), true);
        }
        await assert.rejects(fs.stat(command.payload.staged_card.path), error => error?.code === 'ENOENT');
        assert.equal((await core.listWorlds()).length, worldCountBefore + 1, 'one import key must create exactly one World');
        results.push({
            source: path.basename(sourcePath),
            name: created.world.name,
            world_id: created.world.world_id,
            avatar,
            opening_state: session.opening_state,
            worldbooks: created.world.knowledge.map(item => item.binding.name),
            capabilities: created.world.capabilities.declared,
            import_duration_ms: Math.round(importDurationMs * 10) / 10,
            prepare_open_duration_ms: Math.round(prepareOpenDurationMs * 10) / 10,
        });
    }

    core = createNoraWorldCore({ root: coreRoot, materializer });
    const restartedWorlds = await core.listWorlds();
    assert.equal(restartedWorlds.length, results.length, 'a process restart must restore every authoritative World');
    const listDurations = [];
    for (let sample = 0; sample < 20; sample += 1) {
        const listStartedAt = performance.now();
        assert.equal((await core.listWorlds()).length, results.length);
        listDurations.push(performance.now() - listStartedAt);
    }
    for (const [index, result] of results.entries()) {
        assert.equal((await core.prepareOpen(result.world_id)).world_id, result.world_id);
        const repaired = await core.repairWorld(result.world_id, { idempotencyKey: `smoke-repair:${index}:${result.source}` });
        assert.equal(repaired.world.lifecycle.status, 'READY');
    }

    const explicitSourcePath = cardPaths[0];
    const explicitKey = `smoke-explicit:${path.basename(explicitSourcePath)}`;
    const explicitCommand = await stageStCardImport({
        uploadedFile: { path: explicitSourcePath, originalname: path.basename(explicitSourcePath) },
        idempotencyKey: explicitKey,
        persona: { name: 'Smoke Test', description: '' },
        worldName: `${results[0].name} · 显式第二世界`,
        stagingRoot,
    });
    const explicitReceipt = await core.submitWorld(explicitCommand, { idempotencyKey: explicitKey });
    const explicitOperation = await waitForOperation(core, explicitReceipt.operation.operation_id);
    assert.notEqual(explicitOperation.world_id, results[0].world_id, 'a new operation key must create an explicit second World');
    assert.equal((await core.listWorlds()).length, results.length + 1);
    const deletedExplicit = await core.deleteWorld(explicitOperation.world_id, { idempotencyKey: `delete:${explicitKey}` });
    assert.equal(deletedExplicit.world.lifecycle.status, 'DELETED');
    assert.equal((await core.prepareOpen(results[0].world_id)).world_id, results[0].world_id, 'deleting one same-source World must preserve the other');

    for (const [index, result] of results.entries()) {
        const deleted = await core.deleteWorld(result.world_id, { idempotencyKey: `smoke-delete:${index}:${result.source}` });
        assert.equal(deleted.world.lifecycle.status, 'DELETED');
    }
    assert.deepEqual(await core.listWorlds(), []);
    for (const name of new Set(results.flatMap(result => result.worldbooks))) {
        assert.equal((await fs.stat(path.join(directories.worlds, `${name}.json`))).isFile(), true, 'shared Worldbooks must survive World deletion');
    }

    const importDurations = results.map(result => result.import_duration_ms);
    const openDurations = results.map(result => result.prepare_open_duration_ms);
    const report = {
        ok: true,
        cards: results,
        lifecycle: {
            restart_restored_worlds: restartedWorlds.length,
            repaired_worlds: results.length,
            explicit_second_world: true,
            deleted_worlds: results.length + 1,
            remaining_worlds: 0,
        },
        timings: {
            import_p50_ms: percentile(importDurations, 0.5),
            import_p95_ms: percentile(importDurations, 0.95),
            list_worlds_p50_ms: Math.round(percentile(listDurations, 0.5) * 10) / 10,
            list_worlds_p95_ms: Math.round(percentile(listDurations, 0.95) * 10) / 10,
            prepare_open_p50_ms: percentile(openDurations, 0.5),
            prepare_open_p95_ms: percentile(openDurations, 0.95),
        },
    };
    if (compactOutput) {
        report.cards = results.map(result => ({
            source: result.source,
            name: result.name,
            opening_state: result.opening_state,
            worldbook_count: result.worldbooks.length,
            capabilities: result.capabilities,
        }));
    }
    console.log(JSON.stringify(report, null, 2));
} finally {
    await fs.rm(root, { recursive: true, force: true });
}
