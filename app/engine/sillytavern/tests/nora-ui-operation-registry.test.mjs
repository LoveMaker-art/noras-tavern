import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiOperationRegistry } from '../../../native-extensions/nora-ui/ui-operation-registry.js';

function deferred() {
    let resolve;
    const promise = new Promise(accept => { resolve = accept; });
    return { promise, resolve };
}

test('UI operations join duplicate work in one scope and release it after completion', async () => {
    const pending = deferred();
    const operations = createUiOperationRegistry();
    let calls = 0;

    const first = operations.run('world', async () => {
        calls += 1;
        return pending.promise;
    });
    const duplicate = operations.run('world', async () => {
        calls += 1;
        return 'duplicate';
    });

    assert.equal(first, duplicate);
    assert.equal(operations.isBusy('world'), true);
    pending.resolve('complete');
    assert.equal(await first, 'complete');
    assert.equal(calls, 1);
    assert.equal(operations.isBusy('world'), false);
});

test('failed UI operations release their scope for retry', async () => {
    const operations = createUiOperationRegistry();
    await assert.rejects(operations.run('model', async () => { throw new Error('offline'); }), /offline/);
    assert.equal(await operations.run('model', async () => 'retried'), 'retried');
});
