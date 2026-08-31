import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStoryStatistics, summarizeStoryChat } from '../src/nora-story-statistics.js';
import { buildStoryProfileCard, loadStoryProfileCard, loadStoryProfileProgress, loadStoryProfileReflectionContext } from '../src/nora-story-profile.js';
import { createPreferenceCheckpointCoordinator } from '../../../story_profile_runtime/adapters/nora/preference-checkpoint.js';

const story = count => [{ chat_metadata: {} }, { is_user: false, mes: 'opening' }, ...Array.from({ length: count }, () => [
    { is_user: true, mes: '继续' }, { is_user: false, mes: '你好🌏' },
]).flat()];

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-statistics-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = { root, chats: path.join(root, 'chats') };
    const worlds = [];
    const reads = [];
    const events = [];
    const io = { ...fs, readFile: async (file, ...args) => {
        if (String(file).endsWith('.jsonl')) reads.push(file);
        return fs.readFile(file, ...args);
    } };
    async function add(name, messages = story(2)) {
        const folder = path.join(directories.chats, name);
        await fs.mkdir(folder, { recursive: true });
        const file = path.join(folder, 'main.jsonl');
        const world = { world_id: name, name, created_at: '2026-01-01T00:00:00Z',
            runtime_card: { binding: { avatar: `${name}.png` } },
            sessions: { default_session_id: `session:${name}`,
                items: [{ session_id: `session:${name}`, binding: { chat_id: 'main' } }] } };
        worlds.push(world);
        await write(file, messages);
        return { world, file };
    }
    const write = (file, messages) => fs.writeFile(file, messages.map(value => JSON.stringify(value)).join('\n'));
    return { root, directories, worlds, reads, io, events, add, write,
        reader: createStoryStatistics(directories, { io, report: event => events.push(event) }) };
}

test('counters preserve original empty-message, header, opening and Unicode rules', () => {
    const messages = [null, { chat_metadata: {} }, { is_user: false, mes: 'excluded opening' },
        { is_user: true, mes: '' }, { is_user: true, mes: '  ' }, { is_user: true, mes: '选择' },
        { is_user: false, mes: 'a🌏中' }, { is_user: true, mes: 7 }];
    assert.deepEqual(summarizeStoryChat(messages), { turns: 3, words: 3, reflectionTurns: 2 });
    assert.deepEqual(summarizeStoryChat({}), { turns: 0, words: 0, reflectionTurns: 0 });
});

test('unchanged parallel requests and process restart reuse one persisted computation', async t => {
    const f = await fixture(t);
    const { world } = await f.add('one');
    const values = await Promise.all(Array.from({ length: 12 }, () => f.reader.read(world)));
    assert.equal(f.reads.length, 1);
    assert.equal(values[0].turns, 2);
    assert.equal(values[0].words, 6);
    assert.equal('messages' in values[0], false);
    await f.reader.read(world);
    const restarted = createStoryStatistics(f.directories, { io: f.io });
    await restarted.read(world);
    assert.equal(f.reads.length, 1);
    assert.equal(f.events.filter(event => event.event === 'hit').length, 1);
});

test('append, edit/truncate, regenerate and same-size external rewrite affect only their Session', async t => {
    const f = await fixture(t);
    const a = await f.add('one');
    const b = await f.add('two');
    const check = async messages => {
        await f.write(a.file, messages);
        const readsBefore = f.reads.length;
        const stats = await f.reader.read(a.world);
        await f.reader.read(b.world);
        assert.equal(f.reads.length - readsBefore, 1);
        assert.deepEqual({ turns: stats.turns, words: stats.words, reflectionTurns: stats.reflectionTurns }, summarizeStoryChat(messages));
    };
    await f.reader.read(a.world);
    await f.reader.read(b.world);
    await check(story(3));
    await check(story(1));
    await check([...story(1).slice(0, -1), { is_user: false, mes: 'regenerated answer🌏' }]);
    const old = await fs.stat(a.file);
    const previous = await fs.readFile(a.file, 'utf8');
    // Preserve size and mtime: ctime/identity must still invalidate the cache.
    await fs.writeFile(a.file, previous.replace('regenerated', 'replacement'));
    await fs.utimes(a.file, old.atime, old.mtime);
    const readsBefore = f.reads.length;
    await f.reader.read(a.world);
    assert.equal(f.reads.length, readsBefore + 1);
});

