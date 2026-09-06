import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.resolve('default/config.yaml'));
const { getChatWindowData, isNoraPartialChatOverwrite } = await import('../src/endpoints/chats.js');

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
        assert.match(latest.revision, /^[a-f0-9]{64}$/);
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

test('detects a bounded Nora tail before it can overwrite complete history', () => {
    const header = { chat_metadata: { integrity: 'same-chat', nora_world: { id: 'world-1' } } };
    const messages = Array.from({ length: 120 }, (_, index) => ({
        send_date: `2026-09-06T00:${String(index).padStart(2, '0')}:00Z`,
        name: index % 2 === 0 ? 'User' : 'Character',
        is_user: index % 2 === 0,
        is_system: false,
        mes: `message-${index}`,
    }));
    const complete = [header, ...messages];

    assert.equal(isNoraPartialChatOverwrite(complete, [header, ...messages.slice(80)]), true);
    assert.equal(isNoraPartialChatOverwrite(complete, [header, { ...messages[80], mes: 'edited-tail' }, ...messages.slice(81)]), true);
    assert.equal(isNoraPartialChatOverwrite(complete, [header, ...messages.slice(80), { ...messages[119], mes: 'appended-tail' }]), true);
    assert.equal(isNoraPartialChatOverwrite(complete, [header, ...messages.slice(80), ...Array.from({ length: 80 }, (_, index) => ({ ...messages[119], mes: `new-${index}` }))]), true);
    assert.equal(isNoraPartialChatOverwrite(complete, [header, ...messages.slice(0, 40)]), true);
    assert.equal(isNoraPartialChatOverwrite(complete, [header, ...messages.slice(0, 40)], { completeHistory: true, baseRevision: 'stale' }), true);
    const revision = crypto.createHash('sha256')
        .update(complete.map(message => JSON.stringify(message)).join('\n'))
        .digest('hex');
    assert.equal(isNoraPartialChatOverwrite(complete, [header, ...messages.slice(0, 40)], { completeHistory: true, baseRevision: revision }), false);
    assert.equal(isNoraPartialChatOverwrite(complete, [header]), true);
    assert.equal(isNoraPartialChatOverwrite(complete, [header], { completeHistory: true, baseRevision: revision }), false);
    assert.equal(isNoraPartialChatOverwrite(complete, complete), false);
    assert.equal(isNoraPartialChatOverwrite(complete, [...complete, { ...messages[119], mes: 'safe-append' }]), false);
    assert.equal(isNoraPartialChatOverwrite(complete, [{ chat_metadata: { integrity: 'same-chat' } }, ...messages.slice(80)]), false);
});
