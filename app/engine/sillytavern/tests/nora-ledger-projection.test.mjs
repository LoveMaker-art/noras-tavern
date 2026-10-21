import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectStoryProductions, createStoryProjection, storyProjectionOutcome } from '../src/nora-story-ledger/profile-projection.js';
import { ledgerStatePath } from '../src/nora-story-ledger/state-file.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';
import { runStoryProfileAdapter } from '../src/nora-story-profile-adapter.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-ledger-projection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, chats: path.join(root, 'chats') };
    const worlds = [];
    function session(worldId, sessionId, label, activatedAt = 1000) {
        let world = worlds.find(world => world.world_id === worldId);
        if (!world) {
            world = { world_id: worldId, name: worldId, lifecycle: { status: 'READY' },
                runtime_card: { binding: { avatar: `${worldId}.png` } }, sessions: { items: [] } };
            worlds.push(world);
        }
        world.sessions.items.push({ session_id: sessionId, binding: { chat_id: sessionId } });
        const scope = { worldId, sessionId };
        const messages = Array.from({ length: 32 }, (_, i) => ({ is_user: i % 2 === 0, mes: `Raw ${i}`, send_date: i }));
        const record = { id: label, activatedAt, coveredTurns: 15, messageCount: 30,
            signature: crypto.createHash('sha256').update(prefixText(messages, 30)).digest('hex'),
            ledger: { timeline: [label], facts: [], open_threads: ['Find key'],
                secrets: [{ id: 'hidden', content: 'Not directly projected', known_by: [] }],
                scene: { time: '', place: '', participants: [] }, objects: [], style_notes: [] } };
        const header = { chat_metadata: { nora_world: { id: worldId }, nora_session: { id: sessionId } } };
        const chatPath = path.join(directories.chats, worldId, `${sessionId}.jsonl`);
        const statePath = ledgerStatePath(root, scope);
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const writeChat = () => fs.writeFileSync(chatPath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
        writeChat();
        fs.writeFileSync(statePath, JSON.stringify({ active: record, pending: { ...record, id: 'candidate', ledger: { timeline: ['Not activated'] } } }));
        return { world, messages, record, header, statePath, chatPath, writeChat };
    }
    return { root, directories, worlds, session, collect: () => collectStoryProductions(directories, async () => worlds, () => {}) };
}

test('project verified saved summaries separately for every Session, preserving prepared versus active semantics', async t => {
    const f = fixture(t);
    f.session('world-a', 'branch-a', 'Old branch', 1000);
    f.session('world-a', 'branch-b', 'New branch', 2000);
    const pending = f.session('world-b', 'branch-c', 'Candidate only');
    fs.writeFileSync(pending.statePath, JSON.stringify({ active: null, pending: pending.record }));
    const deleted = f.session('world-c', 'branch-d', 'Deleted'); deleted.world.lifecycle.status = 'DELETED';
    const productions = await f.collect();
    assert.equal(productions.length, 3);
    assert.deepEqual(productions.map(item => [item.id, item.session_id, item.story_state.status, item.story_state.timeline]), [
        ['world-a', 'branch-a', 'active', ['Old branch']], ['world-a', 'branch-b', 'active', ['New branch']],
        ['world-b', 'branch-c', 'prepared', ['Candidate only']],
    ]);
    assert.doesNotMatch(JSON.stringify(productions), /Raw|secret|Not activated|Deleted/);
});

test('foreign Session headers and modified covered history cannot become shared memories; IO failures remain visible metadata', async t => {
    const f = fixture(t);
    const a = f.session('world-a', 'a', 'A');
    const b = f.session('world-b', 'b', 'B');
    a.messages[0].mes = 'Changed'; a.writeChat();
    b.header.chat_metadata.nora_session.id = 'other'; b.writeChat();
    const invalid = await f.collect();
    assert.deepEqual(invalid.map(item => item.story_state.status), ['stale', 'unavailable']);
    assert.ok(invalid.every(item => item.story_state.timeline.length === 0));
    fs.writeFileSync(a.statePath, 'broken JSON');
    assert.equal((await f.collect())[0].story_state.status, 'error');
});

test('a restored chat invalidates the old ledger even when its narrative prefix is identical', async t => {
    const f = fixture(t), item = f.session('world-a', 'a', 'Old ledger');
    item.header.chat_metadata.nora_restore = { id: 'restore-a' };
    item.writeChat();
    assert.equal((await f.collect())[0].story_state.status, 'stale');
    const state = JSON.parse(fs.readFileSync(item.statePath, 'utf8'));
    fs.writeFileSync(item.statePath, JSON.stringify({ ...state, restoreId: 'restore-a' }));
    assert.equal((await f.collect()).length, 1);
});

test('queued activation/deletion while a projection is running converges to the latest snapshot', async () => {
    let snapshot = ['world-a'];
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const published = [];
    const projection = createStoryProjection({
        collect: async () => [...snapshot],
        publish: async value => { published.push(value); if (published.length === 1) await blocked; }, notify: () => {},
    });
    const pending = projection.request();
    await new Promise(resolve => setImmediate(resolve));
    snapshot = []; projection.request(); projection.request();
    release(); await pending;
    assert.deepEqual(published, [['world-a'], []]);
});

