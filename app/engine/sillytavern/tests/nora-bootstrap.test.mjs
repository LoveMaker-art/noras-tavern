import assert from 'node:assert/strict';
import test from 'node:test';

import { createBootstrapPayload, createShellPayload, projectShellWorld, selectBootstrapLastWorldId } from '../src/nora-bootstrap.js';
import { selectNoraLastWorldId } from '../src/settings-runtime.js';

test('bootstrap exposes only authoritative World v2 startup data', async () => {
    const started = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = createBootstrapPayload({
        csrfToken: 'token',
        directories: { characters: '/characters', chats: '/chats' },
        assetRelease: '0123456789abcdef',
        readRuntimeSettingsFn: async directories => {
            started.push(['runtime-settings', directories]);
            await gate;
            return { settings: '{"main_api":"openai","extension_settings":{"nora_ui":{"lastWorldId":"world:last"}}}' };
        },
        readSecretStateFn: async directories => {
            started.push(['secret-state', directories]);
            await gate;
            return { api_key_openai: true };
        },
        readVersionFn: async () => {
            started.push(['version']);
            await gate;
            return { agent: 'Nora:1', pkgVersion: '1.0.0' };
        },
        readAgentUserIdFn: async () => {
            started.push(['agent-user-id']);
            await gate;
            return 'usr_nora';
        },
    });

    await Promise.resolve();
    assert.deepEqual(started.map(item => item[0]), ['runtime-settings', 'secret-state', 'version', 'agent-user-id']);
    release();

    const result = await pending;
    assert.equal(typeof result.fetchedAt, 'number');
    assert.deepEqual({ ...result, fetchedAt: 0 }, {
        schema: 8,
        assetRelease: '0123456789abcdef',
        csrfToken: 'token',
        runtimeSettings: { settings: '{"main_api":"openai","extension_settings":{"nora_ui":{"lastWorldId":"world:last"}}}' },
        lastWorldId: 'world:last',
        secretState: { api_key_openai: true },
        version: { agent: 'Nora:1', pkgVersion: '1.0.0' },
        agentUserId: 'usr_nora',
        fetchedAt: 0,
    });
    assert.deepEqual(started.map(item => item[0]), ['runtime-settings', 'secret-state', 'version', 'agent-user-id']);
});

test('shell bootstrap projects compact World summaries without runtime bindings', async () => {
    const world = {
        world_id: 'world:one',
        revision: 7,
        name: '夜之帝国',
        lifecycle: { status: 'READY' },
        capabilities: { status: 'PENDING', items: { mvu: { status: 'PENDING' } } },
        sessions: {
            default_session_id: 'session:one',
            items: [{ session_id: 'session:one', opening_state: 'message', binding: { chat_id: 'secret-chat' } }],
        },
        runtime_card: { binding: { avatar: 'secret-avatar.png' } },
        story_context: { large: 'private runtime data' },
        updated_at: '2026-09-03T00:00:00.000Z',
    };

    assert.deepEqual(projectShellWorld(world), {
        id: 'world:one',
        revision: 7,
        name: '夜之帝国',
        lifecycleStatus: 'READY',
        capabilityStatus: 'PENDING',
        openingState: 'message',
        updatedAt: '2026-09-03T00:00:00.000Z',
    });

    const payload = await createShellPayload({
        assetRelease: '0123456789abcdef',
        listWorldsFn: async () => [world],
    });
    assert.equal(payload.schema, 1);
    assert.equal(payload.assetRelease, '0123456789abcdef');
    assert.equal(typeof payload.fetchedAt, 'number');
    assert.deepEqual(payload.worlds, [projectShellWorld(world)]);
    assert.equal(JSON.stringify(payload).includes('secret-chat'), false);
    assert.equal(JSON.stringify(payload).includes('private runtime data'), false);
});

test('bootstrap extracts the persisted last World without making the compact shell read settings', async () => {
    assert.equal(selectNoraLastWorldId({ extension_settings: { nora_ui: { lastWorldId: ' world:ready ' } } }), 'world:ready');
    assert.equal(selectNoraLastWorldId({}), '');
    assert.equal(selectBootstrapLastWorldId({ settings: '{"extension_settings":{"nora_ui":{"lastWorldId":" world:ready "}}}' }), 'world:ready');
    assert.equal(selectBootstrapLastWorldId({ settings: '{broken' }), '');

    const payload = await createShellPayload({
        assetRelease: '0123456789abcdef',
        listWorldsFn: async () => [],
    });
    assert.equal(Object.hasOwn(payload, 'lastWorldId'), false);
});
