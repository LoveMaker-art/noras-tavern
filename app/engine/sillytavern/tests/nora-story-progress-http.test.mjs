import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { ledgerStatePath } from '../src/nora-story-ledger/state-file.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router: profileRouter } = await import('../src/endpoints/nora-story-profile.js');
const { router: ledgerRouter } = await import('../src/endpoints/nora-story-ledger.js');

async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}

function snapshot(root) {
    const result = {};
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(target);
            else result[path.relative(root, target)] = {
                hash: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
                modified: fs.statSync(target).mtimeMs,
            };
        }
    }
    visit(root);
    return result;
}

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-progress-http-'));
    const directories = { root };
    for (const name of ['chats', 'characters', 'worlds', 'backups']) {
        directories[name] = path.join(root, name); fs.mkdirSync(directories[name]);
    }
    let modelRequests = 0;
    const provider = http.createServer((_request, response) => { modelRequests++; response.end('{}'); });
    const providerUrl = await listen(provider);
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ main_api: 'openai', oai_settings: {
        chat_completion_source: 'custom', custom_url: providerUrl, custom_model: 'offline-probe', openai_max_tokens: 1000, openai_max_context: 8192,
    } }));
    const core = createNoraWorldCore({ root: path.join(root, 'nora-world-core'), materializer: {
        materialize: async () => ({ runtimeCard: { engine: 'sillytavern', binding: { avatar: 'fixture.png' }, ownership: 'owned' },
            defaultSession: { engine: 'sillytavern', binding: { chat_id: 'fixture-chat' }, openingState: 'empty' },
            knowledge: [], declaredCapabilities: [] }),
    } });
    const { world } = await core.createWorld({ name: 'Prepared story', persona: { name: 'Tester', description: '' },
        source: { type: 'character-card', sha256: 'a'.repeat(64), original_name: 'fixture.png', format: 'v3-png' } }, { idempotencyKey: 'story-progress-http' });
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const header = { chat_metadata: { nora_world: { id: scope.worldId }, nora_session: { id: scope.sessionId } } };
    const messages = Array.from({ length: 32 }, (_, index) => ({ name: index % 2 ? 'Story' : 'User', is_user: index % 2 === 0, mes: `story message ${index}` }));
    const chatPath = path.join(directories.chats, 'fixture', 'fixture-chat.jsonl');
    fs.mkdirSync(path.dirname(chatPath));
    const writeChat = () => fs.writeFileSync(chatPath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
    writeChat();
    const ledger = { timeline: ['The player found a map.'], facts: [], open_threads: ['Find the key.'], objects: [], secrets: [],
        scene: { time: '', place: 'Library', participants: [] }, style_notes: [] };
    const record = { id: 'prepared-record', coveredTurns: 15, messageCount: 30, createdAt: 2000,
        signature: crypto.createHash('sha256').update(prefixText(messages, 30)).digest('hex'), ledger };
    const statePath = ledgerStatePath(root, scope);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const state = { version: 1, enabled: false, active: null, pending: record };
    const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state));
    writeState();
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => {
        const selected = request.headers['x-fixture-unreadable'] ? { ...directories, root: path.join(root, 'settings.json') }
            : request.headers['x-fixture-missing'] ? { ...directories, root: path.join(root, 'never-created') } : directories;
        request.user = { directories: selected, profile: { handle: 'story-progress-offline' } }; next();
    });
    app.use('/profile', profileRouter); app.use('/ledger', ledgerRouter);
    const server = http.createServer(app);
    const base = await listen(server);
    t.after(async () => {
        server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const get = (query, options) => fetch(base + '/profile/progress' + query, options);
    const inspect = body => fetch(base + '/ledger/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, ...body }) });
    const read = body => fetch(base + '/profile/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { root, scope, header, messages, state, statePath, record, get, inspect, read, writeState, writeChat, modelRequests: () => modelRequests };
}

test('real progress route filters exact identity and reads prepared summaries without activation, file writes or model calls', async t => {
    const f = await fixture(t), before = snapshot(f.root);
    const allResponse = await f.get('');
    assert.equal(allResponse.status, 200); assert.equal(allResponse.headers.get('cache-control'), 'no-store');
    const all = await allResponse.json();
    assert.equal(all.story_progress.length, 1);
    const entry = all.story_progress[0];
    assert.equal(entry.summary_status, 'prepared'); assert.equal(entry.enabled, false);
    assert.equal(entry.covered_turns, 15); assert.equal(entry.total_turns, 16);
    assert.equal(entry.message_count, 32); assert.equal(entry.covered_message_count, 30);
    assert.deepEqual(entry.timeline, ['The player found a map.']);
    assert.match(entry.history_signature, /^[a-f0-9]{64}$/);
    const scoped = await f.get(`?world_id=${f.scope.worldId}&session_id=${f.scope.sessionId}`);
    assert.deepEqual(await scoped.json(), all);
    for (const [query, status] of [
        ['?world_id=unknown', 404], [`?world_id=${f.scope.worldId}&session_id=unknown`, 404],
        ['?world_id=one&world_id=two', 400],
    ]) {
        const response = await f.get(query);
        assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const unavailable = await f.get('', { headers: { 'X-Fixture-Unreadable': '1' } });
    assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    const error = await unavailable.json();
    assert.ok(error.code); assert.equal('story_progress' in error, false, 'a failed global read must not be returned as an empty story list');
    const missing = await f.get('', { headers: { 'X-Fixture-Missing': '1' } });
    assert.equal(missing.status, 200); assert.deepEqual(await missing.json(), { story_progress: [] });
    assert.equal(fs.existsSync(path.join(f.root, 'never-created')), false, 'cold empty reads must not initialize World Core storage');
    const inspected = await (await f.inspect({ limit: 2 })).json();
    assert.equal(inspected.pending.id, 'prepared-record'); assert.equal(inspected.active, null);
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(f.modelRequests(), 0);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath)).active, null);
});

test('real read-only routes expose stale progress and bounded raw chat while retaining the invalid active record unchanged', async t => {
    const f = await fixture(t);
    f.state.active = { ...f.record, activatedAt: 3000 }; f.state.pending = null; f.writeState();
    f.messages[0].mes = 'changed story source'; f.writeChat();
    const before = snapshot(f.root);
    const progress = await (await f.get(`?world_id=${f.scope.worldId}&session_id=${f.scope.sessionId}`)).json();
    assert.equal(progress.story_progress[0].status, 'stale');
    assert.equal(progress.story_progress[0].covered_turns, 0, 'zero describes the currently usable summary prefix, not missing story history');
    assert.equal(progress.story_progress[0].covered_message_count, 0);
    assert.equal(progress.story_progress[0].total_turns, 16);
    assert.equal(progress.story_progress[0].message_count, 32);
    assert.deepEqual(progress.story_progress[0].timeline, []);
    const protectedRead = await f.inspect({ offset: 0, limit: 2 });
    assert.equal(protectedRead.status, 409);
    const response = await f.inspect({ offset: 0, limit: 2, allowStaleLedgerRead: true });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const read = await response.json();
    assert.equal(read.staleActive, true); assert.equal(read.active, null);
    assert.equal(read.messages.length, 2); assert.equal(read.messages[0].text, 'changed story source');
    assert.ok(read.messages.every(message => message.editable === false));
    assert.equal(read.nextOffset, 2);
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(f.modelRequests(), 0);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath)).active.id, 'prepared-record');
});

