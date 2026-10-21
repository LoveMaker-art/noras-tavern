import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStoryProgress, collectStoryProductions } from '../src/nora-story-ledger/profile-projection.js';
import { ledgerStatePath } from '../src/nora-story-ledger/state-file.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-progress-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, chats: path.join(root, 'chats') };
    const worlds = [];
    function session(id, { prepared = true, enabled = true } = {}) {
        let world = worlds[0];
        if (!world) worlds.push(world = { world_id: 'world-a', name: 'Same World', lifecycle: { status: 'READY' },
            runtime_card: { binding: { avatar: 'world-a.png' } }, sessions: { items: [] } });
        world.sessions.items.push({ session_id: id, name: id, binding: { chat_id: id } });
        const scope = { worldId: world.world_id, sessionId: id };
        const messages = Array.from({ length: 32 }, (_, i) => ({ is_user: i % 2 === 0, mes: `raw story ${i}` }));
        const ledger = { timeline: [`event in ${id}`], facts: [], open_threads: ['find the key'], objects: [],
            secrets: [{ id: 'hidden', content: 'do not project this', known_by: [] }],
            scene: { time: 'night', place: id, participants: [] }, style_notes: [] };
        const record = { id: `record-${id}`, coveredTurns: 15, messageCount: 30, createdAt: 2000,
            signature: crypto.createHash('sha256').update(prefixText(messages, 30)).digest('hex'), ledger };
        const header = { chat_metadata: { nora_world: { id: world.world_id }, nora_session: { id } } };
        const chatPath = path.join(directories.chats, 'world-a', `${id}.jsonl`);
        const statePath = ledgerStatePath(root, scope);
        fs.mkdirSync(path.dirname(chatPath), { recursive: true }); fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const writeChat = () => fs.writeFileSync(chatPath, [header, ...messages].map(item => JSON.stringify(item)).join('\n'));
        const state = { enabled, active: prepared ? null : { ...record, activatedAt: 3000 }, pending: prepared ? record : null };
        writeChat(); fs.writeFileSync(statePath, JSON.stringify(state));
        return { state, record, statePath, chatPath, messages, header, writeChat };
    }
    return { root, directories, worlds, session,
        progress: () => collectStoryProgress(directories, async () => worlds, () => {}),
        productions: () => collectStoryProductions(directories, async () => worlds, () => {}) };
}

test('saved prepared and active ledgers are readable separately for every branch without activation or writes', async t => {
    const f = fixture(t), prepared = f.session('branch-a'), active = f.session('branch-b', { prepared: false });
    f.session('branch-c'); f.session('branch-d');
    const before = fs.readFileSync(prepared.statePath, 'utf8');
    const progress = await f.progress();
    assert.equal(progress.length, 4, 'the MEMORY selection limit does not truncate the progress source');
    assert.equal(progress[0].summary_status, 'prepared'); assert.equal(progress[1].summary_status, 'active');
    assert.deepEqual(progress[0].timeline, ['event in branch-a']); assert.deepEqual(progress[1].timeline, ['event in branch-b']);
    assert.equal(progress[0].covered_turns, 15); assert.equal(progress[0].total_turns, 16);
    assert.equal(progress[0].message_count, 32); assert.equal(progress[0].covered_message_count, 30);
    assert.deepEqual(progress[0].uncovered, { from_user_turn: 16, to_user_turn: 16, count: 1 });
    assert.equal(fs.readFileSync(prepared.statePath, 'utf8'), before); assert.equal(prepared.state.active, null);
    const productions = await f.productions();
    assert.equal(productions.length, 4); assert.equal(productions[0].session_id, 'branch-a');
    assert.equal(productions[0].story_state.status, 'prepared');
    assert.doesNotMatch(JSON.stringify(progress) + JSON.stringify(productions), /do not project|raw story|secrets|known_by/);
    assert.ok(active.record);
});

