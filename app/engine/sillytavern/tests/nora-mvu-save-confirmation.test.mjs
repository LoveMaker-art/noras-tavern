import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createChatWriteQueue } from '../public/scripts/nora-story-ledger/chat-persistence.js';

// Execute the actual canonical save functions with their browser/storage
// dependencies supplied; do not copy their implementation into the fixture.
const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('script.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ['saveChat', 'saveChatNow', 'queueChatWrite', 'saveChatConditional', 'commitNoraStoryEdit'].includes(node.name?.text)).map(node => node.getText(ast).replace(/^export /, '')).join('\n');
function fixture({ ok = true, json = ok ? { ok: true, revision: 'r1' } : { error: 'Forbidden' }, duringWait = false, duringLoad = false } = {}) {
    let target = 'world-a';
    const requests = [], errors = [];
    const context = vm.createContext({
        characters: [{ chat: 'session', name: 'Guide', avatar: 'guide.png' }], this_chid: 0,
        chat: [{ mes: 'A quiet walk.' }], chat_metadata: {}, name2: 'Guide', neutralCharacterName: '',
        getCurrentChatId: () => target, createChatSaveTarget: () => target,
        isNoraProductMode: () => true, matchesNoraChatWindow: () => false,
        currentNoraChatBinding: () => null, NORA_CHAT_WINDOW_SIZE: 40,
        ensureNoraFullChatLoaded: async () => { if (duringLoad) target = 'world-b'; },
        waitUntilCondition: async () => { if (duringWait) target = 'world-b'; },
        DEFAULT_SAVE_EDIT_TIMEOUT: 100, isChatSaving: false, noraChatBackupTransactionDepth: 0,
        createChatWriteQueue,
        Headers,
        compressRequest: async request => request, getRequestHeaders: () => ({}),
        fetch: async (url, request) => { requests.push([url, request]); return { ok, statusText: 'Forbidden', json: async () => json }; },
        console: { warn() {}, error() {} }, toastr: { error: (...args) => errors.push(args) }, t: strings => strings[0],
        cancelDebouncedChatSave() {}, saveTokenCache() {}, saveItemizedPrompts() {},
    });
    context.requestChatWrite = async (url, request) => {
        const response = await context.fetch(url, request);
        return { ...response, data: await response.json() };
    };
    vm.runInContext('const enqueueChatWrite = createChatWriteQueue(busy => { isChatSaving = busy; });\n'+functions, context);
    return { context, requests, errors, changeTarget: () => { target = 'world-b'; } };
}

test('MVU opt-in save confirms a successful HTTP response', async () => {
    const f = fixture();
    const result = await f.context.saveChatConditional({ requireConfirmation: true });
    assert.equal(result.confirmed, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.context.isChatSaving, false);
});
test('MVU opt-in save propagates HTTP failure rather than resolving as saved', async () => {
    const f = fixture({ ok: false });
    await assert.rejects(f.context.saveChatConditional({ requireConfirmation: true }), /Forbidden/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.context.isChatSaving, false);
});
test('ordinary Nora saves also reject HTTP errors', async () => {
    const f = fixture({ ok: false });
    await assert.rejects(f.context.saveChatConditional(), /Forbidden/);
});
test('a slow save and a following MVU save both complete without a one-second lock timeout', async () => {
    const f = fixture();
    f.context.waitUntilCondition = async predicate => {
        if (!predicate()) throw new Error('Timed out waiting for condition');
    };
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let started;
    const firstStarted = new Promise(resolve => { started = resolve; });
    let calls = 0;
    f.context.fetch = async () => {
        calls++;
        if (calls === 1) { started(); await held; }
        return { ok: true, json: async () => ({ ok: true, revision: 'r1' }) };
    };
    const first = f.context.saveChatConditional();
    await firstStarted;
    const second = f.context.saveChatConditional({ requireConfirmation: true });
    const observed = second.catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'second write waits instead of racing the first');
    release();
    await first;
    assert.equal((await observed).confirmed, true);
    assert.equal(calls, 2);
});
for (const phase of ['duringWait', 'duringLoad']) {
    test(`MVU save does not cross a changed chat during ${phase}`, async () => {
        const f = fixture({ [phase]: true });
        const pending = f.context.saveChatConditional({ requireConfirmation: true });
        if (phase === 'duringWait') f.changeTarget();
        await assert.rejects(pending, /active chat/);
        assert.equal(f.requests.length, 0);
    });
}

