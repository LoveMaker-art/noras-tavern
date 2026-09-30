import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserLogWriter, userLogPaths } from '../src/nora-log-writer.js';
import { createMvuDiagnosticStore } from '../src/nora-mvu-diagnostics.js';
import { createNoraTelemetryWriter } from '../src/nora-performance-telemetry.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-log-writer-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root };
}

async function events(file) {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

const writers = [
    ['mvu-diagnostics', createMvuDiagnosticStore],
    ['performance', createNoraTelemetryWriter],
];

for (const [name, create] of writers) {
    test(`${name}: concurrent writes remain ordered, complete and user-isolated`, async (t) => {
        const root = await fixture(t);
        const first = { root: path.join(root.root, 'first') };
        const second = { root: path.join(root.root, 'second') };
        const writer = create();
        const input = Array.from({ length: 60 }, (_, id) => ({ id, message: 'line\ninside' }));
        const pending = [];
        for (const event of input) {
            pending.push(writer.append(first, event), writer.append(second, { ...event, other: true }));
        }
        await Promise.all(pending);
        assert.deepEqual(await events(userLogPaths(first, name).active), input);
        assert.deepEqual(await events(userLogPaths(second, name).active), input.map(event => ({ ...event, other: true })));
        await writer.append(first, { id: 60 });
        assert.equal((await events(userLogPaths(first, name).active)).at(-1).id, 60);
    });

    test(`${name}: exact byte boundary and repeated rotations preserve only the newest two files`, async (t) => {
        const directories = await fixture(t);
        const first = { text: '\u4e16\u754c', id: 1 };
        const bytes = Buffer.byteLength(`${JSON.stringify(first)}\n`);
        const writer = create({ maxFileBytes: bytes * 2 });
        const paths = userLogPaths(directories, name);
        await writer.append(directories, first);
        await writer.append(directories, { ...first, id: 2 });
        assert.equal((await fs.stat(paths.active)).size, bytes * 2);
        await assert.rejects(fs.stat(paths.rotated), { code: 'ENOENT' });
        for (let id = 3; id <= 5; id++) await writer.append(directories, { ...first, id });
        assert.deepEqual((await events(paths.active)).map(event => event.id), [5]);
        assert.deepEqual((await events(paths.rotated)).map(event => event.id), [3, 4]);
        assert.deepEqual((await fs.readdir(paths.directory)).sort(), [`${name}.1.ndjson`, `${name}.ndjson`]);
    });

    test(`${name}: a single oversized event remains intact, as before`, async (t) => {
        const directories = await fixture(t);
        const writer = create({ maxFileBytes: 20 });
        const event = { text: 'x'.repeat(100) };
        await writer.append(directories, event);
        await writer.append(directories, { id: 2 });
        const paths = userLogPaths(directories, name);
        assert.deepEqual(await events(paths.rotated), [event]);
        assert.deepEqual(await events(paths.active), [{ id: 2 }]);
    });

    test(`${name}: filesystem and serialization failures reject without poisoning subsequent writes`, async (t) => {
        const directories = await fixture(t);
        const paths = userLogPaths(directories, name);
        const writer = create();
        await fs.writeFile(paths.directory, 'blocked');
        await assert.rejects(writer.append(directories, { id: 0 }));
        await fs.unlink(paths.directory);
        const circular = {};
        circular.self = circular;
        const failed = assert.rejects(writer.append(directories, circular), TypeError);
        const recovered = writer.append(directories, { id: 1 });
        await Promise.all([failed, recovered]);
        assert.deepEqual(await events(paths.active), [{ id: 1 }]);
        await assert.rejects(writer.append({}, { id: 2 }), /user data root/);
    });

    test(`${name}: failed rotation preserves the active log and allows recovery`, async (t) => {
        const directories = await fixture(t);
        const paths = userLogPaths(directories, name);
        const writer = create({ maxFileBytes: 1 });
        await writer.append(directories, { id: 1 });
        await fs.mkdir(paths.rotated);
        await assert.rejects(writer.append(directories, { id: 2 }));
        assert.deepEqual(await events(paths.active), [{ id: 1 }]);
        await fs.rmdir(paths.rotated);
        await writer.append(directories, { id: 3 });
        assert.deepEqual(await events(paths.active), [{ id: 3 }]);
        assert.deepEqual(await events(paths.rotated), [{ id: 1 }]);
    });
}

test('slow performance writes do not block another user or MVU diagnostics', { timeout: 5000 }, async (t) => {
    const directories = await fixture(t);
    const otherUser = { root: path.join(directories.root, 'other') };
    const paths = userLogPaths(directories, 'performance');
    const original = fs.appendFile;
    let unblock;
    let entered;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    t.mock.method(fs, 'appendFile', async (file, ...args) => {
        if (file === paths.active) { entered(); await blocked; }
        return original(file, ...args);
    });
    const performance = createNoraTelemetryWriter();
    const pending = performance.append(directories, { slow: true });
    try {
        await started;
        await createMvuDiagnosticStore().append(directories, { mvu: true });
        await performance.append(otherUser, { other: true });
        assert.deepEqual(await events(userLogPaths(directories, 'mvu-diagnostics').active), [{ mvu: true }]);
        assert.deepEqual(await events(userLogPaths(otherUser, 'performance').active), [{ other: true }]);
    } finally {
        unblock();
        await pending;
    }
});

for (const order of [writers, [...writers].reverse()]) {
    test(`${order[0][0]} first: tighten existing permissions without touching unrelated user files`, {
        skip: process.platform === 'win32' ? 'POSIX mode bits are not Windows ACLs' : false,
    }, async (t) => {
        const directories = await fixture(t);
        const logDirectory = userLogPaths(directories, 'performance').directory;
        await fs.mkdir(logDirectory);
        await fs.chmod(logDirectory, 0o755);
        const unrelated = path.join(directories.root, 'settings.json');
        await fs.writeFile(unrelated, '{}');
        await fs.chmod(unrelated, 0o644);
        for (const [name, create] of order) {
            const paths = userLogPaths(directories, name);
            await fs.writeFile(paths.active, '{"old":true}\n');
            await fs.chmod(paths.active, 0o644);
            await create({ maxFileBytes: 1 }).append(directories, { new: true });
            assert.equal((await fs.stat(logDirectory)).mode & 0o777, 0o700);
            assert.equal((await fs.stat(paths.active)).mode & 0o777, 0o600);
            assert.equal((await fs.stat(paths.rotated)).mode & 0o777, 0o600);
            assert.deepEqual(await events(paths.rotated), [{ old: true }]);
        }
        assert.equal((await fs.stat(unrelated)).mode & 0o777, 0o644);
        assert.equal(await fs.readFile(unrelated, 'utf8'), '{}');
    });
}

test('MVU recent preserves its existing files, newest-first order and invalid-line handling', async (t) => {
    const directories = await fixture(t);
    const paths = userLogPaths(directories, 'mvu-diagnostics');
    await fs.mkdir(paths.directory);
    await fs.writeFile(paths.rotated, '{"id":1}\n');
    await fs.writeFile(paths.active, 'invalid\n{"id":2}\n');
    const store = createMvuDiagnosticStore();
    await store.append(directories, { id: 3 });
    assert.deepEqual(await store.recent(directories, 4), [{ id: 3 }, { id: 2 }, { id: 1 }]);
    assert.deepEqual(await store.recent(directories, 1), [{ id: 3 }]);
});

test('internal log names cannot escape the telemetry directory', async (t) => {
    const directories = await fixture(t);
    await assert.rejects(createUserLogWriter({ name: '../settings' }).append(directories, {}), /Invalid Nora log name/);
    assert.deepEqual(await fs.readdir(directories.root), []);
});