test('cold progress routing reports corrupt world storage without quarantining or changing any source', async t => {
    const f = await fixture(t);
    const broken = path.join(f.root, 'nora-world-core/worlds/broken.json');
    fs.writeFileSync(broken, '{broken world source');
    const before = snapshot(f.root);
    const response = await f.get('');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.code, 'NORA_WORLD_STORAGE_CORRUPT'); assert.equal('story_progress' in result, false);
    const history = await f.inspect({ offset: 0, limit: 2, allowStaleLedgerRead: true });
    assert.equal(history.status, 400);
    assert.equal((await history.json()).code, 'NORA_WORLD_STORAGE_CORRUPT');
    assert.deepEqual(snapshot(f.root), before);
    assert.equal(fs.readFileSync(broken, 'utf8'), '{broken world source');
    assert.equal(f.modelRequests(), 0);
});

test('actual scoped read POST is bounded, source-backed, name-compatible and never invokes models, writers or implicit raw attachment', async t => {
    const f = await fixture(t), before = snapshot(f.root);
    const response = await f.read({ worldName: 'Prepared story', view: 'overview', maxChars: 1400 });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.schema, 'nora-story-read/1'); assert.equal(result.read_only, true); assert.equal(result.model_called, false);
    assert.equal(result.status, 'ready'); assert.equal(result.source.autoEnabled, false);
    assert.equal(result.source.status, 'prepared'); assert.equal(result.scope.worldId, f.scope.worldId);
    assert.equal(result.scope.sessionId, f.scope.sessionId); assert.equal(result.scope.sessionName, '未命名分支');
    assert.deepEqual(result.ledger.timeline, f.record.ledger.timeline); assert.deepEqual(result.recent_history, []);
    assert.ok(JSON.stringify(result).length <= 1400);
    const recent = await (await f.read({ ...f.scope, includeRecent: true, recentLimit: 2, view: 'threads', maxChars: 1800 })).json();
    assert.deepEqual(recent.recent_history.map(item => item.messageId), [30, 31]);
    assert.deepEqual(recent.recent_history.map(item => item.userTurn), [16, 16]);
    assert.deepEqual(recent.omitted.recent.notReturnedMessageIdRanges, [[0, 29]]);
    assert.equal(recent.omitted.recent.messageIdBase, 0); assert.equal(recent.omitted.recent.rangesInclusive, true);
    assert.ok(JSON.stringify(recent).length <= 1800); assert.equal(recent.omitted.recent.unread, 30);
    for (const body of [{ ...f.scope, maxChars: 999 }, { ...f.scope, includeRecent: 'yes' }, { ...f.scope, view: 'secrets' }]) {
        const invalid = await f.read(body); assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(snapshot(f.root), before); assert.equal(f.modelRequests(), 0);
});

test('actual fallback POST distinguishes an interior empty-message gap from all earlier history', async t => {
    const f = await fixture(t);
    fs.unlinkSync(f.statePath); f.messages[29].mes = ''; f.writeChat();
    const before = snapshot(f.root);
    const response = await f.read({ ...f.scope, includeRecent: true, recentLimit: 10, maxChars: 6000 });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.source.messageCount, 32); assert.equal(result.source.totalTurns, 16);
    assert.deepEqual(result.recent_history.map(item => item.messageId), [21, 22, 23, 24, 25, 26, 27, 28, 30, 31]);
    assert.deepEqual(result.omitted.recent.notReturnedMessageIdRanges, [[0, 20], [29, 29]]);
    assert.equal(result.omitted.recent.unread, 22); assert.ok(JSON.stringify(result).length <= 6000);
    assert.deepEqual(snapshot(f.root), before); assert.equal(f.modelRequests(), 0);
});