test('direct and conditional saves share one queue and use the preceding acknowledgement revision', async () => {
    const f = fixture();
    f.context.noraChatWindowState = { serverRevision: 'r0', fullHistoryLoaded: true };
    f.context.matchesNoraChatWindow = () => true;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const revisions = [];
    f.context.fetch = async (_url, request) => {
        revisions.push(JSON.parse(request.body).nora_base_revision);
        if (revisions.length === 1) await held;
        return { ok: true, json: async () => ({ ok: true, revision: `r${revisions.length}` }) };
    };
    const first = f.context.saveChat();
    const second = f.context.saveChatConditional({ requireConfirmation: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(revisions.length, 1);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(revisions, ['r0', 'r1']);
});

test('save retry reuses the exact rejected payload and never forces an overwrite', async () => {
    const f = fixture({ ok: false, json: { error: 'NORA_PARTIAL_CHAT_SAVE' } });
    let error;
    try { await f.context.saveChatConditional(); } catch (e) { error = e; }
    assert.equal(error.phase, 'save');
    assert.equal(f.context.chat.length, 1, 'unsaved data remains in memory');
    await assert.rejects(error.retrySave(), /NORA_PARTIAL_CHAT_SAVE/);
    assert.equal(f.requests[0][1].body, f.requests[1][1].body);
    assert.equal(JSON.parse(f.requests[1][1].body).force, false);
    f.context.chat[0].mes = 'later changes';
    await assert.rejects(error.retrySave(), /聊天内容已改变/);
    assert.equal(f.requests.length, 2);
    f.changeTarget();
    await assert.rejects(error.retrySave(), /active chat/);
    assert.equal(f.requests.length, 2);
});

test('committed edit adopts its revision before MVU edit events and the following save', async () => {
    const f = fixture({ json: { ok: true, revision: 'r2' } });
    const c = f.context;
    c.noraChatWindowState = { serverRevision: 'r0', fullHistoryLoaded: true };
    c.matchesNoraChatWindow = () => true;
    c.getNoraAbsoluteMessageId = id => id;
    c.structuredClone = structuredClone;
    c.applyMessageEdit = (message, text) => ({ text, mes: { ...message, extra: {} } });
    c.editStoryMessage = async () => ({ chat: [{ chat_metadata: {} }, { mes: 'edited' }], revision: 'r1' });
    c.chatElement = { children: () => ({ length: 0 }) };
    c.printMessages = async () => {};
    c.event_types = { MESSAGE_EDITED: 'edit', MESSAGE_UPDATED: 'updated' };
    const revisions = [];
    c.eventSource = { emit: async () => { revisions.push(c.noraChatWindowState.serverRevision); } };
    await c.commitNoraStoryEdit(0, 'edited');
    assert.deepEqual(revisions, ['r1', 'r1']);
    assert.equal(JSON.parse(f.requests[0][1].body).nora_base_revision, 'r1');
});

test('the original 1.5 second overlap reproducer now saves both requests', async () => {
    const f = fixture();
    let count = 0;
    f.context.fetch = async () => {
        if (++count === 1) await new Promise(resolve => setTimeout(resolve, 1500));
        return { ok: true, json: async () => ({ ok: true, revision: 'r1' }) };
    };
    const first = f.context.saveChatConditional();
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = f.context.saveChatConditional({ requireConfirmation: true });
    await first;
    assert.equal((await second).confirmed, true);
    assert.equal(count, 2);
});

test('HTTP 200 without an explicit save acknowledgement is not success', async () => {
    const f = fixture({ json: {} });
    await assert.rejects(f.context.saveChatConditional({ requireConfirmation: true }), { code: 'NORA_CHAT_SAVE_UNCONFIRMED' });
});

test('a successful save-only retry adopts the version without changing the payload', async () => {
    const f = fixture({ ok: false });
    f.context.matchesNoraChatWindow = () => true;
    f.context.noraChatWindowState = { serverRevision: 'r0', fullHistoryLoaded: true };
    let error;
    try { await f.context.saveChatConditional(); } catch (e) { error = e; }
    const initial = f.requests[0][1].body;
    f.context.fetch = async (_url, request) => {
        assert.equal(request.body, initial);
        return { ok: true, json: async () => ({ ok: true, revision: 'r1' }) };
    };
    assert.equal((await error.retrySave()).confirmed, true);
    assert.equal(f.context.noraChatWindowState.serverRevision, 'r1');
});
