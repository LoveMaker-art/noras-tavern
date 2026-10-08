import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { NoraControlPlane } from '../dist/nora-control-plane.js';
import { NoraRequestError } from '../dist/errors.js';

test('backup listing filters exact sessions, bounds results and exposes no stored path', async () => {
    const snapshots = ['one', 'two', 'three'].map((id, i) => ({ id, worldId: i === 2 ? 'other' : 'world',
        sessionId: i ? 'second' : 'first', sha256: 'a'.repeat(64), sourcePath: '/private/chat.jsonl' }));
    const calls = [];
    const plane = new NoraControlPlane({}, { post: async (route, body) => { calls.push([route, body]); return { snapshots, totalBytes: 100, policy: {}, legacyFiles: 0,
        capacity: { protectedCount: 60, protectedBytes: 100, protectedCountExceeded: true, protectedLimitReached: true, sourcePath: '/private' } }; } });
    const result = await plane.listBackups({ worldId: 'world', sessionId: 'first', offset: 0, limit: 1 });
    assert.deepEqual(result.snapshots.map(item => item.id), ['one']);
    assert.equal(result.totalMatched, 1);
    assert.equal(result.hasMore, false);
    assert.equal(result.snapshots[0].sourcePath, undefined);
    assert.deepEqual(result.capacity, { protectedCount: 60, protectedBytes: 100, protectedCountExceeded: true, protectedLimitReached: true });
    assert.deepEqual(calls, [['/api/backups/chat/managed', undefined]]);
    await assert.rejects(plane.listBackups({ sessionId: 'first', offset: 0, limit: 1 }), { code: 'NORA_BACKUP_INVALID_SCOPE' });
    plane.http.post = async () => ({});
    await assert.rejects(plane.listBackups({ offset: 0, limit: 1 }), { code: 'NORA_INVALID_RESPONSE' });
});

test('optional legacy inventory excludes managed files and reports truncation, not a fabricated empty result', async () => {
    const plane = new NoraControlPlane({}, { post: async route => route.endsWith('/managed') ? { snapshots: [{ id: 'known', worldId: 'other' }] }
        : { complete: true, backups: [{ name: 'chat_nora1_known.jsonl' }, { name: 'chat_nora1_orphan.jsonl' }, ...Array.from({ length: 51 }, (_, i) => ({ name: `chat_legacy_${i}.jsonl`, sourcePath: '/private' }))] } });
    const result = await plane.listBackups({ offset: 0, limit: 20, includeLegacy: true });
    assert.equal(result.legacy.totalObserved, 52);
    assert.equal(result.legacy.truncated, true);
    assert.equal(result.legacy.files.length, 50);
    assert.equal(result.legacy.files[0].name, 'chat_nora1_orphan.jsonl', 'an unmanaged file is not hidden merely because it has a managed-looking name');
    assert.ok(result.legacy.files.every(item => item.name !== 'chat_nora1_known.jsonl' && item.sourcePath === undefined));
    const scoped = await plane.listBackups({ worldId: 'world', offset: 0, limit: 1, includeLegacy: true });
    assert.deepEqual(scoped.snapshots, []);
    assert.equal(scoped.legacy.totalObserved, 52, 'managed exclusion uses the full inventory, not only the filtered page');
    plane.http.post = async () => ({ snapshots: [] });
    await assert.rejects(plane.listBackups({ offset: 0, limit: 20, includeLegacy: true }), { code: 'NORA_INVALID_RESPONSE' });
});

test('download checks digest before writing and uses the shared private export guard', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nora-backup-export-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from('{"chat_metadata":{}}\n{"mes":"Complete text"}');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const plane = new NoraControlPlane({ stateRoot: root }, { download: async (route, body, kind) => {
        assert.equal(route, '/api/backups/chat/snapshot'); assert.equal(kind, 'chat-backup'); assert.equal(body.id, 'chosen'); return bytes;
    } });
    await assert.rejects(plane.downloadBackup({ id: 'chosen', sha256: '0'.repeat(64) }), { code: 'NORA_BACKUP_CHANGED' });
    assert.deepEqual(await fs.readdir(root), []);
    const result = await plane.downloadBackup({ id: 'chosen', sha256 });
    assert.equal(result.sha256, sha256);
    assert.equal(result.format, 'jsonl');
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readFile(result.path), bytes);
    await fs.rename(path.join(root, 'exports'), path.join(root, 'actual'));
    await fs.symlink(path.join(root, 'actual'), path.join(root, 'exports'));
    await assert.rejects(plane.downloadBackup({ id: 'chosen', sha256 }), { code: 'NORA_EXPORT_PATH_DENIED' });
});

test('restore forwards the approved proof once and retains it on uncertain or wrong-target responses', async () => {
    const request = { id: 'chosen', worldId: 'world', sessionId: 'session', sha256: 'a'.repeat(64), expectedRevision: 'b'.repeat(64) };
    const calls = [];
    const plane = new NoraControlPlane({}, { post: async (route, body) => { calls.push([route, body]); return { status: 'restored', worldId: 'world', sessionId: 'session' }; } });
    const result = await plane.restoreBackup(request);
    assert.equal(result.reloadRequired, true);
    assert.equal(result.frontendApplied, false);
    assert.deepEqual(calls, [['/api/backups/chat/restore', request]]);
    plane.http.post = async () => ({ status: 'restored', worldId: 'world', sessionId: 'session', protectedBackupId: null,
        backupWarning: { status: 'failed', code: 'NORA_BACKUP_BUDGET_EXCEEDED' } });
    const warning = await plane.restoreBackup(request);
    assert.equal(warning.protectedBackupId, null);
    assert.equal(warning.backupWarning.code, 'NORA_BACKUP_BUDGET_EXCEEDED');
    assert.equal(warning.reloadRequired, true);
    plane.http.post = async () => { throw new NoraRequestError('Transport failed', 'NORA_TRANSPORT_FAILED', null, 'unknown'); };
    await assert.rejects(plane.restoreBackup(request), error => error.outcome === 'unknown'
        && error.details.nextTool === 'nora.backup.restore' && assert.deepEqual(error.details.retryWithSameProof, request) === undefined);
    plane.http.post = async () => ({ status: 'restored', worldId: 'other', sessionId: 'session' });
    await assert.rejects(plane.restoreBackup(request), { code: 'NORA_BACKUP_RESTORE_UNCONFIRMED', outcome: 'unknown' });
    plane.http.post = async () => { throw new NoraRequestError('Changed', 'NORA_BACKUP_RESTORE_STALE', 409); };
    await assert.rejects(plane.restoreBackup(request), error => error.outcome === 'rejected' && error.details.retryWithSameProof === undefined);
});
