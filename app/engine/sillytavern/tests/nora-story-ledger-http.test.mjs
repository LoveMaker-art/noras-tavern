import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';
import { ledgerStatePath } from '../src/nora-story-ledger/state-file.js';
import { requestStoryProjection } from '../src/nora-story-ledger/profile-projection.js';
import { prefixText, renderLedger } from '../public/scripts/nora-story-ledger/history.js';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { resolveStoryLedger } = await import('../src/nora-story-ledger/runtime.js');
const { router: ledgerRouter } = await import('../src/endpoints/nora-story-ledger.js');
const { router: chatRouter } = await import('../src/endpoints/chats.js');
const { router: generateRouter } = await import('../src/endpoints/backends/chat-completions.js');

async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}

test('isolated HTTP workflow: real model adapter → candidate → outgoing provider payload → activation → protected save → atomic edit', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-ledger-http-'));
    const directories = { root };
    const projectionEnv = {
        TAVERN_APP_DIR: path.resolve('../../'), TAVERN_STATE_DIR: path.join(root, 'profile'),
        TAVERN_HERMES_MEMORIES_DIR: path.join(root, 'memories'), TAVERN_HERMES_STATE_DB: path.join(root, 'missing.db'),
    };
    const previousEnv = Object.fromEntries(Object.keys(projectionEnv).map(key => [key, process.env[key]]));
    Object.assign(process.env, projectionEnv);
    const readProfile = () => {
        try { return JSON.parse(fs.readFileSync(path.join(root, 'profile/story_profile.json'), 'utf8')); }
        catch { return null; }
    };
    const until = async predicate => {
        const deadline = Date.now() + 3000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Automatic projection did not settle');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    };
    for (const name of ['chats', 'characters', 'worlds', 'backups', 'openAI_Settings', 'instruct', 'context', 'sysprompt', 'reasoning']) {
        directories[name] = path.join(root, name); fs.mkdirSync(directories[name]);
    }
    const ledger = { timeline: ['The player found the map.'], facts: [], open_threads: ['Find the key.'], objects: [], secrets: [],
        scene: { time: '', place: 'Library', participants: [] }, style_notes: [] };
    const providerRequests = [];
    let failNextStoryRequest = false;
    const provider = http.createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); providerRequests.push(body);
        const summarizing = body.messages[0]?.content?.startsWith('Merge previous_state');
        if (!summarizing && failNextStoryRequest) {
            failNextStoryRequest = false;
            response.statusCode = 503;
            return response.end(JSON.stringify({ error: { message: 'fixture upstream failure' } }));
        }
        if (body.stream) {
            response.setHeader('Content-Type', 'text/event-stream');
            return response.end('data: {"choices":[{"delta":{"content":"Streamed reply."}}]}\n\ndata: [DONE]\n\n');
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: summarizing ? JSON.stringify(ledger) : 'A new reply.' } }] }));
    });
    const providerUrl = await listen(provider);
    t.after(async () => {
        await requestStoryProjection(directories);
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ main_api: 'openai', oai_settings: {
        chat_completion_source: 'custom', custom_url: providerUrl, custom_model: 'fixture-only', openai_max_tokens: 1000,
    } }));
    const core = createNoraWorldCore({ root: path.join(root, 'nora-world-core'), materializer: {
        materialize: async () => ({ runtimeCard: { engine: 'sillytavern', binding: { avatar: 'fixture.png' }, ownership: 'owned' },
            defaultSession: { engine: 'sillytavern', binding: { chat_id: 'fixture-chat' }, openingState: 'empty' },
            knowledge: [], declaredCapabilities: [] }),
    } });
    const { world } = await core.createWorld({ name: 'Ledger test', persona: { name: 'Tester', description: '' },
        source: { type: 'character-card', sha256: 'a'.repeat(64), original_name: 'fixture.png', format: 'v3-png' } }, { idempotencyKey: 'ledger-test' });
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const header = { chat_metadata: { nora_world: { id: scope.worldId }, nora_session: { id: scope.sessionId } } };
    const messages = Array.from({ length: 32 }, (_, i) => ({ name: i % 2 ? 'Story' : 'User', is_user: i % 2 === 0, mes: `message ${i}`, send_date: i }));
    const chatFile = path.join(directories.chats, 'fixture', 'fixture-chat.jsonl');
    fs.mkdirSync(path.dirname(chatFile));
    fs.writeFileSync(chatFile, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories, profile: { handle: 'ledger-fixture' } }; next(); });
    app.use('/ledger', ledgerRouter); app.use('/chats', chatRouter); app.use('/generation', generateRouter);
    const server = http.createServer(app);
    const base = await listen(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const post = (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    const inspectedResponse = await post('/ledger/inspect', { ...scope, limit: 2 });
    assert.equal(inspectedResponse.status, 200);
    const inspected = await inspectedResponse.json();
    assert.equal(inspected.totalTurns, 16);
    assert.equal(inspected.messages.length, 2);
    assert.equal(inspected.nextOffset, 2);
    assert.equal(inspected.messageCount, 32);
    assert.equal(inspected.expectedSignature, crypto.createHash('sha256').update(prefixText(messages, messages.length)).digest('hex'));
    assert.equal(providerRequests.length, 0, 'read-only inspection must not schedule an eligible model call');
    assert.equal(fs.existsSync(ledgerStatePath(root, scope)), false, 'inspection must not persist state');
    assert.equal(readProfile(), null, 'inspection must not start memory projection');

    const runtime = resolveStoryLedger(directories); await runtime.resolve(scope);
    await runtime.plugin.schedule(scope);
    const status = await (await post('/ledger/status', scope)).json();
    assert.equal(status.pending.coveredTurns, 15);
    assert.equal(status.active, null);
    assert.equal(readProfile(), null, 'a candidate does not start memory projection');
    assert.equal(providerRequests.length, 1, 'background adapter called the fixture model once');
    assert.equal(providerRequests[0].max_tokens, 20000);
    assert.equal(JSON.parse(providerRequests[0].messages[1].content).entity_bindings.__user__.name, 'Tester');
    assert.match(providerRequests[0].messages[0].content, /Do not substitute __user__ for unregistered characters/);
    assert.match(providerRequests[0].messages[1].content, /message 29/);
    assert.doesNotMatch(providerRequests[0].messages[1].content, /message 30/);

    const proof = { ...scope, recordId: status.pending.id };
    const request = { chat_completion_source: 'custom', custom_url: providerUrl, model: 'fixture-only',
        messages: [{ role: 'system', content: renderLedger(status.pending) }, { role: 'user', content: 'Continue' }],
        stream: false, max_tokens: 1000, nora_story_ledger: proof };
    const stale = await post('/generation/generate', { ...request, messages: [{ role: 'user', content: 'summary removed' }] });
    assert.equal(stale.status, 409);
    assert.equal(providerRequests.length, 1, 'invalid proof never reaches a model');
    const generated = await post('/generation/generate', request);
    assert.equal(generated.status, 200);
    assert.equal(generated.headers.get('X-Nora-Ledger-Activated'), status.pending.id);
    assert.equal((await generated.json()).choices[0].message.content, 'A new reply.');
    assert.equal(providerRequests[1].messages[0].content, renderLedger(status.pending));
    assert.equal('nora_story_ledger' in providerRequests[1], false, 'internal proof never sent to provider');
    await until(() => readProfile()?.shared_story_memory?.[0]?.covered_turns === 15);
    // Profile persistence precedes the asynchronous Hermes projection. Wait
    // for the observable memory result, not merely the earlier JSON commit.
    await until(() => {
        try { return fs.readFileSync(path.join(root, 'memories/MEMORY.md'), 'utf8').includes('player found the map'); }
        catch { return false; }
    });
    assert.match(fs.readFileSync(path.join(root, 'memories/MEMORY.md'), 'utf8'), /player found the map/);
    await requestStoryProjection(directories);
    const profileBeforeRestart = readProfile();
    fs.unlinkSync(path.join(root, 'memories/MEMORY.md'));
    const recovered = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { resolveStoryLedger } from ${JSON.stringify(new URL('../src/nora-story-ledger/runtime.js', import.meta.url).href)};
         resolveStoryLedger(${JSON.stringify(directories)});`], { env: process.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(fs.readFileSync(path.join(root, 'memories/MEMORY.md'), 'utf8'), /player found the map/);
    assert.deepEqual(readProfile(), profileBeforeRestart, 'first use after a restart repairs memory without a new revision or model call');

    const before = fs.readFileSync(chatFile, 'utf8');
    const forged = structuredClone(messages); forged[0].mes = 'overwrite covered history';
    const rejected = await post('/chats/save', { avatar_url: 'fixture.png', file_name: 'fixture-chat', chat: [header, ...forged], force: true, skip_backup: true });
    assert.equal(rejected.status, 409, 'force cannot bypass ledger guard');
    assert.equal(fs.readFileSync(chatFile, 'utf8'), before);
    const protectedRead = await (await post('/ledger/inspect', { ...scope, offset: 29, limit: 3 })).json();
    assert.deepEqual(protectedRead.messages.map(item => item.editable), [false, true, true]);
    const expectedSignature = protectedRead.expectedSignature;
    const lockedEdit = await post('/ledger/edit', { ...scope, messageId: 0, text: 'forbidden', expectedSignature });
    assert.equal(lockedEdit.status, 409);
    assert.equal(fs.readFileSync(chatFile, 'utf8'), before);
    const edited = await post('/ledger/edit', { ...scope, messageId: 30, text: 'Changed sixteenth action', expectedSignature });
    assert.equal(edited.status, 200);
    const editResult = await edited.json();
    assert.equal(editResult.chat.length, 32, 'header + 30 protected messages + edited user16');
    assert.equal(editResult.chat.at(-1).mes, 'Changed sixteenth action');
    assert.equal(editResult.ledger.active.coveredTurns, 15);
    assert.equal(editResult.ledger.totalTurns, 16);
    const obsoleteEdit = await post('/ledger/edit', { ...scope, messageId: 30, text: 'outdated', expectedSignature });
    assert.equal(obsoleteEdit.status, 409, 'an old inspection signature cannot overwrite a newer chat');
    const anotherSession = await post('/ledger/status', { ...scope, sessionId: 'different-session' });
    assert.equal(anotherSession.status, 409);

    const continued = [...editResult.chat.slice(1), { name: 'Story', is_user: false, mes: 'Regenerated response 16', send_date: 31 }];
    for (let i = 32; i < 62; i++) continued.push({ name: i % 2 ? 'Story' : 'User', is_user: i % 2 === 0, mes: `message ${i}`, send_date: i });
    const saved = await post('/chats/save', { avatar_url: 'fixture.png', file_name: 'fixture-chat', chat: [header, ...continued], skip_backup: true });
    assert.equal(saved.status, 200);
    await runtime.plugin.schedule(scope);
    const next = await runtime.plugin.status(scope);
    assert.equal(next.pending.coveredTurns, 30);
    const nextRequest = { ...request, nora_story_ledger: { ...scope, recordId: next.pending.id },
        messages: [{ role: 'system', content: renderLedger(next.pending) }, { role: 'user', content: 'Continue streaming' }], stream: true };
    failNextStoryRequest = true;
    const failed = await post('/generation/generate', nextRequest);
    await failed.text();
    assert.equal(failed.headers.get('X-Nora-Ledger-Activated'), null);
    assert.equal((await runtime.plugin.status(scope)).active.coveredTurns, 15, 'upstream rejection must not advance lock');
    const streamed = await post('/generation/generate', nextRequest);
    assert.equal(streamed.headers.get('X-Nora-Ledger-Activated'), next.pending.id);
    assert.match(await streamed.text(), /Streamed reply/);
    assert.equal((await runtime.plugin.status(scope)).active.coveredTurns, 30);
    await until(() => readProfile()?.shared_story_memory?.[0]?.covered_turns === 30);
    assert.equal(fs.existsSync(ledgerStatePath(root, scope)), true);
    const deleter = createStBackendMaterializer({ directories, stagingRoot: path.join(root, 'staging') });
    await deleter.deleteResources(world, { sessions: [{ session_id: scope.sessionId, delete: true }], runtime_card: { delete: false }, knowledge: [] });
    assert.equal(fs.existsSync(chatFile), false);
    assert.equal(fs.existsSync(ledgerStatePath(root, scope)), false, 'World deletion also removes its private ledger');
    await until(() => readProfile()?.shared_story_memory?.length === 0);
    await requestStoryProjection(directories);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'memories/MEMORY.md'), 'utf8'), /player found the map/);
});
