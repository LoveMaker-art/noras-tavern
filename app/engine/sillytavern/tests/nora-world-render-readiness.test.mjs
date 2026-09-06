import assert from 'node:assert/strict';
import test from 'node:test';

import {
    prepareWorldRender,
    registerWorldRenderReadiness,
} from '../public/scripts/nora-worlds/world-render-readiness.js';

test('has one awaited owner and propagates readiness failures', async () => {
    const context = {
        worldId: 'world:one',
        sessionId: 'session:one',
        chatId: 'chat-one.jsonl',
        characterId: 0,
    };
    await assert.rejects(
        prepareWorldRender(context),
        error => error?.code === 'NORA_WORLD_RENDER_READINESS_UNAVAILABLE',
    );

    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const calls = [];
    const dispose = registerWorldRenderReadiness(async preparedContext => {
        calls.push(preparedContext);
        await pending;
        return 'ready';
    });

    assert.throws(
        () => registerWorldRenderReadiness(() => {}),
        error => error?.code === 'NORA_WORLD_RENDER_READINESS_UNAVAILABLE',
    );
    let settled = false;
    const preparation = prepareWorldRender(context).then(result => {
        settled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    assert.equal(await preparation, 'ready');
    assert.deepEqual(calls, [{
        worldId: 'world:one',
        sessionId: 'session:one',
        chatId: 'chat-one',
        characterId: 0,
    }]);
    dispose();

    const disposeFailure = registerWorldRenderReadiness(async () => {
        throw Object.assign(new Error('not ready'), { code: 'NORA_REGEX_NOT_AUTHORIZED' });
    });
    await assert.rejects(
        prepareWorldRender(context),
        error => error?.code === 'NORA_REGEX_NOT_AUTHORIZED',
    );
    disposeFailure();
});
