import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadStoryProfileCard, loadStoryProfileStoryProgress } from '../src/nora-story-profile.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-profile-story-progress-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const worlds = Array.from({ length: 5 }, (_, index) => ({ world_id: `w${index}`, name: `世界${index}`,
        runtime_card: { binding: { avatar: `card${index}.png` } },
        sessions: { default_session_id: `s${index}`, items: [{ session_id: `s${index}`, name: `会话${index}` }] } }));
    worlds[0].sessions.items.push({ session_id: 's0-alternate', name: '另一分支' });
    const progress = worlds.flatMap(world => world.sessions.items.map(session => ({ world_id: world.world_id, world_name: world.name,
        session_id: session.session_id, session_name: session.name, status: 'ready', summary_status: 'prepared',
        total_turns: 25, covered_turns: 20, timeline: ['已保存的剧情'], open_threads: ['待解线索'],
        uncovered: { from_user_turn: 21, to_user_turn: 25, count: 5 }, message_count: 51, covered_message_count: 41,
        history_signature: 'sha256-fixture', summary_id: 'summary-fixture' })));
    const directories = { root, chats: path.join(root, 'chats') };
    const profile = { schema_version: 1, revision: 4, preferences: [{ text: '原有已确认口味', status: 'confirmed' }],
        stats: { event_count: 9 }, recent_timeline: [{ change: '旧学习事件，必须保留' }], shared_story_memory: progress.slice(0, 3) };
    const eras = [{ event_count: 6, summary: '旧阶段档案，必须保留' }];
    fs.writeFileSync(path.join(root, 'story_profile.json'), JSON.stringify(profile));
    fs.writeFileSync(path.join(root, 'profile_eras.json'), JSON.stringify(eras));
    fs.writeFileSync(path.join(root, 'profile_events.jsonl'), '{"id":"legacy-event"}\n');
    const collectProgressFn = async (_directories, listWorlds) => {
        const included = new Set((await listWorlds()).map(world => world.world_id));
        return progress.filter(item => included.has(item.world_id));
    };
    return { root, directories, worlds, progress, profile, eras,
        options: { directories, listWorldsFn: async () => worlds, collectProgressFn },
        cardOptions: { directories, stateDirectory: root, listWorldsFn: async () => worlds, collectProgressFn,
            getCharacterFn: async () => ({ name: '角色' }),
            statistics: { read: async world => ({ turns: 3, words: 5, reflectionTurns: 3, session_id: world.sessions.default_session_id }), prune: async () => {} } } };
}

test('actor card returns every story Session independently of the three-memory projection and retains legacy metrics/history', async t => {
    const f = fixture(t);
    const before = new Map(fs.readdirSync(f.root).map(name => [name, fs.readFileSync(path.join(f.root, name), 'utf8')]));
    const card = await loadStoryProfileCard(f.cardOptions);
    assert.equal(card.story_progress_state, 'ready');
    assert.equal(card.story_progress.length, 6);
    assert.equal(card.story_progress.at(-1).world_id, 'w4');
    assert.deepEqual(card.knows, ['原有已确认口味']);
    assert.equal(card.intimacy.log, 9);
    assert.equal(card.intimacy.score, 15 + 8 * 9);
    assert.deepEqual(card.timeline, [...f.profile.recent_timeline].reverse());
    assert.deepEqual(card.eras, [...f.eras].reverse());
    assert.deepEqual(new Map(fs.readdirSync(f.root).map(name => [name, fs.readFileSync(path.join(f.root, name), 'utf8')])), before);
});

test('exact world/session progress selection returns identity and source coverage without loading or repairing preferences', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'story_profile.json'), '{corrupt but irrelevant to story progress');
    const result = await loadStoryProfileStoryProgress({ ...f.options, worldId: 'w0', sessionId: 's0-alternate' });
    assert.equal(result.length, 1);
    assert.equal(result[0].summary_status, 'prepared');
    assert.equal(result[0].session_id, 's0-alternate');
    assert.equal(result[0].history_signature, 'sha256-fixture');
    assert.equal(result[0].covered_message_count, 41);
    await assert.rejects(loadStoryProfileStoryProgress({ ...f.options, worldId: 'missing' }), { code: 'WORLD_NOT_FOUND' });
    await assert.rejects(loadStoryProfileStoryProgress({ ...f.options, worldId: 'w1', sessionId: 's0-alternate' }), { code: 'STORY_SESSION_NOT_FOUND' });
    assert.equal(fs.readFileSync(path.join(f.root, 'story_profile.json'), 'utf8'), '{corrupt but irrelevant to story progress');
});

test('global progress read failure remains explicit while known preferences and learning counts remain available', async t => {
    const f = fixture(t);
    const failed = async () => { throw Object.assign(new Error('fixture progress read failure'), { code: 'NORA_LEDGER_STORAGE_CONFLICT' }); };
    await assert.rejects(loadStoryProfileStoryProgress({ ...f.options, collectProgressFn: failed }), { code: 'NORA_LEDGER_STORAGE_CONFLICT' });
    const card = await loadStoryProfileCard({ ...f.cardOptions, collectProgressFn: failed });
    assert.equal(card.story_progress, null);
    assert.equal(card.story_progress_state, 'error');
    assert.deepEqual(card.story_progress_error, { code: 'NORA_LEDGER_STORAGE_CONFLICT' });
    assert.deepEqual(card.knows, ['原有已确认口味']);
    assert.equal(card.intimacy.log, 9);
    assert.deepEqual(card.timeline, [...f.profile.recent_timeline].reverse());
});

test('an existing unorganized Session is a successful read, distinct from an unknown scope or failed reader', async t => {
    const f = fixture(t);
    const result = await loadStoryProfileStoryProgress({ ...f.options, worldId: 'w2', sessionId: 's2',
        collectProgressFn: async () => [{ world_id: 'w2', session_id: 's2', status: 'unorganized', covered_turns: 0, total_turns: 12 }] });
    assert.equal(result[0].status, 'unorganized');
    assert.equal(result[0].total_turns, 12);
    await assert.rejects(loadStoryProfileStoryProgress({ ...f.options, collectProgressFn: async () => null }), { code: 'STORY_PROGRESS_UNAVAILABLE' });
});