test('progress reads the source ledger without display prose; real play time is separate from summary creation time', async t => {
    const f = fixture(t), first = f.session('a'), second = f.session('b'), unknownDate = f.session('c');
    first.record.recap = { current:'At the library.', milestones:['Found a map.'], threads:['Find the key.'] };
    first.messages.at(-1).send_date = '2026-10-20T09:00:00Z'; first.writeChat();
    second.messages.at(-1).send_date = '2026-10-21T09:00:00Z'; second.writeChat();
    unknownDate.messages.at(-1).send_date = 'assistant-12'; unknownDate.writeChat();
    second.record.recap = { current:'x'.repeat(71), milestones:[], threads:[] };
    fs.writeFileSync(first.statePath,JSON.stringify(first.state));fs.writeFileSync(second.statePath,JSON.stringify(second.state));
    const before = fs.readFileSync(first.statePath);
    const rows = await f.progress();
    assert.equal(Object.hasOwn(rows[0],'recap'),false);
    assert.equal(Object.hasOwn(rows[1],'recap'),false);assert.equal(rows[1].status,'ready');
    assert.ok(rows[1].last_played_at>rows[0].last_played_at);
    assert.equal(rows[0].updated_at,rows[1].updated_at);
    assert.equal(rows[2].last_played_at,0,'unparseable source dates must not become invented play times');
    assert.deepEqual(fs.readFileSync(first.statePath),before);
    assert.equal(Object.hasOwn((await f.productions())[0].story_state,'recap'),false,'display text does not consume MEMORY budget');
});

test('disabled valid summaries retain coverage; missing, invalid, corrupt and foreign sources remain distinct from zero', async t => {
    const f = fixture(t), disabled = f.session('a-disabled', { enabled: false }), missing = f.session('b-missing');
    const stale = f.session('c-stale'), broken = f.session('d-broken'), foreign = f.session('e-foreign');
    fs.unlinkSync(missing.statePath);
    stale.messages[0].mes = 'edited source'; stale.writeChat();
    fs.writeFileSync(broken.statePath, '{broken');
    foreign.header.chat_metadata.nora_session.id = 'elsewhere'; foreign.writeChat();
    const results = await f.progress();
    assert.equal(results[0].enabled, false); assert.equal(results[0].covered_turns, 15);
    assert.equal(results[1].status, 'unorganized'); assert.equal(results[1].covered_turns, 0);
    assert.equal(results[2].status, 'stale'); assert.equal(results[2].covered_turns, 0);
    assert.equal(results[3].status, 'error'); assert.equal(results[3].covered_turns, 0);
    assert.equal(results[4].status, 'unavailable'); assert.equal(results[4].total_turns, null);
    assert.equal(JSON.parse(fs.readFileSync(disabled.statePath)).pending.id, disabled.record.id);
});

test('restore receipts and malformed pending schema cannot expose old or arbitrary summaries', async t => {
    const f = fixture(t), restored = f.session('a-restored'), invalid = f.session('b-invalid'), fallback = f.session('c-fallback', { prepared: false });
    restored.header.chat_metadata.nora_restore = { id: 'new-receipt' }; restored.writeChat();
    invalid.state.pending.ledger = { timeline: ['unvalidated'] }; fs.writeFileSync(invalid.statePath, JSON.stringify(invalid.state));
    fallback.state.pending = { ...fallback.record, signature: 'wrong', ledger: { timeline: ['foreign pending'] } };
    fs.writeFileSync(fallback.statePath, JSON.stringify(fallback.state));
    const progress = await f.progress();
    assert.equal(progress[0].status, 'stale'); assert.deepEqual(progress[0].timeline, []);
    assert.equal(progress[1].status, 'stale'); assert.deepEqual(progress[1].timeline, []);
    assert.equal(progress[2].summary_status, 'active'); assert.equal(progress[2].stale_candidate, true);
    assert.deepEqual(progress[2].timeline, ['event in c-fallback']);
});
