import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { documentFileName } from '../src/nora-world-core/atomic-json.js';
import { WorldStore } from '../src/nora-world-core/store.js';

function fixture(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-world-readonly-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'core');
    const store = new WorldStore({ root });
    function write(world, name = documentFileName(world.world_id)) {
        const directory = path.join(root, 'worlds'); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, name), typeof world === 'string' ? world : JSON.stringify(world));
    }
    return { parent, root, store, write };
}

function world(id = 'world:read-only', overrides = {}) {
    return { schema_version: 2, world_id: id, revision: 1, name: id, persona: { name: '', description: '' },
        lifecycle: { status: 'READY', error: null }, source: { type: 'manual', sha256: '', original_name: '', format: '' },
        runtime_card: { resource_id: `resource:${id}`, engine: 'sillytavern', binding: { avatar: `${id.replace(':', '-')}.png` }, ownership: 'owned' },
        sessions: { default_session_id: `session:${id}`, items: [{ session_id: `session:${id}`, engine: 'sillytavern',
            binding: { chat_id: `chat-${id}` }, opening_state: 'empty' }] },
        knowledge: [], capabilities: { declared: [], status: 'READY', items: {} },
        created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z', ...overrides };
}

function snapshot(root) {
    const result = {};
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name), relative = path.relative(root, target);
            if (entry.isDirectory()) { result[relative] = 'directory'; visit(target); }
            else result[relative] = [fs.statSync(target).mtimeMs, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')];
        }
    }
    visit(root); return result;
}

test('cold read returns no worlds without creating storage, journals, quarantine or writer state', async t => {
    const f = fixture(t), before = snapshot(f.parent);
    const core = createNoraWorldCore({ root: f.root, materializer: { materialize: () => assert.fail('read must not materialize') } });
    assert.deepEqual(await core.inspectWorlds(), []);
    assert.deepEqual(await f.store.inspectList(), []);
    assert.deepEqual(snapshot(f.parent), before);
});

test('read-only snapshots remain fresh and immutable without priming or replacing the writer cache', async t => {
    const f = fixture(t), first = world(); f.write(first);
    const before = snapshot(f.parent);
    const observed = await f.store.inspectList();
    observed[0].name = 'caller mutation';
    assert.equal((await f.store.inspectList())[0].name, first.name);
    assert.deepEqual(snapshot(f.parent), before);
    f.write({ ...first, name: 'external revision', revision: 2 });
    assert.equal((await f.store.list())[0].name, 'external revision', 'cold inspection must not set writer loaded/cache state');
    f.write({ ...first, name: 'newer external revision', revision: 3 });
    assert.equal((await f.store.inspectList())[0].name, 'newer external revision');
    assert.equal((await f.store.list())[0].name, 'external revision', 'inspection must not replace the already-loaded writer cache');
});

test('corrupt manifests fail read-only in place and retain the existing writer quarantine behavior', async t => {
    const f = fixture(t); f.write('{broken', 'broken.json');
    const before = snapshot(f.parent);
    await assert.rejects(f.store.inspectList(), { code: 'NORA_WORLD_STORAGE_CORRUPT' });
    assert.deepEqual(snapshot(f.parent), before);
    assert.deepEqual(await f.store.list(), []);
    assert.equal(fs.existsSync(path.join(f.root, 'worlds/broken.json')), false);
    assert.equal(fs.readdirSync(path.join(f.root, 'quarantine/worlds')).length, 1);
});

for (const kind of ['world identity', 'import operation', 'resource definition']) {
    test(`read-only snapshot rejects duplicate ${kind} without isolating or dropping either source`, async t => {
        const f = fixture(t), first = world('world:first');
        const second = world('world:second');
        if (kind === 'world identity') second.world_id = first.world_id;
        if (kind === 'import operation') {
            first.source = second.source = { ...first.source, import_operation_id: 'operation:shared', import_command_digest: 'a'.repeat(64) };
        }
        if (kind === 'resource definition') second.runtime_card.resource_id = first.runtime_card.resource_id;
        f.write(first, 'first.json'); f.write(second, 'second.json');
        const before = snapshot(f.parent);
        await assert.rejects(f.store.inspectList(), { code: 'NORA_WORLD_STORAGE_CORRUPT' });
        assert.deepEqual(snapshot(f.parent), before);
    });
}

test('read-only directory and file access errors stay explicit and never create replacement storage', async t => {
    const f = fixture(t); f.write(world());
    const denied = new WorldStore({ root: f.root, fileSystem: { readdir: async () => { throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' }); } } });
    const before = snapshot(f.parent);
    await assert.rejects(denied.inspectList(), { code: 'NORA_WORLD_STORAGE_UNREADABLE' });
    assert.deepEqual(snapshot(f.parent), before);
    const obstruction = path.join(f.parent, 'not-a-directory');
    fs.writeFileSync(obstruction, 'preserve this file');
    // Windows reports ENOENT rather than ENOTDIR below a regular file.
    const blocked = new WorldStore({ root: path.join(obstruction, 'core'), fileSystem: {
        ...fs.promises,
        readdir: async () => { throw Object.assign(new Error('fixture missing path'), { code: 'ENOENT' }); },
    } });
    const obstructedBefore = snapshot(f.parent);
    await assert.rejects(blocked.inspectList(), { code: 'NORA_WORLD_STORAGE_UNREADABLE' });
    assert.deepEqual(snapshot(f.parent), obstructedBefore);
});
