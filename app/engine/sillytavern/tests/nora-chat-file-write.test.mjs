import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { writeChatFile } from '../src/chat-file-write.js';

function fixture(t, { canRemove = () => true } = {}) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-chat-rename-')));
    t.after(() => {
        if (canRemove()) fs.rmSync(directory, { recursive: true, force: true });
        else t.diagnostic(`Preserved fixture with unconfirmed lock-child closure: ${directory}`);
    });
    const file = path.join(directory, 'chat.jsonl');
    fs.writeFileSync(file, 'original');
    return { directory, file };
}

function denied(source, target, code = 'EPERM', syscall = 'rename') {
    return Object.assign(new Error('fixture replacement denied'), { code, syscall, path: source, dest: target });
}

test('Windows replacement retries let pending readers close before the next revision check', async t => {
    const { file } = fixture(t);
    const rename = fs.renameSync;
    let released = false, attempts = 0;
    const timer = setTimeout(() => { released = true; }, 1);
    t.after(() => clearTimeout(timer));
    t.mock.method(fs, 'renameSync', (source, target) => {
        attempts++;
        if (!released) throw denied(source, target);
        return rename(source, target);
    });
    await writeChatFile(file, 'saved', { platform: 'win32', beforeWrite() {
        assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    } });
    assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
    assert.equal(attempts, 2);
});

test('Windows transient replacement contention commits after rechecking the original', async t => {
    const { directory, file } = fixture(t);
    const rename = fs.renameSync;
    let attempts = 0, checks = 0;
    t.mock.method(fs, 'renameSync', (source, target) => {
        if (target === file && ++attempts === 1) throw denied(source, target);
        return rename(source, target);
    });
    await writeChatFile(file, 'saved', { platform: 'win32', beforeWrite() {
        checks++;
        assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    } });
    assert.equal(attempts, 2);
    assert.equal(checks, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
    assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
});

test('native Windows replacement waits for a temporarily held delete-sharing lock', {
    skip: process.platform !== 'win32' || !process.env.NORA_TEST_PYTHON,
    timeout: 15000,
}, async t => {
    let didClose = true;
    const { file } = fixture(t, { canRemove: () => didClose });
    const script = `import ctypes,sys
from ctypes import wintypes
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
k.CreateFileW.restype=wintypes.HANDLE
k.CloseHandle.argtypes=[wintypes.HANDLE]
h=k.CreateFileW(sys.argv[1],0x80000000,3,None,3,0,None)
if h==ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
try:
 print('held',flush=True)
 if sys.stdin.readline().strip()!='release': raise RuntimeError('Missing explicit lock release')
 if not k.CloseHandle(h): raise ctypes.WinError(ctypes.get_last_error())
 h=None
 print('released',flush=True)
finally:
 if h is not None: k.CloseHandle(h)
`;
    const child = spawn(process.env.NORA_TEST_PYTHON, ['-B', '-u', '-c', script, file], { stdio: ['pipe', 'pipe', 'pipe'] });
    didClose = false;
    let stderr = '', output = '', spawnError;
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', error => { spawnError = error; });
    child.stdin.on('error', error => { spawnError = error; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => {
        didClose = true; resolve({ code, signal });
    }));
    const waitForClose = async () => {
        let timer;
        try {
            return await Promise.race([closed, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Windows lock child did not close within 5000 ms')), 5000);
            })]);
        } finally { clearTimeout(timer); }
    };
    t.after(async () => {
        let force;
        try {
            if (!didClose && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                force = setTimeout(() => { if (!didClose) child.kill('SIGKILL'); }, 250);
            }
            await waitForClose();
        } finally { clearTimeout(force); }
    });
    const waitForMarker = expected => new Promise((resolve, reject) => {
        const finish = error => {
            clearTimeout(timer);
            child.stdout.removeListener('data', check);
            child.removeListener('error', check);
            child.removeListener('close', check);
            error ? reject(error) : resolve();
        };
        const check = () => {
            if (output.split(/\r?\n/).slice(0, -1).includes(expected)) finish();
            else if (spawnError || didClose) finish(spawnError || new Error(stderr || `Windows lock child closed before ${expected}`));
        };
        const timer = setTimeout(() => finish(new Error(`Windows lock marker ${expected} timed out`)), 5000);
        child.stdout.on('data', check);
        child.on('error', check);
        child.on('close', check);
        check();
    });
    await waitForMarker('held');
    assert.equal(didClose, false);
    const rename = fs.renameSync;
    let deniedWhileHeld = false, releaseRequested = false, attempts = 0, checks = 0;
    t.mock.method(fs, 'renameSync', (source, target) => {
        if (path.resolve(target) !== path.resolve(file)) return rename(source, target);
        attempts++;
        try { return rename(source, target); }
        catch (error) {
            if (!releaseRequested) {
                assert.equal(error.syscall, 'rename');
                assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
                assert.equal(didClose, false);
                assert.equal(output.includes('released'), false);
                deniedWhileHeld = true; releaseRequested = true;
                child.stdin.end('release\n');
            }
            throw error;
        }
    });
    await writeChatFile(file, 'saved', { beforeWrite() {
        checks++;
        assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    } });
    await waitForMarker('released');
    const result = await waitForClose();
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(output.trim().split(/\r?\n/), ['held', 'released']);
    assert.equal(didClose, true);
    assert.equal(deniedWhileHeld, true);
    assert.equal(releaseRequested, true);
    assert.ok(attempts >= 2);
    assert.ok(checks >= 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
    t.diagnostic(JSON.stringify({ evidence: 'native-windows-lock-release', pid: child.pid,
        heldAck: true, realRenameDenial: deniedWhileHeld, explicitRelease: releaseRequested,
        releasedAck: true, attempts, checks, actualClose: didClose, ...result }));
});

test('persistent Windows denial has bounded attempts and preserves the existing chat', async t => {
    const { directory, file } = fixture(t);
    let attempts = 0;
    t.mock.method(fs, 'renameSync', (source, target) => { attempts++; throw denied(source, target); });
    await assert.rejects(() => writeChatFile(file, 'unsaved', { platform: 'win32' }), { code: 'EPERM' });
    assert.equal(attempts, 8);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
});

test('a changed revision during contention prevents overwriting the new chat', async t => {
    const { directory, file } = fixture(t);
    let attempts = 0;
    t.mock.method(fs, 'renameSync', (source, target) => {
        attempts++;
        fs.writeFileSync(file, 'concurrent save');
        throw denied(source, target);
    });
    await assert.rejects(() => writeChatFile(file, 'stale save', { platform: 'win32', beforeWrite() {
        if (fs.readFileSync(file, 'utf8') !== 'original') throw Object.assign(new Error('stale revision'), { code: 'NORA_PARTIAL_CHAT_SAVE' });
    } }), { code: 'NORA_PARTIAL_CHAT_SAVE' });
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent save');
    assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
});

test('other platforms and non-contention errors propagate without repeated writes', async t => {
    for (const [platform, code, syscall] of [['darwin', 'EPERM', 'rename'], ['win32', 'ENOSPC', 'rename'], ['win32', 'EPERM', 'open']]) {
        await t.test(`${platform} ${code} ${syscall}`, async child => {
            const { directory, file } = fixture(child);
            let attempts = 0;
            child.mock.method(fs, 'renameSync', (source, target) => { attempts++; throw denied(source, target, code, syscall); });
            await assert.rejects(() => writeChatFile(file, 'unsaved', { platform }), { code });
            assert.equal(attempts, 1);
            assert.equal(fs.readFileSync(file, 'utf8'), 'original');
            assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
        });
    }
});
