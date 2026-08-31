import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorldCapabilityController } from '../public/scripts/nora-worlds/world-capability-controller.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';

test('keeps a complex World open while capability evidence degrades and recovers one item', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-capability-integration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const core = createNoraWorldCore({
        root,
        materializer: {
            async materialize() {
                return {
                    runtimeCard: { engine: 'sillytavern', binding: { avatar: 'complex.png' }, ownership: 'owned' },
                    defaultSession: {
                        engine: 'sillytavern',
                        binding: { avatar: 'complex.png', chat_id: 'complex-chat' },
                        openingState: 'message',
                    },
                    knowledge: [{
                        sourceKey: 'embedded-worldbook:0',
                        engine: 'sillytavern',
                        binding: { name: 'Complex Worldbook' },
                        ownership: 'owned',
                    }],
                    declaredCapabilities: ['regex', 'tavern_helper', 'mvu'],
                };
            },
        },
    });
    const created = await core.createWorld({
        name: 'Complex World',
        persona: { name: '', description: '' },
        source: { type: 'character-card', sha256: 'c'.repeat(64), original_name: 'complex.png', format: 'v3-png' },
    }, { idempotencyKey: 'integration:capability' });

    let mvuReady = false;
    const checks = [];
    const controller = createWorldCapabilityController({
        client: {
            beginCapabilityAttempt: (worldId, capability) => core.beginCapabilityAttempt(worldId, capability),
            async settleCapabilityAttempt(worldId, capability, attemptId, result) {
                return { world: await core.settleCapabilityAttempt(worldId, capability, attemptId, result) };
            },
        },
        runtime: {
            async resolveCharacter() {
                return { name: 'Complex', avatar: 'complex.png' };
            },
            async ensureCharacterCapability(_character, capability) {
                checks.push(capability);
                if (capability === 'mvu' && !mvuReady) {
                    const error = new Error('MVU variable runtime did not initialize in time.');
                    error.code = 'NORA_MVU_TIMEOUT';
                    error.retryable = true;
                    throw error;
                }
                return { engine: 'sillytavern', capability, verified: true };
            },
        },
        clock: (() => {
            let value = 0;
            return () => value += 10;
        })(),
        logger: { warn() {} },
    });

    const plan = await core.prepareOpen(created.world.world_id);
    assert.equal(plan.world_id, created.world.world_id);
    assert.equal((await core.getWorld(created.world.world_id)).lifecycle.status, 'READY');
    assert.deepEqual(checks, [], 'base open plan must not execute enhanced capabilities');

    const first = await controller.ensure({
        id: created.world.world_id,
        characterId: 0,
        manifest: created.world,
    });
    assert.deepEqual(checks, ['tavern_helper', 'regex', 'mvu']);
    assert.equal(first.world.lifecycle.status, 'READY');
    assert.equal(first.world.capabilities.status, 'DEGRADED');
    assert.equal(first.world.capabilities.items.regex.status, 'READY');
    assert.equal(first.world.capabilities.items.tavern_helper.status, 'READY');
    assert.equal(first.world.capabilities.items.mvu.error.code, 'NORA_MVU_TIMEOUT');
    assert.equal(first.world.knowledge[0].binding.name, 'Complex Worldbook');

    mvuReady = true;
    const retried = await controller.retry({
        id: first.world.world_id,
        characterId: 0,
        manifest: first.world,
    }, 'mvu');
    assert.deepEqual(checks, ['tavern_helper', 'regex', 'mvu', 'mvu']);
    assert.equal(retried.world.lifecycle.status, 'READY');
    assert.equal(retried.world.capabilities.status, 'READY');
    assert.equal(retried.world.capabilities.items.mvu.attempts, 2);
    assert.deepEqual(retried.world.capabilities.items.mvu.evidence, {
        engine: 'sillytavern', capability: 'mvu', verified: true,
    });
});
