import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { trySaveChat, getChatInfo } = await import('../src/endpoints/chats.js');

test('normal saves refuse damaged nonempty headers and preserve their bytes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-st-integrity-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'chat.jsonl');
    for (const damaged of ['not json{', 'null', '[]', '"text"']) {
        await fs.writeFile(file, damaged);
        await assert.rejects(trySaveChat([{ chat_metadata: { integrity: 'expected' } }, { name: 'User', mes: 'new' }], file), /integrity check failed/i);
        assert.equal(await fs.readFile(file, 'utf8'), damaged);
    }
});

test('chat list preserves a degraded preview for a damaged final line and ignores a vanished file', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-st-preview-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'chat.jsonl');
    await fs.writeFile(file, '{"chat_metadata":{}}\n{"name":"User","mes":"kept"}\n{"name":');
    const preview = await getChatInfo(file);
    assert.equal(preview.file_name, 'chat.jsonl');
    assert.equal(preview.chat_items, 1);
    await fs.unlink(file);
    assert.deepEqual(await getChatInfo(file), { match: false });
});
