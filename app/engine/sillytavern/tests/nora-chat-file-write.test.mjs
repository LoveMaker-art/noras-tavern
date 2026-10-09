import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeChatFileSync } from '../src/chat-file-write.js';

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

test('Windows transient replacement contention commits after rechecking the original', t => {
    const { directory, file } = fixture(t);
    const rename = fs.renameSync;
    let attempts = 0, checks = 0;
    t.mock.method(fs, 'renameSync', (source, target) => {
        if (target === file && ++attempts === 1) throw denied(source, target);
        return rename(source, target);
    });
    writeChatFileSync(file, 'saved', { platform: 'win32', beforeWrite() {
        checks++;
        assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    } });
    assert.equal(attempts, 2);
    assert.equal(checks, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
    assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
});

test('persistent Windows denial has bounded attempts and preserves the existing chat', t => {
    const { directory, file } = fixture(t);
    let attempts = 0;
    t.mock.method(fs, 'renameSync', (source, target) => { attempts++; throw denied(source, target); });
    assert.throws(() => writeChatFileSync(file, 'unsaved', { platform: 'win32' }), { code: 'EPERM' });
    assert.equal(attempts, 5);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
});

test('a changed revision during contention prevents overwriting the new chat', t => {
    const { directory, file } = fixture(t);
    let attempts = 0;
    t.mock.method(fs, 'renameSync', (source, target) => {
        attempts++;
        fs.writeFileSync(file, 'concurrent save');
        throw denied(source, target);
    });
    assert.throws(() => writeChatFileSync(file, 'stale save', { platform: 'win32', beforeWrite() {
        if (fs.readFileSync(file, 'utf8') !== 'original') throw Object.assign(new Error('stale revision'), { code: 'NORA_PARTIAL_CHAT_SAVE' });
    } }), { code: 'NORA_PARTIAL_CHAT_SAVE' });
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent save');
    assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
});

test('other platforms and non-contention errors propagate without repeated writes', async t => {
    for (const [platform, code, syscall] of [['darwin', 'EPERM', 'rename'], ['win32', 'ENOSPC', 'rename'], ['win32', 'EPERM', 'open']]) {
        await t.test(`${platform} ${code} ${syscall}`, child => {
            const { directory, file } = fixture(child);
            let attempts = 0;
            child.mock.method(fs, 'renameSync', (source, target) => { attempts++; throw denied(source, target, code, syscall); });
            assert.throws(() => writeChatFileSync(file, 'unsaved', { platform }), { code });
            assert.equal(attempts, 1);
            assert.equal(fs.readFileSync(file, 'utf8'), 'original');
            assert.deepEqual(fs.readdirSync(directory), ['chat.jsonl']);
        });
    }
});
