import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createWorldCoreRuntime } from '../public/scripts/nora-worlds/world-core-runtime.js';

function deferred() {
    let resolve;
    const promise = new Promise(accept => { resolve = accept; });
    return { promise, resolve };
}

function manifest(overrides = {}) {
    return {
        world_id: 'world:one',
        revision: 1,
        name: 'One',
        persona: { name: '', description: '' },
        lifecycle: { status: 'READY', error: null },
        runtime_card: { binding: { avatar: 'one.png' } },
        sessions: {
            default_session_id: 'session:one',
            items: [{ session_id: 'session:one', binding: { avatar: 'one.png', chat_id: 'chat-one' }, opening_state: 'empty' }],
        },
        capabilities: { declared: ['mvu'], status: 'PENDING', items: { mvu: { status: 'PENDING' } } },
        ...overrides,
    };
}

test('authoritative World list is available before pending import recovery settles', async () => {
    const recovery = deferred();
    const recovered = manifest({ world_id: 'world:recovered', name: 'Recovered' });
    let worlds = [manifest()];
    let listCalls = 0;
    const states = [];
    const runtime = createWorldCoreRuntime({
        read: () => ({ characters: [], activeCharacter: null, metadata: {}, chatId: '' }),
    }, {
        client: {
            pendingCreation: () => ({ idempotencyKey: 'browser:pending', operationId: 'operation:pending' }),
            resumePendingCreation: async () => recovery.promise,
            list: async () => {
                listCalls += 1;
                return worlds;
            },
            prepareSnapshot: async () => { throw new Error('not used'); },
        },
        refreshCharacters: async () => {},
    });
    runtime.subscribe(state => states.push(state.operation.status));

    const listed = await runtime.refresh();
    assert.deepEqual(listed.map(world => world.id), ['world:one']);
    assert.equal(runtime.status().operation.status, 'RUNNING');
    assert.equal(listCalls, 1);

    worlds = [manifest(), recovered];
    recovery.resolve({ operation: { operation_id: 'operation:pending' }, world: recovered });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(runtime.list().map(world => world.id), ['world:one', 'world:recovered']);
    assert.equal(runtime.status().operation.status, 'COMPLETED');
    assert.ok(states.includes('RUNNING'));
    assert.ok(states.includes('COMPLETED'));
});

test('product World read model keeps ST bindings private and retains unavailable Worlds', async () => {
    const runtime = createWorldCoreRuntime({
        read: () => ({ characters: [], activeCharacter: null, metadata: {}, chatId: '' }),
    }, {
        client: {
            list: async () => [manifest()],
            prepareSnapshot: async () => { throw new Error('not used'); },
        },
    });
    await runtime.refresh();
    const [world] = runtime.list();

    assert.equal(world.id, 'world:one');
    assert.equal(world.available, false);
    assert.equal(world.openingState, 'empty');
    assert.equal(world.meta, '世界 · 需要修复');
    for (const privateField of ['character', 'characterId', 'characterAvatar', 'chatId', 'chatName', 'manifest']) {
        assert.equal(Object.hasOwn(world, privateField), false, `${privateField} leaked through the product World model`);
    }
});

test('repair and delete stay behind the World Runtime interface and refresh the authoritative list', async () => {
    let worlds = [manifest({ lifecycle: { status: 'FAILED', error: { code: 'NORA_WORLD_NEEDS_REPAIR' } } })];
    const calls = [];
    const runtime = createWorldCoreRuntime({
        read: () => ({ characters: [{ avatar: 'one.png' }], activeCharacter: null, metadata: {}, chatId: '' }),
    }, {
        client: {
            list: async () => worlds,
            prepareSnapshot: async () => { throw new Error('not used'); },
            async repairWorld(worldId, options) {
                calls.push({ kind: 'repair', worldId, options });
                worlds = [manifest()];
                return { world: worlds[0], operation: { operation_id: 'operation:repair', status: 'COMPLETED' } };
            },
            async deleteWorld(worldId, options) {
                calls.push({ kind: 'delete', worldId, options });
                worlds = [];
                return { world: manifest({ lifecycle: { status: 'DELETED', error: null } }), operation: { operation_id: 'operation:delete', status: 'COMPLETED' } };
            },
        },
        refreshCharacters: async () => {},
    });

    await runtime.refresh();
    const repaired = await runtime.repair('world:one', { idempotencyKey: 'repair:one' });
    assert.equal(repaired.available, true);
    await runtime.remove('world:one', { idempotencyKey: 'delete:one' });
    assert.deepEqual(runtime.list(), []);
    assert.deepEqual(calls, [
        { kind: 'repair', worldId: 'world:one', options: { idempotencyKey: 'repair:one' } },
        { kind: 'delete', worldId: 'world:one', options: { idempotencyKey: 'delete:one' } },
    ]);
});