test('missing/recreated chat, rebinding and deleted Worlds do not reuse stale statistics or accumulate files', async t => {
    const f = await fixture(t);
    const a = await f.add('one');
    await f.reader.read(a.world);
    await fs.unlink(a.file);
    assert.equal((await f.reader.read(a.world)).turns, 0);
    await f.write(a.file, story(4));
    assert.equal((await f.reader.read(a.world)).turns, 4);
    const alternate = path.join(path.dirname(a.file), 'alternate.jsonl');
    await fs.rename(a.file, alternate);
    const switched = structuredClone(a.world);
    switched.sessions.default_session_id = 'alternate';
    switched.sessions.items = [{ session_id: 'alternate', binding: { chat_id: 'alternate' } }];
    assert.equal((await f.reader.read(switched)).turns, 4);
    assert.equal((await fs.readdir(path.join(f.root, 'nora-story-statistics'))).length, 1);
    await f.reader.prune([]);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'nora-story-statistics')), []);
});

test('corrupt snapshots recover; corrupt source reports an error instead of caching zero', async t => {
    const f = await fixture(t);
    const a = await f.add('one');
    await f.reader.read(a.world);
    const folder = path.join(f.root, 'nora-story-statistics');
    const cached = path.join(folder, (await fs.readdir(folder))[0]);
    await fs.writeFile(cached, '{bad');
    assert.equal((await f.reader.read(a.world)).turns, 2);
    const record = JSON.parse(await fs.readFile(cached, 'utf8'));
    record.stats.turns = 500;
    await fs.writeFile(cached, JSON.stringify(record));
    assert.equal((await f.reader.read(a.world)).turns, 2);
    await fs.writeFile(a.file, '{bad');
    await assert.rejects(f.reader.read(a.world), SyntaxError);
    await f.write(a.file, story(5));
    assert.equal((await f.reader.read(a.world)).turns, 5);
});

test('cache write failure returns fresh stats and reports the persistence failure', async t => {
    const f = await fixture(t);
    const a = await f.add('one');
    const reader = createStoryStatistics(f.directories, { report: event => f.events.push(event),
        io: { ...f.io, writeFile: async () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); } } });
    assert.equal((await reader.read(a.world)).turns, 2);
    assert.ok(f.events.some(event => event.event === 'cache_write_failed'));
});

test('a source replacement during read or snapshot publication never returns stale statistics', async t => {
    const f = await fixture(t);
    const a = await f.add('one');
    let injected = false;
    const reader = createStoryStatistics(f.directories, { io: { ...f.io,
        readFile: async (file, ...args) => {
            const value = await f.io.readFile(file, ...args);
            if (file === a.file && !injected) {
                injected = true;
                await f.write(a.file, story(4));
            }
            return value;
        },
    } });
    assert.equal((await reader.read(a.world)).turns, 4);
    assert.equal(f.reads.length, 2);
    await f.write(a.file, story(5));
    let published = false;
    const next = createStoryStatistics(f.directories, { io: { ...f.io,
        rename: async (...args) => {
            await fs.rename(...args);
            if (!published) { published = true; await f.write(a.file, story(6)); }
        },
    } });
    assert.equal((await next.read(a.world)).turns, 6);
});

