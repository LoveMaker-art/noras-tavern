import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStCardCodec } from '../src/nora-world-core/st-card-codec.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/nora-story-profile.js');
const { diskCache } = await import('../src/endpoints/characters.js');

async function listen(t, app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('real HTTP and Python reflection: choice, manual independence, partial learning, disable between requests and data protection', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-model-consent-http-'));
    t.after(() => diskCache.dispose());
    const oldDataRoot = globalThis.DATA_ROOT; globalThis.DATA_ROOT = root;
    t.after(() => { globalThis.DATA_ROOT = oldDataRoot; });
    const env = { TAVERN_APP_DIR: path.resolve('../..'), TAVERN_STATE_DIR: path.join(root, 'profile'),
        TAVERN_HERMES_MEMORIES_DIR: path.join(root, 'memories'), TAVERN_HERMES_STATE_DB: path.join(root, 'missing.db'), PYTHONDONTWRITEBYTECODE: '1' };
    const beforeEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
        for (const [key, value] of Object.entries(beforeEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const directories = { root };
    for (const key of ['characters', 'chats', 'worlds', 'backups', 'openAI_Settings', 'instruct', 'context', 'sysprompt', 'reasoning']) {
        directories[key] = path.join(root, key); fs.mkdirSync(directories[key]);
    }
    let calls = 0, learningCalls = 0, failDerived = false, stopDuringReply = false, post;
    const provider = await listen(t, async (request, response) => {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const input = JSON.parse(raw); calls++;
        assert.equal(input.model, 'isolated-text-model');
        const derived = input.messages[0].content.includes('story_tastes=');
        if (derived && failDerived) { response.statusCode = 503; return response.end('{"error":"isolated derived failure"}'); }
        if (!derived && stopDuringReply) {
            stopDuringReply = false;
            assert.equal((await post('/automatic-preferences', { enabled: false })).status, 200);
        }
        // Baseline 1.31 preserves the request-choice scenarios while using the
        // evidence-bound extraction and four-category summary contracts.
        const content = derived ? JSON.stringify({ story_tastes: ['喜欢慢热人物关系'], narrative_habits: [], co_creation: [], boundaries: [] })
            : JSON.stringify({ preferences: [{
                text: ['喜欢慢热克制的人物关系。', '偏爱星际背景下的探险故事。', '不希望出现身体伤害描写。', '希望用第一人称作出关键选择。'][learningCalls++],
                evidence_ids: [JSON.parse(input.messages[1].content).find(message => message.role === 'user' && !message.context_only).id],
            }] });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    const settings = path.join(root, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ sentinel: 'preserve config', main_api: 'openai', oai_settings: {
        chat_completion_source: 'custom', custom_url: provider, custom_model: 'isolated-text-model', openai_max_tokens: 1000,
    } }));
    const codec = createStCardCodec({ serverRoot: process.cwd() });
    const card = await codec.decode({ format: 'json', buffer: Buffer.from(JSON.stringify({ name: 'Synthetic character', description: 'Keep this role' })) });
    const avatar = path.join(directories.characters, 'fixture.png'); fs.writeFileSync(avatar, card.runtimeCardBuffer);
    const core = createNoraWorldCore({ root: path.join(root, 'nora-world-core'), materializer: { materialize: async () => ({
        runtimeCard: { engine: 'sillytavern', binding: { avatar: 'fixture.png' }, ownership: 'owned' },
        defaultSession: { engine: 'sillytavern', binding: { chat_id: 'story' }, openingState: 'empty' }, knowledge: [], declaredCapabilities: [],
    }) } });
    const { world } = await core.createWorld({ name: 'Synthetic world', persona: { name: 'Player', description: 'Keep persona' },
        source: { type: 'character-card', sha256: 'a'.repeat(64), original_name: 'fixture.png', format: 'v3-png' } }, { idempotencyKey: 'consent-world' });
    fs.mkdirSync(path.join(directories.chats, 'fixture'));
    const chatFile = path.join(directories.chats, 'fixture/story.jsonl');
    function writeTurns(turns) {
        const header = { chat_metadata: { nora_world: { id: world.world_id }, nora_session: { id: world.sessions.default_session_id } } };
        const messages = Array.from({ length: turns * 2 }, (_, i) => ({ name: i % 2 ? 'Narrator' : 'Player', is_user: i % 2 === 0, mes: `Synthetic story ${i}`, send_date: `${i}` }));
        fs.writeFileSync(chatFile, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
    }
    writeTurns(15);
    const protectedHash = () => ({ settings: hash(settings), card: hash(avatar), world: JSON.stringify(world) });
    const protectedBefore = protectedHash();
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories, profile: { handle: 'isolated' } }; next(); });
    app.use(router);
    const base = await listen(t, app);
    post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const settingsResponse = await (await fetch(base + '/automatic-preferences')).json();
    assert.equal(settingsResponse.enabled, true);
    assert.equal(settingsResponse.model.name, 'isolated-text-model');
    assert.doesNotMatch(JSON.stringify(settingsResponse), /api_key|base_url|Bearer/);
    const initialChat = hash(chatFile);
    await fetch(base + '/card'); await fetch(base + `/checkpoint/${world.world_id}`);
    assert.equal(calls, 0, 'reading a default or existing profile does not generate');
    const checkpoint = async () => (await post('/checkpoint', { world_id: world.world_id })).json();
    const idle = async () => {
        for (let n = 0; n < 500; n++) {
            const state = await (await fetch(base + `/checkpoint/${world.world_id}`)).json();
            if (!state.running) return state;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('isolated reflection did not settle');
    };
    assert.equal((await checkpoint()).scheduled, true);
    assert.equal((await idle()).reflected_at_turns, 15);
    assert.equal(calls, 2, 'Node and Python both allow a default-on checkpoint without a saved choice');
    assert.equal(fs.existsSync(path.join(root, 'story_profile_preferences.json')), false);
    assert.equal((await post('/automatic-preferences', { enabled: false })).status, 200);
    assert.equal((await checkpoint()).scheduled, false);
    const sameSourceManual = await post('/reflect', { world_id: world.world_id });
    assert.equal(sameSourceManual.status, 200, await sameSourceManual.text());
    assert.equal(calls, 2, 'same-source manual review reuses the confirmed job instead of repeating paid requests');
    assert.equal(hash(chatFile), initialChat);
    writeTurns(16);
    const manualChat = hash(chatFile);
    const manual = await post('/reflect', { world_id: world.world_id });
    assert.equal(manual.status, 200, await manual.text());
    assert.equal(calls, 4, 'manual reflection may learn and refresh, without enabling automatic use');
    assert.equal((await (await fetch(base + '/automatic-preferences')).json()).enabled, false);
    assert.equal((await post('/automatic-preferences', { enabled: 'true' })).status, 400);
    assert.equal((await post('/automatic-preferences', { enabled: true })).status, 200);
    const afterFirst = calls;
    assert.equal((await checkpoint()).scheduled, false); assert.equal(calls, afterFirst);
    assert.equal(hash(chatFile), manualChat);
    writeTurns(31); failDerived = true;
    assert.equal((await checkpoint()).scheduled, true);
    const partial = await idle();
    assert.equal(partial.reflected_at_turns, 31);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.stage, 'summary');
    assert.equal(partial.summary_status, 'failed');
    assert.equal(partial.extraction_complete, true);
    const profileFile = path.join(root, 'profile/story_profile.json');
    const profileBeforeRetry = hash(profileFile), partialCalls = calls;
    assert.equal((await checkpoint()).scheduled, false);
    assert.equal(calls, partialCalls); assert.equal(hash(profileFile), profileBeforeRetry, 'partial learning must not be repeated');
    const preferencesBeforeRecovery = JSON.parse(fs.readFileSync(profileFile, 'utf8')).preferences;
    failDerived = false;
    const recovery = await post('/reflect', { world_id: world.world_id });
    assert.equal(recovery.status, 200, await recovery.text());
    assert.equal(calls, partialCalls + 1, 'partial recovery only retries the saved summary, without extracting or learning again');
    assert.deepEqual(JSON.parse(fs.readFileSync(profileFile, 'utf8')).preferences, preferencesBeforeRecovery);
    const beforeStoppedCall = calls;
    writeTurns(46); stopDuringReply = true;
    assert.equal((await checkpoint()).scheduled, true);
    const stopped = await idle();
    assert.equal(calls, beforeStoppedCall + 1, 'turning off during the first reply prevents the second derived request');
    assert.equal(stopped.reflected_at_turns, 46);
    assert.equal(stopped.status, 'partial');
    assert.equal(stopped.last_code, 'STORY_PROFILE_AUTO_REFLECTION_DISABLED');
    const stoppedProfile = hash(profileFile), stoppedChat = hash(chatFile);
    assert.equal((await checkpoint()).scheduled, false);
    await fetch(base + '/card');
    assert.equal(calls, beforeStoppedCall + 1); assert.equal(hash(profileFile), stoppedProfile); assert.equal(hash(chatFile), stoppedChat);
    assert.deepEqual(protectedHash(), protectedBefore);
    assert.deepEqual(await core.getWorld(world.world_id), world);
});