test('prepares Prompt Template before rendering an EJS World snapshot', async () => {
    const calls = [];
    const pending = manifest({
        capabilities: {
            declared: ['prompt_template'],
            status: 'PENDING',
            items: { prompt_template: { status: 'PENDING' } },
        },
    });
    const ready = structuredClone(pending);
    ready.capabilities.status = 'READY';
    ready.capabilities.items.prompt_template.status = 'READY';
    const runtimeState = {
        characters: [{ avatar: 'one.png', data: { first_mes: '<%= getvar("opening") %>' } }],
        activeCharacter: null,
        metadata: {},
        chatId: '',
    };
    const runtime = createWorldCoreRuntime({ read: () => runtimeState }, {
        client: {
            list: async () => [pending],
            beginCapabilityAttempt: async () => ({ attempt: { attempt_id: 'attempt:prompt' } }),
            settleCapabilityAttempt: async () => ({ world: ready }),
            prepareSnapshot: async () => {
                calls.push('snapshot');
                return { plan: { world_id: 'world:one' }, character: runtimeState.characters[0], worldbooks: [] };
            },
        },
        capabilityRuntime: {
            resolveCharacter: async () => runtimeState.characters[0],
            inspectSnapshotCharacter: () => ({ promptTemplateDeclared: true, promptTemplateReasons: ['ejs-syntax'] }),
            preparePromptTemplate: async () => {
                calls.push('capability:prompt_template');
                return { engine: 'sillytavern', extension_active: true };
            },
            ensureCharacterCapability: async (_character, capability) => {
                calls.push(`capability:${capability}`);
                return { engine: 'sillytavern', extension_active: true };
            },
        },
        executeSnapshot: async () => { calls.push('render'); },
    });

    await runtime.refresh();
    await runtime.activate('world:one');

    assert.deepEqual(calls, ['snapshot', 'capability:prompt_template', 'render']);
});

test('prepares managed MVU runtime before the World chat lifecycle is rendered', async () => {
    const calls = [];
    const runtimeState = {
        characters: [{ avatar: 'one.png', data: { character_book: { entries: [{ comment: '[InitVar]', content: '{}' }] } } }],
        activeCharacter: null,
        metadata: {},
        chatId: '',
    };
    const runtime = createWorldCoreRuntime({ read: () => runtimeState }, {
        client: {
            list: async () => [manifest()],
            beginCapabilityAttempt: async () => ({ attempt: { attempt_id: 'attempt:mvu' } }),
            settleCapabilityAttempt: async () => ({ world: manifest() }),
            prepareSnapshot: async () => {
                calls.push('snapshot');
                return { plan: { world_id: 'world:one' }, character: runtimeState.characters[0], worldbooks: [] };
            },
        },
        capabilityRuntime: {
            inspectSnapshotCharacter: () => ({ mvuDeclared: true, mvuRuntimeSource: 'managed' }),
            prepareSnapshotCapabilities: async () => { calls.push('capability-runtime:mvu'); },
            resolveCharacter: async () => runtimeState.characters[0],
            ensureCharacterCapability: async () => ({ engine: 'sillytavern' }),
        },
        executeSnapshot: async () => { calls.push('render'); },
    });

    await runtime.refresh();
    await runtime.activate('world:one');

    assert.deepEqual(calls, ['snapshot', 'capability-runtime:mvu', 'render']);
});

test('Nora World UI carries only worldId and has one open/capability owner', () => {
    const uiRoot = path.resolve(import.meta.dirname, '../../../native-extensions/nora-ui');
    const worldController = fs.readFileSync(path.join(uiRoot, 'world-controller.js'), 'utf8');
    const startupController = fs.readFileSync(path.join(uiRoot, 'startup-controller.js'), 'utf8');
    const creationController = fs.readFileSync(path.join(uiRoot, 'world-creation-controller.js'), 'utf8');

    assert.doesNotMatch(worldController, /data-character=|data-chat=/);
    assert.match(worldController, /worldRuntime\.activate\(current\.id\)/);
    assert.match(worldController, /loadWorldCapabilities\(world\.id\)/);
    assert.match(worldController, /worldRuntime\.remove\(worldId\)/);
    assert.match(worldController, /confirmAction\(\{/);
    assert.doesNotMatch(startupController, /loadWorldCapabilities|promptCharacterCapabilities|primeActiveWorldbook/);
    assert.match(creationController, /const completed = await runWorldOperation/);
    assert.match(creationController, /if \(completed && importedWorldId\)[\s\S]*openWorldById\(importedWorldId/);
    assert.doesNotMatch(creationController, /capabilities\.load\(world\)/);
});
