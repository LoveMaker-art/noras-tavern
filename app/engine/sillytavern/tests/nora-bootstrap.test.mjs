import assert from 'node:assert/strict';
import test from 'node:test';

import { createBootstrapPayload } from '../src/nora-bootstrap.js';

test('bootstrap exposes only authoritative World v2 startup data', async () => {
    const started = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = createBootstrapPayload({
        csrfToken: 'token',
        directories: { characters: '/characters', chats: '/chats' },
        listCharactersFn: async directories => {
            started.push(['characters', directories]);
            await gate;
            return [{ name: 'Nora' }];
        },
        readRuntimeSettingsFn: async directories => {
            started.push(['runtime-settings', directories]);
            await gate;
            return { settings: '{"main_api":"openai"}' };
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
    assert.deepEqual(started.map(item => item[0]), ['characters', 'runtime-settings', 'secret-state', 'version', 'agent-user-id']);
    release();

    const result = await pending;
    assert.equal(typeof result.fetchedAt, 'number');
    assert.deepEqual({ ...result, fetchedAt: 0 }, {
        schema: 6,
        csrfToken: 'token',
        characters: [{ name: 'Nora' }],
        runtimeSettings: { settings: '{"main_api":"openai"}' },
        secretState: { api_key_openai: true },
        version: { agent: 'Nora:1', pkgVersion: '1.0.0' },
        agentUserId: 'usr_nora',
        fetchedAt: 0,
    });
    assert.deepEqual(started.map(item => item[0]), ['characters', 'runtime-settings', 'secret-state', 'version', 'agent-user-id']);
});
