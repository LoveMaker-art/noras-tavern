import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { writeChatFile } from '../src/chat-file-write.js';

function fixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-chat-rename-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
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
    const { file } = fixture(t);
    const script = `import ctypes,sys,time\nfrom ctypes import wintypes\nk=ctypes.WinDLL('kernel32',use_last_error=True)\nk.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]\nk.CreateFileW.restype=wintypes.HANDLE\nk.CloseHandle.argtypes=[wintypes.HANDLE]\nh=k.CreateFileW(sys.argv[1],0x80000000,3,None,3,0,None)\nif h==ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())\ntry:\n print('held',flush=True)\n time.sleep(0.6)\nfinally: k.CloseHandle(h)\n`;
    const child = spawn(process.env.NORA_TEST_PYTHON, ['-B', '-u', '-c', script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
    await new Promise((resolve, reject) => {
        let output = '', ready = false;
        const timer = setTimeout(() => reject(new Error('Windows lock marker timed out')), 10000);
        t.after(() => clearTimeout(timer));
        child.stdout.on('data', chunk => {
            output += chunk;
            if (!output.includes('\n')) return;
            clearTimeout(timer); ready = true;
            if (output.trim() === 'held') resolve();
            else reject(new Error('Unexpected lock marker'));
        });
        child.once('error', reject);
        child.once('exit', () => { if (!ready) { clearTimeout(timer); reject(new Error(stderr || 'Windows lock child exited before its marker')); } });
    });
    await writeChatFile(file, 'saved', { beforeWrite() { assert.equal(fs.readFileSync(file, 'utf8'), 'original'); } });
    assert.equal(await closed, 0, stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
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
