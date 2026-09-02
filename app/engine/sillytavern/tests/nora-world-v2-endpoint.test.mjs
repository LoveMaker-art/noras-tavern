import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';
import { stageBlankWorld, stageStCardImport } from '../src/nora-world-core/st-import-staging.js';

async function temporaryRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-world-v2-endpoint-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

function handler(router, routePath, method) {
    const layer = router.stack.find(item => item.route?.path === routePath && item.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} must be registered`);
    return layer.route.stack.find(item => item.method === method).handle;
}

async function invoke(routeHandler, request = {}) {
    const reply = { statusCode: 200, payload: null, headers: {} };
    const response = {
        status(code) {
            reply.statusCode = code;
            return this;
        },
        json(payload) {
            reply.payload = payload;
            return this;
        },
        setHeader(name, value) {
            reply.headers[String(name).toLowerCase()] = value;
            return this;
        },
        end() {
            return this;
        },
    };
    await routeHandler({ body: {}, params: {}, headers: {}, ...request }, response, () => {
        reply.next = true;
    });
    return reply;
}

test('stages one immutable card command per idempotency key', async (t) => {
    const root = await temporaryRoot(t);
    const upload = path.join(root, 'upload.bin');
    const stagingRoot = path.join(root, 'staging');
    await fs.writeFile(upload, Buffer.from('card bytes'));
    const input = {
        uploadedFile: { path: upload, originalname: 'card.png' },
        idempotencyKey: 'browser:one',
        persona: { name: 'Nora', description: '' },
        stagingRoot,
    };

    const first = await stageStCardImport(input);
    const repeated = await stageStCardImport(input);
    assert.deepEqual(repeated, first);
    assert.equal(first.name, 'card');
    assert.equal(first.payload.world_name_source, 'card');
    assert.equal(first.source.format, 'png');
    assert.equal(path.dirname(first.payload.staged_card.path), stagingRoot);
    assert.equal((await fs.readdir(stagingRoot)).length, 1);

    await fs.writeFile(upload, Buffer.from('different card'));
    await assert.rejects(stageStCardImport(input), error => error?.code === 'NORA_OPERATION_CONFLICT');
});

test('stages every character import container accepted by the pinned ST importer', async (t) => {
    const root = await temporaryRoot(t);
    for (const extension of ['png', 'json', 'yaml', 'yml', 'charx', 'byaf']) {
        const upload = path.join(root, `upload-${extension}`);
        await fs.writeFile(upload, Buffer.from(`card-${extension}`));
        const staged = await stageStCardImport({
            uploadedFile: { path: upload, originalname: `card.${extension}` },
            idempotencyKey: `format:${extension}`,
            stagingRoot: path.join(root, 'staging'),
        });
        assert.equal(staged.source.format, extension);
    }
});

test('stages one immutable internal Runtime Card for a blank World', async (t) => {
    const stagingRoot = path.join(await temporaryRoot(t), 'staging');
    const input = {
        idempotencyKey: 'browser:blank-one',
        worldName: '我的空白世界',
        persona: { name: 'Nora', description: '' },
        stagingRoot,
    };

    const first = await stageBlankWorld(input);
    const repeated = await stageBlankWorld(input);

    assert.deepEqual(repeated, first);
    assert.equal(first.name, '我的空白世界');
    assert.equal(first.source.type, 'blank-world');
    assert.equal(first.source.format, 'json');
    assert.equal(first.payload.world_name_source, 'explicit');
    assert.equal(first.payload.runtime_card_kind, 'nora-internal-blank');
    assert.equal((await fs.readdir(stagingRoot)).length, 1);
});

test('exposes the authoritative v2 import, operation, list and open-plan contract', async (t) => {
    const world = {
        world_id: 'world:one',
        name: 'World One',
        runtime_card: { binding: { avatar: 'one.png' } },
    };
    const operation = {
        schema: 'nora-world-operation/v1',
        operation_id: 'operation:one',
        type: 'CREATE_WORLD',
        world_id: world.world_id,
        stage: 'COMPLETED',
        status: 'COMPLETED',
        attempts: 1,
        error: null,
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:01.000Z',
        command: { payload: { staged_card: { path: '/must/not/leak' } } },
        idempotency_hash: 'secret',
    };
    const core = {
        async submitWorld() { return { operation, world, reused: false }; },
        async getOperation() { return operation; },
        async getWorld() { return world; },
        async listWorlds() { return [world]; },
        async prepareOpen() { return { schema: 'nora-world-activation/v1', world_id: world.world_id }; },
        async retryOperation() { return { operation, world, reused: true }; },
        async repairWorld() { return { operation: { ...operation, type: 'REPAIR_WORLD' }, world, reused: false }; },
        async deleteWorld() {
            return {
                operation: { ...operation, type: 'DELETE_WORLD', result: { deleted: true } },
                world: { ...world, lifecycle: { status: 'DELETED', error: null } },
                reused: false,
            };
        },
        async beginCapabilityAttempt(worldId, capability) {
            return { world, attempt: { attempt_id: 'capability-attempt:one', capability, world_id: worldId } };
        },
        async settleCapabilityAttempt() {
            return { ...world, capabilities: { status: 'READY' } };
        },
    };
    const router = createNoraWorldsV2Router({
        resolveCore: () => core,
        stageImport: async () => ({ name: 'World One', persona: { name: '', description: '' }, source: {}, payload: {} }),
        stageBlank: async ({ worldName, persona }) => ({
            name: worldName,
            persona,
            source: { type: 'blank-world' },
            payload: { runtime_card_kind: 'nora-internal-blank' },
        }),
        cleanupUpload: async () => {},
        cleanupStagedCard: async () => {},
        getSnapshotRevision: async () => 'revision-one',
        readSnapshot: async plan => ({
            snapshot: { schema: 'nora-world-snapshot/v1', revision: 'revision-one', plan, character: {}, chat: { messages: [] }, worldbooks: [] },
            timings: { character: 1.2, chat: 2.3, worldbooks: 0.4 },
        }),
    });
    const baseRequest = {
        file: { path: '/upload', originalname: 'one.png' },
        user: { directories: { root: '/user' } },
    };
    const status = await invoke(handler(router, '/status', 'get'), baseRequest);
    assert.deepEqual(status.payload, { enabled: true, schema: 2, userDataRoot: '/user' });
    assert.equal(status.headers['cache-control'], 'no-store');

    const imported = (await invoke(handler(router, '/imports', 'post'), {
        ...baseRequest,
        body: { idempotency_key: 'browser:one' },
    })).payload;
    assert.equal(imported.operation.operation_id, operation.operation_id);
    assert.equal(Object.hasOwn(imported.operation, 'command'), false);
    assert.equal(Object.hasOwn(imported.operation, 'idempotency_hash'), false);

    const created = await invoke(handler(router, '/worlds', 'post'), {
        ...baseRequest,
        body: {
            idempotency_key: 'browser:blank-one',
            name: '空白世界',
            persona_name: 'Nora',
            persona_description: '',
        },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.payload.world.world_id, world.world_id);

    const polled = (await invoke(handler(router, '/operations/:operationId', 'get'), {
        ...baseRequest,
        params: { operationId: operation.operation_id },
    })).payload;
    assert.equal(polled.world.world_id, world.world_id);
    const listed = (await invoke(handler(router, '/worlds', 'get'), baseRequest)).payload;
    assert.deepEqual(listed.worlds, [world]);
    const opened = (await invoke(handler(router, '/worlds/:worldId/open-plan', 'get'), {
        ...baseRequest,
        params: { worldId: world.world_id },
    })).payload;
    assert.equal(opened.plan.schema, 'nora-world-activation/v1');

    const snapshot = await invoke(handler(router, '/worlds/:worldId/snapshot', 'get'), {
        ...baseRequest,
        params: { worldId: world.world_id },
    });
    assert.equal(snapshot.payload.snapshot.revision, 'revision-one');
    assert.equal(snapshot.headers.etag, '"revision-one"');
    assert.match(snapshot.headers['server-timing'], /nora_character;dur=1\.2/);

    const unchanged = await invoke(handler(router, '/worlds/:worldId/snapshot', 'get'), {
        ...baseRequest,
        headers: { 'if-none-match': '"revision-one"' },
        params: { worldId: world.world_id },
    });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.payload, null);

    const begun = await invoke(handler(router, '/worlds/:worldId/capabilities/:capability/attempts', 'post'), {
        ...baseRequest,
        params: { worldId: world.world_id, capability: 'mvu' },
    });
    assert.equal(begun.statusCode, 201);
    assert.equal(begun.payload.attempt.capability, 'mvu');

    const settled = await invoke(handler(router, '/worlds/:worldId/capabilities/:capability/attempts/:attemptId', 'put'), {
        ...baseRequest,
        body: { status: 'READY', duration_ms: 12, error: null, evidence: { api_visible: true } },
        params: { worldId: world.world_id, capability: 'mvu', attemptId: begun.payload.attempt.attempt_id },
    });
    assert.equal(settled.payload.world.capabilities.status, 'READY');

    const repaired = await invoke(handler(router, '/worlds/:worldId/repair', 'post'), {
        ...baseRequest,
        body: { idempotency_key: 'repair:one' },
        params: { worldId: world.world_id },
    });
    assert.equal(repaired.payload.operation.type, 'REPAIR_WORLD');

    const deleted = await invoke(handler(router, '/worlds/:worldId', 'delete'), {
        ...baseRequest,
        body: { idempotency_key: 'delete:one' },
        params: { worldId: world.world_id },
    });
    assert.equal(deleted.payload.operation.type, 'DELETE_WORLD');
    assert.deepEqual(deleted.payload.operation.result, { deleted: true });
});

test('keeps the authoritative World v2 surface permanently enabled', async () => {
    const router = createNoraWorldsV2Router();
    const status = await invoke(handler(router, '/status', 'get'));
    assert.deepEqual(status.payload, { enabled: true, schema: 2, userDataRoot: null });
    const guard = router.stack.find(item => !item.route && item.name === 'enabled');
    assert.equal(guard, undefined, 'the only online World surface must not retain a feature-flag fork');
});
