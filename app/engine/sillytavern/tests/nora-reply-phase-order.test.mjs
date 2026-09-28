import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(node => node.declaration || node).find(node => node.id?.name === 'saveReply');

function fixture({ type = 'normal', nora = true, callback = async () => {} } = {}) {
    const previous = { is_user: type === 'normal', mes: 'old', extra: {}, swipe_id: 0, swipes: ['old'] };
    if (type === 'swipe') previous.swipe_id = 1;
    const visible = new Map([[0, previous.mes]]);
    const events = [];
    let entered;
    const received = new Promise(resolve => { entered = resolve; });
    const context = {
        chat: [previous], console: { debug() {} }, Date, structuredClone,
        generation_started: new Date(), name2: 'test', power_user: {},
        getMessageTimeStamp: () => 'now', getGeneratingApi: () => 'test', getGeneratingModel: () => 'test',
        processImageAttachment: async () => {}, isNoraProductMode: () => nora,
        getCurrentChatId: () => context.chatId, chatId: 'original',
        event_types: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: { async emit(event, id) {
            events.push(event);
            if (event === 'received') { entered(id); await callback(context, id); }
        } },
        addOneMessage(message, options = {}) {
            const id = context.chat.indexOf(message);
            if (options.type !== 'swipe') assert.equal(visible.has(id), false, 'must not append a duplicate message');
            visible.set(id, message.mes);
            events.push('display');
        },
    };
    vm.createContext(context);
    vm.runInContext(source.slice(declaration.start, declaration.end), context);
    return { context, visible, events, received, run: options => context.saveReply({ type, getMessage: 'new body', ...options }) };
}

for (const type of ['normal', 'swipe', 'append', 'continue', 'appendFinal']) {
    test(`${type}: completed body is visible while MESSAGE_RECEIVED/MVU is still waiting`, async () => {
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        const f = fixture({ type, callback: () => blocked });
        let completed = false;
        const run = f.run().then(() => { completed = true; });
        const id = await f.received;
        try {
            assert.equal(f.visible.get(id), type === 'append' || type === 'continue' ? 'oldnew body' : 'new body');
            assert.equal(completed, false, 'must still await MVU, not fire and forget');
            assert.deepEqual(f.events, ['display', 'received']);
        } finally { release(); await run; }
        assert.equal(f.events.at(-1), 'rendered');
        assert.equal(f.events.filter(event => event === 'display').length, 1, 'unchanged reply must not render twice');
    });
}

test('hook edits refresh the same message before CHARACTER_MESSAGE_RENDERED', async () => {
    const f = fixture({ callback: async (context, id) => { context.chat[id].mes = 'post-processed'; } });
    await f.run();
    assert.equal(f.visible.get(1), 'post-processed');
    assert.deepEqual(f.events, ['display', 'received', 'display', 'rendered']);
});

test('a failed hook does not hide the completed body or swallow the error', async () => {
    const f = fixture({ callback: async () => { throw new Error('MVU failure'); } });
    await assert.rejects(f.run(), /MVU failure/);
    assert.equal(f.visible.get(1), 'new body');
});

test('switching chats inside a hook cannot update or add swipe metadata to the new chat', async () => {
    const replacement = { is_user: true, mes: 'different chat', extra: {} };
    const f = fixture({ callback: async context => { context.chat = [replacement]; context.chatId = 'new'; } });
    await f.run();
    assert.equal(replacement.swipe_id, undefined);
    assert.deepEqual(f.events, ['display', 'received']);
});

test('streaming keeps its separate event lifecycle', async () => {
    const f = fixture();
    await f.run({ fromStreaming: true });
    assert.deepEqual(f.events, ['display']);
});

test('non-Nora native mode retains its existing hook-before-render behavior', async () => {
    const f = fixture({ nora: false });
    await f.run();
    assert.deepEqual(f.events, ['received', 'display', 'rendered']);
});