test('projection failure is isolated and retried automatically, using fresh data', async () => {
    let count = 0;
    let done;
    const recovered = new Promise(resolve => { done = resolve; });
    const published = [];
    const projection = createStoryProjection({ collect: async () => ++count, retryMs: 5, notify: () => {},
        publish: async value => { if (value === 1) throw new Error('transient'); published.push(value); done(); },
    });
    assert.equal(await projection.request(), false);
    let timeout;
    try { await Promise.race([recovered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('retry missing')), 1000); })]); }
    finally { clearTimeout(timeout); }
    assert.deepEqual(published, [2]);
});

test('MEMORY success is independent of USER pending; capacity waits for a changed request rather than an I/O retry loop', async () => {
    assert.deepEqual(storyProjectionOutcome({ code: 0, value: { ok: true, status: 'partial', projections: {
        user: { status: 'pending', code: 'STORY_PROFILE_SUMMARY_REFRESH_REQUIRED' }, memory: { status: 'complete' },
    } } }), { status: 'complete' });
    const receipt = { code: 0, value: { ok: true, status: 'partial', projections: {
        user: { status: 'complete' }, memory: { status: 'pending', code: 'STORY_PROFILE_MEMORY_BUDGET_EXHAUSTED' },
    } } };
    let calls = 0;
    const projection = createStoryProjection({ collect: async () => [], retryMs: 5, notify: () => {},
        publish: async () => { calls++; return storyProjectionOutcome(receipt); } });
    assert.equal(await projection.request(), false);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
    receipt.value.projections.memory = { status: 'complete' };
    assert.equal(await projection.request(), true); assert.equal(calls, 2);
    assert.throws(() => storyProjectionOutcome({ code: 0, value: { ok: true, projections: {
        memory: { status: 'pending', code: 'STORY_PROFILE_MEMORY_IO_PENDING' },
    } } }), /I\/O retry/);
});

test('real Python adapter updates archived plot without resident injection, preserves USER and other memory bytes, and removes deleted World progress', async t => {
    const f = fixture(t);
    const entry = f.session('world-a', 'session-a', 'A key was found');
    const memories = path.join(f.root, 'memories'); fs.mkdirSync(memories);
    const env = { ...process.env, TAVERN_STATE_DIR: path.join(f.root, 'profile'),
        TAVERN_APP_DIR: fileURLToPath(new URL('../../../', import.meta.url)),
        TAVERN_HERMES_MEMORIES_DIR: memories, TAVERN_HERMES_STATE_DB: path.join(f.root, 'missing.db') };
    // An existing preference awaiting its bounded summary leaves USER pending.
    // Plot synchronization must still update the archive while retaining both
    // complete original memory files, including their newline/encoding bytes.
    const initialized = spawnSync(env.TAVERN_PYTHON || 'python3', ['-B', '-c',
        'import sys; sys.path.insert(0, sys.argv[1]); import story_profile as p; p.record_learning(sys.argv[2], sys.argv[3], "偏爱合成悬疑故事", "synthetic fixture", source_id="existing-preference")',
        path.join(env.TAVERN_APP_DIR, 'story_profile_runtime/core'), env.TAVERN_STATE_DIR, path.join(env.TAVERN_APP_DIR, 'actor_self.md')],
    { env, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const originalUser = Buffer.from('Existing personal notes\r\n保留USER原文。\r\n\r\n');
    const originalMemory = Buffer.from('Existing non-Tavern memory\r\n保留其他记忆。\r\n\r\n');
    const userFile = path.join(memories, 'USER.md'), memoryFile = path.join(memories, 'MEMORY.md');
    fs.writeFileSync(userFile, originalUser); fs.writeFileSync(memoryFile, originalMemory);
    const preservedMemories = () => {
        assert.deepEqual(fs.readFileSync(userFile), originalUser);
        assert.deepEqual(fs.readFileSync(memoryFile), originalMemory);
    };
    const run = async () => {
        const result = await runStoryProfileAdapter('sync-story-states', { productions: await f.collect() }, { env });
        assert.equal(result.code, 0, result.stderr + JSON.stringify(result.value));
        assert.equal(result.value.ok, true);
        assert.equal(result.value.projections.user.status, 'pending');
        assert.equal(result.value.projections.memory.status, 'complete');
        preservedMemories();
    };
    await run();
    const profilePath = path.join(env.TAVERN_STATE_DIR, 'story_profile.json');
    const first = fs.readFileSync(profilePath, 'utf8');
    const archived = JSON.parse(first);
    assert.equal(archived.shared_story_memory[0].source_status, 'active');
    assert.deepEqual(archived.shared_story_memory[0].events, ['A key was found']);
    assert.doesNotMatch(fs.readFileSync(memoryFile, 'utf8') + fs.readFileSync(userFile, 'utf8'), /A key was found/);
    await run(); assert.equal(fs.readFileSync(profilePath, 'utf8'), first);
    fs.unlinkSync(entry.statePath); await run();
    const missing = JSON.parse(fs.readFileSync(profilePath)).shared_story_memory;
    assert.equal(missing.length, 1); assert.equal(missing[0].source_status, 'missing');
    assert.equal(missing[0].session_id, 'session-a'); assert.deepEqual(missing[0].events, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(profilePath)).preferences, archived.preferences);
    entry.world.lifecycle.status = 'DELETED'; await run();
    assert.deepEqual(JSON.parse(fs.readFileSync(profilePath)).shared_story_memory, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(profilePath)).preferences, archived.preferences);
    preservedMemories();
});