test('archive fields equal original projection and live metadata changes do not invalidate unrelated chats', async t => {
    const f = await fixture(t);
    await f.add('one', story(2));
    await f.add('two', story(4));
    const characters = f.worlds.map(world => ({ avatar: `${world.name}.png`, name: world.name, tags: ['奇幻'] }));
    const state = { profile: { revision: 2, preferences: [{ status: 'confirmed', text: 'slow' }], recent_timeline: [{ change: 'old' }] },
        identity: { persona_name: 'test' }, eras: [] };
    await fs.writeFile(path.join(f.root, 'story_profile.json'), JSON.stringify(state.profile));
    await fs.writeFile(path.join(f.root, 'app_identity.json'), JSON.stringify(state.identity));
    const now = () => new Date('2026-02-01T00:00:00Z');
    const options = { directories: f.directories, stateDirectory: f.root, now,
        listWorldsFn: async () => f.worlds, getCharacterFn: async (_directories, avatar) => characters.find(c => c.avatar === avatar),
        statistics: f.reader };
    const expected = buildStoryProfileCard({ worlds: f.worlds, characters, now, ...state,
        chatsByWorld: { one: story(2), two: story(4) } });
    assert.deepEqual(await loadStoryProfileCard(options), expected);
    assert.deepEqual(await loadStoryProfileCard(options), expected);
    assert.equal(f.reads.length, 2);
    state.profile.revision = 3;
    state.profile.preferences[0].text = 'changed';
    await fs.writeFile(path.join(f.root, 'story_profile.json'), JSON.stringify(state.profile));
    characters[0].name = 'renamed';
    const card = await loadStoryProfileCard(options);
    assert.equal(card.profile_revision, 3);
    assert.deepEqual(card.knows, ['changed']);
    assert.ok(card.roles_played.some(role => role.name === 'renamed'));
    assert.equal(f.reads.length, 2);
    assert.equal((await loadStoryProfileCard({ ...options, now: () => new Date('2026-02-02T00:00:00Z') })).career.debut_days, expected.career.debut_days + 1);
    assert.equal(f.reads.length, 2);
});

test('progress and due reflection use the same Session, version and nonempty user-turn rules', async t => {
    const f = await fixture(t);
    const a = await f.add('one', [...story(14), { is_user: true, mes: '  ' }]);
    const options = { directories: f.directories, worldId: 'one', getWorldFn: async () => a.world,
        getCharacterFn: async () => ({ name: 'actor' }) };
    const progress = await loadStoryProfileProgress(options);
    assert.equal(progress.user_turns, 14);
    const context = await loadStoryProfileReflectionContext(options);
    assert.equal(context.revision, progress.revision);
    assert.equal(context.session_id, progress.session_id);
    assert.equal(context.story.filter(message => message.role === 'user').length, 14);
});

test('real chat files drive 14/15/16/30 checkpoint eligibility without a ledger dependency', async t => {
    const f = await fixture(t);
    const a = await f.add('one', story(14));
    let fullReads = 0;
    let modelCalls = 0;
    const options = { directories: f.directories, getWorldFn: async () => a.world, getCharacterFn: async () => ({ name: 'actor' }) };
    const coordinator = createPreferenceCheckpointCoordinator({ stateDirectory: f.root,
        loadProgress: worldId => loadStoryProfileProgress({ ...options, worldId }),
        loadContext: worldId => { fullReads += 1; return loadStoryProfileReflectionContext({ ...options, worldId }); },
        runReflection: async () => { modelCalls += 1; },
    });
    for (const turns of [14, 15, 16, 30]) {
        await f.write(a.file, story(turns));
        const result = await coordinator.checkpoint('one');
        assert.equal(result.user_turns, turns);
        assert.equal(result.scheduled, turns === 15 || turns === 30);
        await coordinator.waitForIdle('one');
    }
    assert.equal(fullReads, 2);
    assert.equal(modelCalls, 2);
    assert.equal(coordinator.status('one').reflected_at_turns, 30);
});

test('source permission failure does not fall back to previous statistics', async t => {
    const f = await fixture(t);
    const a = await f.add('one');
    await f.reader.read(a.world);
    await f.write(a.file, story(5));
    const reader = createStoryStatistics(f.directories, { io: { ...f.io, readFile: async (file, ...args) => {
        if (file === a.file) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
        return f.io.readFile(file, ...args);
    } } });
    await assert.rejects(reader.read(a.world), { code: 'EACCES' });
});
