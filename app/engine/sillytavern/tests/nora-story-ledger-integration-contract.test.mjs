import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStMessageAdapter } from '../public/scripts/nora-adapters/st-message-adapter.js';

test('Nora historical edit uses one atomic truncate operation before generation, not one remote save per deleted message', async () => {
    const calls = [];
    const chat = [{ is_user: true, mes: 'old1' }, { is_user: false, mes: 'answer1' }, { is_user: true, mes: 'old2' }, { is_user: false, mes: 'answer2' }];
    const context = { chat, chatMetadata: { nora_world: { id: 'world' }, nora_session: { id: 'session' } },
        commitNoraStoryEdit: async (id, text) => { calls.push(['atomic-edit', id]); chat.splice(id + 1); chat[id].mes = text; },
        deleteLastMessage: () => assert.fail('must not delete through repeated saves'),
        regenerate: async () => { calls.push(['generate']); chat.push({ is_user: false, mes: 'New reply' }); },
    };
    const adapter = createStMessageAdapter(() => context, { ensureBackendReady: async () => calls.push(['model-ready']) });
    await adapter.editAndRegenerate(0, 'Changed first action');
    assert.deepEqual(calls, [['model-ready'], ['atomic-edit', 0], ['generate']]);
    assert.equal(chat.length, 2);
    assert.equal(chat[0].mes, 'Changed first action');
});

test('missing model never destroys an existing suffix when editing and regenerating', async () => {
    const context = { chat: [{ is_user: true, mes: 'action' }, { is_user: false, mes: 'reply' }],
        chatMetadata: { nora_world: { id: 'world' }, nora_session: { id: 'session' } },
        commitNoraStoryEdit: () => assert.fail('must not write'),
    };
    const adapter = createStMessageAdapter(() => context, { ensureBackendReady: async () => { throw new Error('missing model'); } });
    await assert.rejects(adapter.editAndRegenerate(0, 'changed'), /missing model/);
    assert.equal(context.chat.length, 2);
});

test('actual ST hooks preserve raw worldbook scan, carry Helper lineage, validate final provider payload and activate after upstream acceptance', () => {
    const native = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const openai = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
    const server = fs.readFileSync(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url), 'utf8');
    const chats = fs.readFileSync(new URL('../src/endpoints/chats.js', import.meta.url), 'utf8');
    const helper = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
    assert.ok(native.indexOf('getWorldInfoPrompt(coreChat') < native.indexOf('oaiMessages = setOpenAIMessages(coreChat)'));
    assert.match(native, /tagHistory\(chat, scopeOf\(chat_metadata\)\)/);
    assert.match(openai, /messages\[i\]\[LEDGER_SOURCE\] = chat\[j\]\[LEDGER_SOURCE\]/);
    assert.match(helper, /w=kt\(await yW\(x\)\)/);
    assert.match(helper, /await wt\(s,CW\)/);
    const finalExclude = server.lastIndexOf('excludeKeysByYaml(requestBody');
    const reserve = server.indexOf('ledgerRuntime.plugin.reserve');
    const fetch = server.indexOf('await fetch(endpointUrl, config)', reserve);
    const accept = server.indexOf('await ledgerDispatch.accept()', fetch);
    assert.ok(finalExclude < reserve && reserve < fetch && fetch < accept);
    assert.match(chats, /request\.body\.force[\s\S]*?request\.user\.directories/);
    assert.match(chats, /resolveStoryLedger\(directories\)\.writeChat/);
});

test('shipped Helper preprocessing keeps ledger lineage attached to each message', async () => {
    const helper = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
    const start = helper.indexOf('async function yW('), end = helper.indexOf('async function bW(', start);
    assert.ok(start >= 0 && end > start);
    const context = vm.createContext({ dt: { USER_INPUT: 1, AI_OUTPUT: 2 }, ut: text => text });
    vm.runInContext(helper.slice(start, end), context);
    const lineage = Symbol('ledger-source');
    const input = [{ mes: 'raw', is_user: true, [lineage]: { source: 'fixture' } }];
    const output = await context.yW(input);
    assert.equal(output[0][lineage], input[0][lineage]);
});
