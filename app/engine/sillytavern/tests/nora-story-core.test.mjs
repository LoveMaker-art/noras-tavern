import assert from 'node:assert/strict';
import test from 'node:test';

import { createNoraStoryCore, createStorySurface } from '../public/scripts/nora-story-core/index.js';

const domainMethods = [
    'patchCharacter',
    'snapshot', 'subscribe', 'whenReady',
    'sendText', 'stop', 'regenerate', 'editAndRegenerate', 'suggestReplies', 'isGenerating', 'swipe', 'editMessage', 'restoreMessage', 'runSlash', 'prepareMutation',
    'isSystemCharacter', 'resolveCharacter', 'characterCapabilities', 'ensureCharacterCapability', 'markCharacterCapabilitiesPrompted', 'enableCharacterCapabilities', 'rerenderCharacterChat', 'refreshCharacters', 'updateCharacter', 'deleteCharacterCards', 'savePersona',
    'loadWorldbook', 'saveWorldbook', 'saveWorldScenario', 'updateEmbeddedWorldbook',
    'assertModelConfigured', 'configureModel', 'clearModelConfiguration', 'deleteModelSecret', 'uiSettings', 'saveUiSettings', 'setHostPersonality', 'requestHeaders',
    'status', 'setEnabled', 'useStoryModel', 'useIndependentModel',
];

function runtimeFixture() {
    return Object.fromEntries(domainMethods.map(name => [name, () => name]));
}

test('story surface exposes only explicit headless domains', () => {
    const runtime = runtimeFixture();
    const worlds = { activate() {} };
    const story = createStorySurface(runtime, worlds);

    assert.equal(story.state.snapshot(), 'snapshot');
    assert.equal(story.messages.sendText(), 'sendText');
    assert.equal(story.cards.resolveCharacter(), 'resolveCharacter');
    assert.equal(story.cards.rerenderCharacterChat(), 'rerenderCharacterChat');
    assert.equal(story.worldbook.loadWorldbook(), 'loadWorldbook');
    assert.equal(story.model.assertModelConfigured(), 'assertModelConfigured');
    assert.equal(story.model.configureModel(), 'configureModel');
    assert.equal(story.mvu.setEnabled(), 'setEnabled');
    assert.equal(story.settings.uiSettings(), 'uiSettings');
    assert.equal(story.transport.requestHeaders(), 'requestHeaders');
    assert.equal(story.worlds, worlds);
    assert.equal('runtime' in story, false);
    assert.equal('whenReady' in story, false);
    assert.equal(Object.isFrozen(story), true);
    assert.equal(Object.isFrozen(story.messages), true);
    for (const obsolete of ['prepareCharacterRuntime', 'waitForCharacterRuntime', 'createCharacter', 'importCharacter']) {
        assert.equal(obsolete in story.cards, false);
    }
});

test('story core can be composed without a Nora UI or browser document', async () => {
    const calls = [];
    const kernel = { getContext: () => ({ id: 'context' }), whenAppReady: Promise.resolve() };
    const runtime = runtimeFixture();
    const worldAdapter = { id: 'world-adapter' };
    const client = { id: 'world-client' };
    const worlds = { activate() {} };

    const story = await createNoraStoryCore({
        loadKernel: async () => kernel,
        createRuntime: (getContext, options) => {
            calls.push(['runtime', getContext(), options.whenAppReady()]);
            return runtime;
        },
        createWorldAdapter: getContext => {
            calls.push(['world-adapter', getContext()]);
            return worldAdapter;
        },
        createV2Client: requestHeaders => {
            calls.push(['client', requestHeaders()]);
            return client;
        },
        createV2Worlds: (adapter, options) => {
            calls.push(['worlds', adapter, options]);
            return worlds;
        },
    });

    assert.equal(story.state.snapshot(), 'snapshot');
    assert.equal(story.worlds, worlds);
    assert.deepEqual(calls.map(([name]) => name), ['runtime', 'world-adapter', 'client', 'worlds']);
    assert.equal(calls[1][1].id, 'context');
    assert.equal(calls[3][1], worldAdapter);
    assert.equal(calls[3][2].client, client);
});

test('story surface rejects an incomplete runtime at the boundary', () => {
    assert.throws(
        () => createStorySurface({ snapshot() {} }, { activate() {} }),
        /state.*subscribe/,
    );
});

test('story core always composes the authoritative World v2 runtime', async () => {
    const calls = [];
    const runtime = runtimeFixture();
    const v2Client = { id: 'v2-client' };
    const v2Worlds = { activate() {}, mode: 'v2' };
    const story = await createNoraStoryCore({
        loadKernel: async () => ({ getContext: () => ({ id: 'context' }), whenAppReady: Promise.resolve() }),
        createRuntime: () => runtime,
        createWorldAdapter: () => ({ id: 'world-adapter' }),
        createV2Client: (requestHeaders) => {
            calls.push(['client', requestHeaders]);
            return v2Client;
        },
        createV2Worlds: (adapter, options) => {
            calls.push(['worlds', adapter, options]);
            return v2Worlds;
        },
    });

    assert.equal(story.worlds, v2Worlds);
    assert.deepEqual(calls.map(([name]) => name), ['client', 'worlds']);
    assert.equal(calls[1][2].client, v2Client);
    assert.equal(calls[1][2].capabilityRuntime, runtime);
    assert.equal(calls[1][2].refreshCharacters, runtime.refreshCharacters);
});
