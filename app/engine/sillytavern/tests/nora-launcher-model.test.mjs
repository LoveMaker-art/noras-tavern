import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStModelAdapter } from '../public/scripts/nora-adapters/st-model-adapter.js';
import { createModelProfiles } from '../public/scripts/nora-adapters/model-profiles.js';
import { projectTextModelDisplay } from '../../../native-extensions/nora-ui/model-display.js';

for (const [source, modelField, secretKey] of [
    ['claude', 'claude_model', 'api_key_claude'], ['makersuite', 'google_model', 'api_key_makersuite'],
]) {
    test(`${source}: managed model is selected, reconnects natively, and can be reselected`, async t => {
        const requests = [], connections = [];
        t.mock.method(globalThis, 'fetch', async (url, options) => {
            const payload = JSON.parse(options.body); requests.push({ url, payload });
            return { ok: true, status: 200, json: async () => url.endsWith('/read') ? { [secretKey]: [{ id: 'old', active: true }] } : {} };
        });
        const runtime = {
            mainApi: 'openai', onlineStatus: 'no_connection',
            chatCompletionSettings: { chat_completion_source: source, [modelField]: 'fixture-model', openai_max_context: 8192, openai_max_tokens: 2048 },
            getRequestHeaders: () => ({}),
            configureProviderChatCompletion: async options => { connections.push(options); runtime.onlineStatus = 'connected'; },
            configureCustomChatCompletion: async () => { throw new Error('Native provider must not use custom OpenAI protocol'); },
        };
        const adapter = createStModelAdapter(() => runtime);
        await adapter.ensureReady();
        assert.equal(connections[0].source, source);
        const ui = { activeModel: 'custom-user', modelProfiles: [], hermesModel: {
            source, secretKey, provider: 'Fixture Provider', model: 'fixture-model', secretId: 'managed',
            base: 'https://provider.invalid', context: 8192, tokens: 2048,
        } };
        const profiles = createModelProfiles({ model: adapter.actions, settings: () => ui, persist: async () => {} });
        await profiles.select('hermes');
        assert.equal(ui.activeModel, '');
        assert.deepEqual(requests.find(request => request.url.endsWith('/rotate')).payload, { key: secretKey, id: 'managed' });
        assert.equal(connections.at(-1).source, source);
        assert.equal(projectTextModelDisplay({ nativeModel: runtime.chatCompletionSettings, uiSettings: ui }).label, 'Fixture Provider · fixture-model');
    });
}

test('OpenAI-compatible imported defaults retain the original custom protocol', async t => {
    let configured;
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ api_key_custom: [{ id: 'managed', active: true }] }) }));
    const adapter = createStModelAdapter(() => ({ getRequestHeaders: () => ({}),
        configureCustomChatCompletion: async options => { configured = options; },
    }));
    await adapter.actions.configureModel({ source: 'custom', base: 'https://relay.invalid/v1', model: 'relay-model', secretId: 'managed', context: 8192, tokens: 2048 });
    assert.equal(configured.url, 'https://relay.invalid/v1');
    assert.equal(configured.model, 'relay-model');
    assert.equal(configured.apiKey, '', 'key stays in backend secret store');
});
