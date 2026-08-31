import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiActivationLifecycle } from '../../../native-extensions/nora-ui/activation-lifecycle.js';

function deferred() {
    let resolve;
    const promise = new Promise((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

test('concurrent hydration and finalization share one hydration run', async () => {
    const pending = deferred();
    const events = [];
    const lifecycle = createUiActivationLifecycle({
        mount: async () => events.push('mount'),
        hydrate: async () => {
            events.push('hydrate-start');
            await pending.promise;
            events.push('hydrate-end');
        },
        finalize: async () => events.push('finalize'),
    });

    const hydration = lifecycle.hydrate();
    const finalization = lifecycle.finalize();
    pending.resolve();
    await Promise.all([hydration, finalization]);

    assert.deepEqual(events, ['mount', 'hydrate-start', 'hydrate-end', 'finalize']);
    assert.equal(lifecycle.state(), 'ready');
});

test('failed hydration can be retried without running finalization early', async () => {
    let hydrations = 0;
    let finalizations = 0;
    const lifecycle = createUiActivationLifecycle({
        mount: async () => {},
        hydrate: async () => {
            hydrations += 1;
            if (hydrations === 1) throw new Error('not ready');
        },
        finalize: async () => { finalizations += 1; },
    });

    await assert.rejects(lifecycle.finalize(), /not ready/);
    await lifecycle.finalize();

    assert.equal(hydrations, 2);
    assert.equal(finalizations, 1);
    assert.equal(lifecycle.state(), 'ready');
});

test('mount is idempotent and always completes before hydration', async () => {
    const events = [];
    const lifecycle = createUiActivationLifecycle({
        mount: async () => events.push('mount'),
        hydrate: async () => events.push('hydrate'),
        finalize: async () => events.push('finalize'),
    });

    await Promise.all([lifecycle.mount(), lifecycle.mount(), lifecycle.hydrate(), lifecycle.finalize()]);

    assert.deepEqual(events, ['mount', 'hydrate', 'finalize']);
    assert.equal(lifecycle.state(), 'ready');
});

test('lifecycle reports deterministic forward transitions', async () => {
    const transitions = [];
    const lifecycle = createUiActivationLifecycle({
        mount: async () => {},
        hydrate: async () => {},
        finalize: async () => {},
        onTransition: state => transitions.push(state),
    });

    await lifecycle.finalize();

    assert.deepEqual(transitions, [
        'mounting',
        'mounted',
        'hydrating',
        'hydrated',
        'finalizing',
        'ready',
    ]);
});
