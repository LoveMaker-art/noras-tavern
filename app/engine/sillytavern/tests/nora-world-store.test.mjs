import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorldStore } from '../src/nora-world-core/store.js';
import { documentFileName } from '../src/nora-world-core/atomic-json.js';

async function storeFor(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-world-store-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new WorldStore({ root });
    await store.load();
    return store;
}

function draft(overrides = {}) {
    const worldId = overrides.world_id || 'world:store-test';
    return {
        schema_version: 2,
        world_id: worldId,
        revision: 0,
        name: 'Store Test',
        persona: { name: '', description: '' },
        lifecycle: { status: 'READY', error: null },
        source: { type: 'manual', sha256: '', original_name: '', format: '' },
        runtime_card: {
            resource_id: 'resource:card-test',
            engine: 'sillytavern',
            binding: { avatar: 'card.png' },
            ownership: 'owned',
        },
        sessions: {
            default_session_id: 'session:store-test',
            items: [{
                session_id: 'session:store-test',
                engine: 'sillytavern',
                binding: { chat_id: 'chat-1' },
                opening_state: 'empty',
            }],
        },
        knowledge: [],
        capabilities: { declared: [], status: 'READY', items: {} },
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
        ...overrides,
    };
}

test('uses optimistic revision checks and returns immutable snapshots', async (t) => {
    const store = await storeFor(t);
    const created = await store.put(draft(), { expectedRevision: 0 });
    assert.equal(created.revision, 1);

    created.name = 'mutated outside';
    assert.equal((await store.get(created.world_id)).name, 'Store Test');

    const updated = await store.put({ ...created, name: 'Updated' }, { expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    assert.equal(updated.name, 'Updated');

    await assert.rejects(
        store.put({ ...updated, name: 'Stale' }, { expectedRevision: 1 }),
        error => error?.code === 'NORA_WORLD_REVISION_CONFLICT',
    );
});

test('rejects conflicting resource definitions across Worlds', async (t) => {
    const store = await storeFor(t);
    await store.put(draft(), { expectedRevision: 0 });

    await assert.rejects(
        store.put(draft({
            world_id: 'world:second',
            runtime_card: {
                ...draft().runtime_card,
                binding: { avatar: 'different.png' },
            },
        }), { expectedRevision: 0 }),
        error => error?.code === 'NORA_RESOURCE_CONFLICT',
    );
});

test('cannot add a new reference to resources after their World starts deletion', async t => {
    const store = await storeFor(t);
    const owner = await store.put(draft({ knowledge: [{ resource_id: 'resource:book', source_key: 'book', engine: 'sillytavern', binding: { name: 'private-book' }, ownership: 'owned' }] }), { expectedRevision: 0 });
    const another = draft({ world_id: 'world:late', runtime_card: { ...owner.runtime_card, resource_id: 'resource:other', binding: { avatar: 'other.png' } },
        sessions: { default_session_id: 'session:late', items: [{ session_id: 'session:late', engine: 'sillytavern', binding: { chat_id: 'late' }, opening_state: 'empty' }] },
        knowledge: [{ ...owner.knowledge[0], resource_id: 'resource:different-id', ownership: 'shared' }] });
    for (const lifecycle of [{ status: 'DELETING', error: null },
        { status: 'FAILED', error: { code: 'EIO', deletion_pending: true } }, { status: 'DELETED', error: null }]) {
        await store.update(owner.world_id, current => ({ ...current, lifecycle }));
        await assert.rejects(store.put(another, { expectedRevision: 0 }), error => error.code === 'NORA_WORLD_RESOURCE_DELETING');
    }
    assert.equal(await store.get(another.world_id), null);
    const reopened = new WorldStore({ root: store.root });
    await assert.rejects(reopened.put(another, { expectedRevision: 0 }), error => error.code === 'NORA_WORLD_RESOURCE_DELETING');
});

test('rejects a READY Capability Set that still contains pending capabilities', async (t) => {
    const store = await storeFor(t);

    await assert.rejects(
        store.put(draft({
            capabilities: {
                declared: ['mvu'],
                status: 'READY',
                items: { mvu: { status: 'PENDING', error: null } },
            },
        }), { expectedRevision: 0 }),
        error => error?.code === 'NORA_WORLD_INVALID',
    );
});

test('concurrent Worlds retain every shared resource reference before and after reload', async (t) => {
    const store = await storeFor(t);
    const manifests = Array.from({ length: 8 }, (_, index) => draft({
        world_id: `world:concurrent-${index}`,
        runtime_card: { ...draft().runtime_card, resource_id: `resource:card-${index}`, binding: { avatar: `${index}.png` } },
        sessions: { default_session_id: `session:${index}`, items: [{ session_id: `session:${index}`, engine: 'sillytavern', binding: { chat_id: `${index}` }, opening_state: 'empty' }] },
        knowledge: [{ resource_id: 'resource:shared', source_key: 'shared', engine: 'sillytavern', binding: { name: 'shared' }, ownership: index === 0 ? 'owned' : 'shared' }],
    }));
    await Promise.all(manifests.map(world => store.put(world, { expectedRevision: 0 })));
    const expected = manifests.map(world => world.world_id).sort();
    assert.deepEqual((await store.inspect(expected[0])).resource_references.knowledge[0].world_ids.sort(), expected);
    assert.equal((await store.deletionPlan(expected[0])).knowledge[0].delete, false);
    const reopened = new WorldStore({ root: store.root });
    assert.deepEqual((await reopened.inspect(expected[0])).resource_references.knowledge[0].world_ids.sort(), expected);
});

test('concurrent commits cannot claim the same import operation for different Worlds', async (t) => {
    const store = await storeFor(t);
    const source = { ...draft().source, import_operation_id: 'operation:shared', import_command_digest: 'a'.repeat(64) };
    const results = await Promise.allSettled(['one', 'two'].map(id => store.put(draft({ world_id: `world:${id}`, source }), { expectedRevision: 0 })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'NORA_OPERATION_CONFLICT');
    assert.equal((await store.list()).length, 1);
});

test('update cannot change the identity of a stored World', async (t) => {
    const store = await storeFor(t);
    const world = await store.put(draft(), { expectedRevision: 0 });
    await assert.rejects(store.update(world.world_id, current => ({ ...current, world_id: 'world:other' })), /identity/i);
    assert.equal((await store.get(world.world_id)).world_id, world.world_id);
});

for (const interruption of ['before-rename', 'after-rename']) {
    test(`deleted-World compaction survives ${interruption} and retains import replay identity`, async t => {
        const store = await storeFor(t);
        const source = { ...draft().source, import_operation_id: 'operation:deleted-fixture', import_command_digest: 'b'.repeat(64) };
        const created = await store.put(draft({ source }), { expectedRevision: 0 });
        const deleting = await store.update(created.world_id, current => ({ ...current, lifecycle: { status: 'DELETING', error: null } }));
        const file = path.join(store.root, 'worlds', documentFileName(created.world_id));
        const original = await fs.readFile(file, 'utf8');
        let intercepted = 0;
        const failing = new WorldStore({ root: store.root, fileSystem: {
            ...fs,
            async rename(from, to) {
                if (to !== file) return fs.rename(from, to);
                intercepted += 1;
                if (interruption === 'after-rename') await fs.rename(from, to);
                throw Object.assign(new Error('injected tombstone commit interruption'), { code: 'EIO' });
            },
        } });
        await assert.rejects(failing.update(created.world_id, current => ({ ...current, lifecycle: { status: 'DELETED', error: null } })), /injected tombstone/);
        assert.equal(intercepted, 1);
        if (interruption === 'before-rename') assert.equal(await fs.readFile(file, 'utf8'), original);
        const reopened = new WorldStore({ root: store.root });
        const recovered = await reopened.get(created.world_id);
        assert.equal(recovered.lifecycle.status, interruption === 'before-rename' ? 'DELETING' : 'DELETED');
        if (recovered.lifecycle.status === 'DELETING') {
            await reopened.update(created.world_id, current => ({ ...current, lifecycle: { status: 'DELETED', error: null } }), { expectedRevision: deleting.revision });
        }
        const committed = await fs.readFile(file, 'utf8');
        assert.equal(JSON.parse(committed).schema, 'nora-world-tombstone/1');
        const again = new WorldStore({ root: store.root });
        assert.equal((await again.get(created.world_id)).revision, deleting.revision + 1);
        assert.equal((await again.findByOperation(source.import_operation_id)).world_id, created.world_id);
        assert.deepEqual(await again.list(), []);
        assert.equal(await fs.readFile(file, 'utf8'), committed);
        assert.deepEqual(await fs.readdir(path.join(store.root, 'quarantine', 'worlds')), []);
    });
}
