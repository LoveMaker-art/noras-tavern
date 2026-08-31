import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorldCapabilityController } from '../public/scripts/nora-worlds/world-capability-controller.js';

function manifest(statuses = { tavern_helper: 'PENDING', regex: 'PENDING', mvu: 'PENDING' }) {
    const declared = Object.keys(statuses);
    return {
        world_id: 'world:one',
        capabilities: {
            declared,
            status: declared.some(capability => statuses[capability] === 'DEGRADED') ? 'DEGRADED' : 'PENDING',
            items: Object.fromEntries(declared.map(capability => [capability, { status: statuses[capability] }])),
        },
    };
}

function fixture({ mvuFails = true } = {}) {
    const calls = [];
    let attempt = 0;
    const client = {
        async beginCapabilityAttempt(worldId, capability) {
            calls.push(`begin:${capability}`);
            attempt += 1;
            return { world: manifest(), attempt: { attempt_id: `capability-attempt:${attempt}`, capability, world_id: worldId } };
        },
        async settleCapabilityAttempt(_worldId, capability, _attemptId, result) {
            calls.push(`settle:${capability}:${result.status}:${result.error?.code || 'none'}`);
            return { world: manifest({ [capability]: result.status }) };
        },
    };
    const runtime = {
        async resolveCharacter() {
            calls.push('resolve');
            return { avatar: 'target.png', name: 'Target' };
        },
        async ensureCharacterCapability(_character, capability) {
            calls.push(`ensure:${capability}`);
            if (capability === 'mvu' && mvuFails) {
                const error = new Error('internal ST polling exception must not be persisted');
                error.code = 'NORA_MVU_TIMEOUT';
                error.retryable = true;
                throw error;
            }
            return { engine: 'sillytavern', capability, ready: true };
        },
    };
    let now = 0;
    const controller = createWorldCapabilityController({ client, runtime, clock: () => now += 5, logger: { warn() {} } });
    return { calls, controller };
}

test('is the single owner that authorizes once and settles each capability in dependency order', async () => {
    const { calls, controller } = fixture();
    const world = { id: 'world:one', characterId: 0, manifest: manifest() };
    const result = await controller.ensure(world, {
        async authorize(_character, options) {
            calls.push(`authorize:${options.force}`);
        },
    });

    assert.deepEqual(result.results.map(item => [item.capability, item.result.status]), [
        ['tavern_helper', 'READY'],
        ['regex', 'READY'],
        ['mvu', 'DEGRADED'],
    ]);
    assert.equal(result.results[2].result.error.message, 'MVU readiness timed out.');
    assert.doesNotMatch(result.results[2].result.error.message, /internal ST/);
    assert.deepEqual(calls, [
        'resolve',
        'authorize:false',
        'begin:tavern_helper',
        'ensure:tavern_helper',
        'settle:tavern_helper:READY:none',
        'begin:regex',
        'ensure:regex',
        'settle:regex:READY:none',
        'begin:mvu',
        'ensure:mvu',
        'settle:mvu:DEGRADED:NORA_MVU_TIMEOUT',
    ]);
});

test('retries one degraded capability without reopening the World or rerunning other capabilities', async () => {
    const { calls, controller } = fixture({ mvuFails: false });
    const world = {
        id: 'world:one',
        characterId: 0,
        manifest: manifest({ tavern_helper: 'READY', regex: 'READY', mvu: 'DEGRADED' }),
    };
    const result = await controller.retry(world, 'mvu', {
        async authorize(_character, options) {
            calls.push(`authorize:${options.force}`);
        },
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].capability, 'mvu');
    assert.equal(result.results[0].result.status, 'READY');
    assert.deepEqual(calls, [
        'resolve',
        'authorize:true',
        'begin:mvu',
        'ensure:mvu',
        'settle:mvu:READY:none',
    ]);
    assert.equal(calls.some(call => call.includes('activate')), false);
});

test('revalidates persisted READY capabilities once per browser runtime', async () => {
    const { calls, controller } = fixture({ mvuFails: false });
    const world = {
        id: 'world:one',
        characterId: 0,
        manifest: manifest({ tavern_helper: 'READY', regex: 'READY', mvu: 'READY' }),
    };

    const first = await controller.ensure(world);
    const second = await controller.ensure(world);

    assert.deepEqual(first.results.map(item => item.capability), ['tavern_helper', 'regex', 'mvu']);
    assert.equal(second.results.length, 0, 'one page runtime must not reactivate an already verified World');
    assert.deepEqual(calls, [
        'resolve',
        'begin:tavern_helper',
        'ensure:tavern_helper',
        'settle:tavern_helper:READY:none',
        'begin:regex',
        'ensure:regex',
        'settle:regex:READY:none',
        'begin:mvu',
        'ensure:mvu',
        'settle:mvu:READY:none',
    ]);
});
