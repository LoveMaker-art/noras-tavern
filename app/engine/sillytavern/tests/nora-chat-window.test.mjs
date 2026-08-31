import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.resolve('default/config.yaml'));
const { getChatWindowData } = await import('../src/endpoints/chats.js');

test('returns bounded chat windows without changing the original message order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-chat-window-'));
    const chatPath = path.join(root, 'world.jsonl');
    const header = { chat_metadata: { nora_world: { id: 'world-1' } } };
    const messages = Array.from({ length: 100 }, (_, index) => ({ mes: `message-${index}`, is_user: index % 2 === 0 }));
    fs.writeFileSync(chatPath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));

    try {
        const latest = getChatWindowData(chatPath, { limit: 40 });
        assert.deepEqual(latest.header, header);
        assert.equal(latest.start, 60);
        assert.equal(latest.total, 100);
        assert.equal(latest.hasMore, true);
        assert.deepEqual(latest.messages.map(message => message.mes), messages.slice(60).map(message => message.mes));

        const previous = getChatWindowData(chatPath, { limit: 40, before: latest.start });
        assert.equal(previous.start, 20);
        assert.equal(previous.total, 100);
        assert.deepEqual(previous.messages.map(message => message.mes), messages.slice(20, 60).map(message => message.mes));

        const first = getChatWindowData(chatPath, { limit: 40, before: previous.start });
        assert.equal(first.start, 0);
        assert.equal(first.hasMore, false);
        assert.deepEqual(first.messages.map(message => message.mes), messages.slice(0, 20).map(message => message.mes));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
