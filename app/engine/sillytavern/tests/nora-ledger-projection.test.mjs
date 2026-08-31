import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStoryProductions, createStoryProjection } from '../src/nora-story-ledger/profile-projection.js';
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
            ledger: { timeline: [label], open_threads: ['Find key'], secrets: ['Not directly projected'], scene: {}, objects: [] } };
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

test('project verified active summaries, not raw chats/candidates; one most recent branch per World', async t => {
    const f = fixture(t);
    f.session('world-a', 'branch-a', 'Old branch', 1000);
    f.session('world-a', 'branch-b', 'New branch', 2000);
    const pending = f.session('world-b', 'branch-c', 'Candidate only');
    fs.writeFileSync(pending.statePath, JSON.stringify({ active: null, pending: pending.record }));
    const deleted = f.session('world-c', 'branch-d', 'Deleted'); deleted.world.lifecycle.status = 'DELETED';
    const productions = await f.collect();
    assert.deepEqual(productions, [{ id: 'world-a', name: 'world-a', story_state: {
        turns: 15, timeline: ['New branch'], open_threads: ['Find key'], updated_at: 2,
    } }]);
    assert.doesNotMatch(JSON.stringify(productions), /Raw|secret|candidate|Deleted/);
});

test('foreign Session headers and modified covered history cannot become shared memories; IO failures do not look like an empty snapshot', async t => {
    const f = fixture(t);
    const a = f.session('world-a', 'a', 'A');
    const b = f.session('world-b', 'b', 'B');
    a.messages[0].mes = 'Changed'; a.writeChat();
    b.header.chat_metadata.nora_session.id = 'other'; b.writeChat();
    assert.deepEqual(await f.collect(), []);
    fs.writeFileSync(a.statePath, 'broken JSON');
    await assert.rejects(f.collect(), SyntaxError);
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

test('real Python adapter projects an active ledger, preserves unmanaged text, is idempotent, and removes deleted World memory', async t => {
    const f = fixture(t);
    const entry = f.session('world-a', 'session-a', 'A key was found');
    const memories = path.join(f.root, 'memories'); fs.mkdirSync(memories);
    fs.writeFileSync(path.join(memories, 'USER.md'), 'Existing personal notes\n');
    fs.writeFileSync(path.join(memories, 'MEMORY.md'), 'Existing non-Tavern memory\n');
    const env = { ...process.env, TAVERN_STATE_DIR: path.join(f.root, 'profile'),
        TAVERN_APP_DIR: fileURLToPath(new URL('../../../', import.meta.url)),
        TAVERN_HERMES_MEMORIES_DIR: memories, TAVERN_HERMES_STATE_DB: path.join(f.root, 'missing.db') };
    const run = async () => {
        const result = await runStoryProfileAdapter('sync-story-states', { productions: await f.collect() }, { env });
        assert.equal(result.code, 0, result.stderr + JSON.stringify(result.value));
        assert.equal(result.value.ok, true);
    };
    await run();
    const profilePath = path.join(env.TAVERN_STATE_DIR, 'story_profile.json');
    const first = fs.readFileSync(profilePath, 'utf8');
    assert.match(fs.readFileSync(path.join(memories, 'MEMORY.md'), 'utf8'), /A key was found/);
    assert.match(fs.readFileSync(path.join(memories, 'MEMORY.md'), 'utf8'), /Existing non-Tavern memory/);
    assert.match(fs.readFileSync(path.join(memories, 'USER.md'), 'utf8'), /Existing personal notes/);
    assert.doesNotMatch(fs.readFileSync(path.join(memories, 'USER.md'), 'utf8'), /A key was found/);
    await run(); assert.equal(fs.readFileSync(profilePath, 'utf8'), first);
    fs.unlinkSync(entry.statePath); await run();
    assert.deepEqual(JSON.parse(fs.readFileSync(profilePath)).shared_story_memory, []);
    assert.doesNotMatch(fs.readFileSync(path.join(memories, 'MEMORY.md'), 'utf8'), /A key was found/);
    assert.match(fs.readFileSync(path.join(memories, 'MEMORY.md'), 'utf8'), /Existing non-Tavern memory/);
});
