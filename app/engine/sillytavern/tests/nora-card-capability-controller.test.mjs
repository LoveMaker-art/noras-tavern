import assert from 'node:assert/strict';
import test from 'node:test';

import { createCardCapabilityController } from '../../../native-extensions/nora-ui/card-capability-controller.js';
import { createStorySurface } from '../public/scripts/nora-story-core/index.js';
import { createStRuntimeAdapter } from '../public/scripts/nora-adapters/st-runtime-adapter.js';

function readyResult(results = [{ capability: 'regex', result: { status: 'READY' } }]) {
    return {
        world: {
            world_id: 'world:one',
            runtime_card: { binding: { avatar: 'target.png' } },
        },
        results,
    };
}

function composedController() {
    let reloads = 0;
    let result = readyResult();
    const context = {
        ...Object.fromEntries(['sendText', 'stopGeneration', 'regenerate', 'commitMessageEdit', 'deleteLastMessage',
            'saveChat', 'generateRaw', 'configureCustomChatCompletion', 'clearCustomChatCompletion',
            'hasCustomChatCompletionApiKey', 'getRequestHeaders', 'activateExtensionNames', 'getActiveExtensionNames']
            .map(name => [name, () => {}])),
        characterId: 0,
        characters: [{ avatar: 'target.png' }],
        reloadCurrentChat: async () => { reloads += 1; },
    };
    const worlds = {
        activate() {},
        ensureCapabilities: async () => result,
        retryCapability: async () => result,
    };
    const runtime = createStRuntimeAdapter(() => context);
    const story = createStorySurface(runtime, worlds);
    return {
        context, runtime, get reloads() { return reloads; }, setResult(value) { result = value; },
        controller: createCardCapabilityController({
            cards: story.cards, worldRuntime: story.worlds, confirmAction: async () => true, showToast() {},
        }),
    };
}

test('composed Story cards Interface preserves rerender after capability load and retry', async () => {
    const app = composedController();
    await app.controller.load('world:one');
    assert.equal(app.reloads, 1, 'READY must reach the native reload through the actual Story Interface');
    await app.controller.retry('world:one', 'regex');
    assert.equal(app.reloads, 2);
});

test('composed capability rerender ignores no-op, failed and no-longer-active results', async () => {
    const app = composedController();
    app.setResult(readyResult([]));
    await app.controller.load('world:one');
    app.setResult(readyResult([{ capability: 'regex', result: { status: 'DEGRADED' } }]));
    await app.controller.load('world:one');
    app.setResult(readyResult());
    app.context.characters = [{ avatar: 'another-world.png' }];
    await app.controller.load('world:one');
    assert.equal(app.reloads, 0);
});

test('native rerender works without the Story projection as a control', async () => {
    const app = composedController();
    assert.equal(await app.runtime.rerenderCharacterChat('target.png'), true);
    assert.equal(app.reloads, 1);
});

test('capabilities finishing during generation do not reload the live chat', async () => {
    const app = composedController();
    app.context.isGenerating = () => true;
    await app.controller.load('world:one');
    assert.equal(app.reloads, 0, 'late capability completion must not clear a streaming chat');
});

test('rerenders the active Runtime Card once after capabilities become ready', async () => {
    const rerenders = [];
    const cards = {
        characterCapabilities: () => ({}),
        resolveCharacter: async () => null,
        rerenderCharacterChat: async avatar => rerenders.push(avatar),
    };
    const worldRuntime = {
        mode: 'v2',
        ensureCapabilities: async () => readyResult(),
    };
    const controller = createCardCapabilityController({
        cards,
        worldRuntime,
        confirmAction: async () => true,
        showToast() {},
    });

    await controller.load('world:one');

    assert.deepEqual(rerenders, ['target.png']);
});

test('does not rerender when the current page runtime already verified every capability', async () => {
    let rerenders = 0;
    const cards = {
        characterCapabilities: () => ({}),
        resolveCharacter: async () => null,
        rerenderCharacterChat: async () => { rerenders += 1; },
    };
    const worldRuntime = {
        mode: 'v2',
        ensureCapabilities: async () => readyResult([]),
    };
    const controller = createCardCapabilityController({
        cards,
        worldRuntime,
        confirmAction: async () => true,
        showToast() {},
    });

    await controller.load('world:one');

    assert.equal(rerenders, 0);
});
