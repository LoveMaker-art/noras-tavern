import assert from 'node:assert/strict';
import test from 'node:test';

import { createTavernHelperActionAdapter } from '../public/scripts/nora-adapters/tavern-helper-action-adapter.js';

test('late Helper readiness restores the published facade to the page global', async (t) => {
    const facade = { generate() {}, generateRaw() {} };
    const globalRef = {};
    const bridge = {
        install: () => () => {},
        publish: candidate => candidate,
        ready: async () => facade,
    };
    const adapter = createTavernHelperActionAdapter({
        storyActions: {
            status: () => ({ active: false }),
            execute: async () => ({ status: 'completed' }),
            cancel: async () => ({ status: 'cancelled' }),
        },
        bridge,
        globalRef,
    });
    adapter.start();
    t.after(() => adapter.stop());

    await globalRef.__NORA_TAVERN_HELPER_READY__();

    assert.equal(globalRef.TavernHelper, facade);
});

test('TavernHelper generation keeps its public result while entering the sidecar lifecycle', async (t) => {
    const generated = [];
    const commands = [];
    const native = {
        generate: async options => {
            generated.push(['generate', options]);
            return 'helper-result';
        },
        generateRaw: async options => {
            generated.push(['generateRaw', options]);
            return 'raw-result';
        },
        stopGenerationById: () => true,
        stopAllGeneration: () => true,
        triggerSlash: value => `slash:${value}`,
    };
    const globalRef = { TavernHelper: native };
    const storyActions = {
        status: () => ({ active: false }),
        execute: async command => {
            commands.push(command);
            return { status: 'completed', value: await command.run({ signal: new AbortController().signal }) };
        },
        cancel: async () => ({ status: 'cancelling' }),
    };
    const adapter = createTavernHelperActionAdapter({
        storyActions,
        globalRef,
        createGenerationId: () => 'helper-1',
    });

    adapter.start();
    t.after(() => adapter.stop());
    const facade = globalRef.TavernHelper;
    const result = await facade.generate({ user_input: '分析剧情' });
    const raw = await facade.generateRaw({ user_input: '更新变量' });

    assert.equal(result, 'helper-result');
    assert.equal(raw, 'raw-result');
    assert.equal(await facade.triggerSlash('/echo'), 'slash:/echo');
    assert.deepEqual(generated, [
        ['generate', { user_input: '分析剧情', generation_id: 'helper-1' }],
        ['generateRaw', { user_input: '更新变量', generation_id: 'helper-1' }],
    ]);
    assert.deepEqual(commands.map(command => [command.type, command.key, command.actionId]), [
        ['sidecar.run', 'helper-1', 'helper-1'],
        ['sidecar.run', 'helper-1', 'helper-1'],
    ]);
});

test('TavernHelper stop interfaces synchronously cancel registered sidecar tasks', async (t) => {
    const stopped = [];
    const active = new Set(['helper-7']);
    const native = {
        generate: async () => 'unused',
        generateRaw: async () => 'unused',
        stopGenerationById: id => {
            if (id !== 'helper-7') return false;
            stopped.push(id);
            return true;
        },
        stopAllGeneration: () => true,
    };
    const globalRef = { TavernHelper: native };
    const storyActions = {
        status: scope => ({ active: active.has(scope.replace('sidecar:', '')) }),
        execute: async () => ({ status: 'completed' }),
        cancel: async scope => {
            const id = scope.replace('sidecar:', '');
            active.delete(id);
            native.stopGenerationById(id);
            return { status: 'cancelling' };
        },
    };
    const adapter = createTavernHelperActionAdapter({ storyActions, globalRef });
    adapter.start();
    t.after(() => adapter.stop());

    assert.equal(globalRef.TavernHelper.stopGenerationById('helper-7'), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(stopped, ['helper-7']);
    assert.equal(globalRef.TavernHelper.stopGenerationById('missing'), false);
});
