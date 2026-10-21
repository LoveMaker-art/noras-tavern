import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadStoryProfileStoryRead, loadStoryProfileStoryProgress } from '../src/nora-story-profile.js';
import { createStoryLedgerSnapshotReader } from '../src/nora-story-ledger/read-snapshot.js';
import { createStoryLedger } from '../src/nora-story-ledger/core.js';
import { ledgerStatePath } from '../src/nora-story-ledger/state-file.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-read-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, chats: path.join(root, 'chats') }, worlds = [];
    const observed = [];
    const reader = createStoryLedgerSnapshotReader({ onOpen: file => observed.push(file) });
    function session(worldId = 'world-a', sessionId = 'session-a', { worldName = 'Story', name, turns = 16, prepared = true } = {}) {
        let world = worlds.find(item => item.world_id === worldId);
        if (!world) worlds.push(world = { world_id: worldId, name: worldName, revision: 1, lifecycle: { status: 'READY' },
            persona: { name: 'Player' }, runtime_card: { binding: { avatar: `${worldId}.png` } }, sessions: { items: [] } });
        const scope = { worldId, sessionId }, branch = { session_id: sessionId, ...(name ? { name } : {}), binding: { chat_id: sessionId } };
        world.sessions.items.push(branch);
        const messages = Array.from({ length: turns * 2 }, (_, i) => ({ is_user: i % 2 === 0, name: i % 2 ? 'Story' : 'Player', mes: `Original message ${i}` }));
        const header = { chat_metadata: { nora_world: { id: worldId }, nora_session: { id: sessionId } } };
        const chatPath = path.join(directories.chats, worldId, sessionId + '.jsonl');
        const statePath = ledgerStatePath(root, scope);
        fs.mkdirSync(path.dirname(chatPath), { recursive: true }); fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const ledger = { timeline: ['The player arrived at the library.', 'The player found a map.'],
            facts: [{ id: 'known', content: 'The map marks a locked cellar.', known_by: ['__user__'] },
                { id: 'private', content: 'The keeper secretly removed a key.', known_by: [] }],
            objects: [{ id: 'map', name: 'Map', status: 'folded', holder: '__user__', location: 'pocket' }],
            secrets: [{ id: 'secret', content: 'never expose this hidden truth', known_by: ['__user__'] }],
            open_threads: ['Find the cellar key.'], scene: { time: 'night', place: 'Library', participants: [] }, style_notes: [] };
        const record = { id: `ledger-${sessionId}`, coveredTurns: 15, messageCount: 30, createdAt: 2000,
            signature: crypto.createHash('sha256').update(prefixText(messages, 30)).digest('hex'), ledger };
        const state = { enabled: true, active: prepared ? null : { ...record, activatedAt: 3000 }, pending: prepared ? record : null };
        const writeChat = () => fs.writeFileSync(chatPath, [header, ...messages].map(item => JSON.stringify(item)).join('\n'));
        const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state));
        writeChat(); writeState();
        return { world, branch, header, messages, record, state, scope, chatPath, statePath, writeChat, writeState };
    }
    const read = payload => loadStoryProfileStoryRead({ directories, payload,
        listWorldsFn: async () => structuredClone(worlds), readSnapshotFn: reader.read });
    return { root, directories, worlds, session, read, observed, reader };
}

test('exact names/IDs choose unambiguous World and Session before opening any story file, preserving legacy unnamed branches', async t => {
    const f = fixture(t), a = f.session('world-a', 'a', { name: 'Main' });
    f.session('world-a', 'b', { name: 'Alternate' }); f.session('world-b', 'old', { worldName: 'Other' });
    assert.equal((await f.read({ worldName: 'Story' })).status, 'choose-session');
    assert.equal(f.observed.length, 0);
    const selected = await f.read({ worldName: 'Story', sessionName: 'Main' });
    assert.equal(selected.scope.sessionId, 'a'); assert.equal(selected.status, 'ready');
    assert.equal(f.observed.filter(file => file.endsWith('.jsonl')).length, 1);
    assert.equal(f.observed.find(file => file.endsWith('.jsonl')), a.chatPath);
    a.branch.name = 'Renamed'; a.world.revision++;
    assert.equal((await f.read({ worldId: 'world-a', sessionName: 'Renamed' })).scope.sessionId, 'a');
    const old = await f.read({ worldName: 'Other' });
    assert.equal(old.scope.sessionName, '未命名分支');
    await assert.rejects(f.read({ worldId: 'world-a', worldName: 'Other', sessionId: 'a' }), { code: 'STORY_READ_SCOPE_CONFLICT' });
    await assert.rejects(f.read({ worldId: 'world-a', sessionId: 'a', sessionName: 'Alternate' }), { code: 'STORY_READ_SCOPE_CONFLICT' });
    f.session('world-c', 'c', { worldName: 'Story' });
    const ambiguous = await f.read({ worldName: 'Story' });
    assert.equal(ambiguous.status, 'choose-world'); assert.equal(ambiguous.choices.length, 2);
});

test('section reads use the verified same ledger, do not expose secrets/unknown facts or load raw history by default', async t => {
    const f = fixture(t), item = f.session();
    const before = fs.readFileSync(item.statePath, 'utf8');
    const overview = await f.read({ ...item.scope });
    assert.equal(overview.read_only, true); assert.equal(overview.model_called, false);
    assert.equal(overview.source.summaryId, item.record.id); assert.equal(overview.source.coveredTurns, 15);
    assert.deepEqual(overview.recent_history, []); assert.equal(overview.omitted.recent.reason, 'not-requested');
    assert.deepEqual(Object.keys(overview.ledger).sort(), ['open_threads', 'scene', 'timeline']);
    const facts = await f.read({ ...item.scope, view: 'facts' });
    assert.equal(facts.ledger.facts.length, 1); assert.equal(facts.ledger.facts[0].id, 'known');
    const objects = await f.read({ ...item.scope, view: 'objects', query: 'pocket' });
    assert.equal(objects.ledger.objects[0].id, 'map');
    assert.doesNotMatch(JSON.stringify([overview, facts, objects]), /never expose|keeper secretly|Original message/);
    assert.equal(fs.readFileSync(item.statePath, 'utf8'), before);
    assert.equal(JSON.parse(before).active, null);
});

test('both story readers report canonical effective model consent while retaining configured values and saved progress', async t => {
    for (const [label, choice] of [
        ['legacy without consent', { enabled: true }],
        ['explicit off', { enabled: false, modelUseConsent: { noticeVersion: 1, enabled: false } }],
        ['explicit on', { enabled: true, modelUseConsent: { noticeVersion: 1, enabled: true } }],
    ]) {
        const f = fixture(t), item = f.session();
        Object.assign(item.state, choice); item.writeState();
        const canonical = createStoryLedger({
            readChat: () => ({ messages: item.messages, metadata: item.header.chat_metadata, entities: ['__user__'] }),
            readState: () => JSON.parse(fs.readFileSync(item.statePath, 'utf8')),
            writeState: () => assert.fail('a read must not change the ledger'),
            merge: () => assert.fail('a read must not call a model'),
        });
        const inspect = await canonical.inspect(item.scope), before = fs.readFileSync(item.statePath);
        const snapshot = await f.reader.read(f.directories, item.world, item.branch);
        const progress = (await loadStoryProfileStoryProgress({ directories: f.directories, worlds: f.worlds }))[0];
        const read = await f.read(item.scope);
        for (const [name, value] of [['snapshot', snapshot], ['progress', progress]]) {
            assert.equal(value.enabled, inspect.enabled, label + ' ' + name);
            assert.equal(value.configuredEnabled, inspect.configuredEnabled, label + ' configured ' + name);
            assert.equal(value.consentRequired, inspect.consentRequired, label + ' consent ' + name);
            assert.equal(value.status, 'ready', 'saved verified progress stays readable regardless of automatic consent');
            assert.deepEqual(value.timeline, item.record.ledger.timeline);
        }
        assert.equal(read.status, 'ready');
        assert.equal(read.source.autoEnabled, inspect.enabled);
        assert.equal(read.source.configuredEnabled, inspect.configuredEnabled);
        assert.equal(read.source.consentRequired, inspect.consentRequired);
        assert.equal(read.model_called, false); assert.equal(read.read_only, true);
        assert.deepEqual(fs.readFileSync(item.statePath), before);

        item.state.pending = null; item.state.active = null; item.writeState();
        const emptyBefore = fs.readFileSync(item.statePath), empty = await f.read(item.scope);
        assert.equal(empty.status, inspect.enabled ? 'unorganized' : 'disabled');
        assert.equal(empty.source.autoEnabled, inspect.enabled);
        assert.deepEqual(fs.readFileSync(item.statePath), emptyBefore);
    }
});

test('whole JSON budget, complete-item pagination and cursors are bound to scope, view and source', async t => {
    const f = fixture(t), a = f.session(), b = f.session('world-b', 'b', { worldName: 'B' });
    a.record.ledger.facts = Array.from({ length: 16 }, (_, i) => ({ id: `f${i}`, content: `${i} ${'中'.repeat(160)}`, known_by: ['__user__'] })); a.writeState();
    const result = await f.read({ ...a.scope, view: 'facts', maxChars: 1600 });
    assert.ok(JSON.stringify(result).length <= 1600); assert.ok(result.nextCursor);
    assert.ok(result.ledger.facts.every(item => item.content.length >= 160));
    const next = await f.read({ cursor: result.nextCursor, maxChars: 1600 });
    assert.ok(next.ledger.facts.length); assert.notEqual(next.ledger.facts[0].id, result.ledger.facts[0].id);
    await assert.rejects(f.read({ ...b.scope, view: 'facts', cursor: result.nextCursor }), { code: 'STORY_READ_CURSOR_CONFLICT' });
    await assert.rejects(f.read({ ...a.scope, view: 'objects', cursor: result.nextCursor }), { code: 'STORY_READ_CURSOR_CONFLICT' });
    a.messages.push({ is_user: true, mes: 'changed current source' }); a.writeChat();
    const stale = await f.read({ cursor: result.nextCursor });
    assert.equal(stale.status, 'stale'); assert.deepEqual(stale.ledger, {}); assert.equal(stale.nextCursor, null);
});

test('explicit recent fallback is bounded, skips no long sentence silently, and source changes invalidate cache', async t => {
    const f = fixture(t), a = f.session();
    fs.unlinkSync(a.statePath);
    a.messages.at(-1).mes = '超长原文'.repeat(2000); a.writeChat();
    const result = await f.read({ ...a.scope, includeRecent: true, recentLimit: 2, maxChars: 1400 });
    assert.equal(result.status, 'disabled'); assert.ok(JSON.stringify(result).length <= 1400);
    assert.equal(result.source.autoEnabled, false); assert.equal(result.source.configuredEnabled, true);
    assert.equal(result.source.consentRequired, true, 'missing consent pauses automatic work without rewriting the configured default');
    assert.ok(result.omitted.recent.oversized >= 1); assert.ok(result.omitted.recent.unread > 0);
    assert.ok(result.recent_history.every(item => item.text.length < 1400));
    const seen = f.observed.filter(file => file === a.chatPath).length;
    await f.read({ ...a.scope, includeRecent: true, recentLimit: 2 });
    assert.equal(f.observed.filter(file => file === a.chatPath).length, seen, 'warm validation reuses exact source snapshot');
    a.messages.at(-1).mes = 'new complete reply'; a.writeChat();
    const changed = await f.read({ ...a.scope, includeRecent: true, recentLimit: 1 });
    assert.equal(changed.recent_history.at(-1).text, 'new complete reply');
});

test('raw fallback reports actual turn counters and exact per-page omitted message ranges across empty gaps', async t => {
    const f = fixture(t), a = f.session();
    fs.unlinkSync(a.statePath);
    a.messages[29].mes = ''; a.writeChat();
    const reply = await f.read({ ...a.scope, includeRecent: true, recentLimit: 10, maxChars: 6000 });
    assert.equal(reply.source.messageCount, 32); assert.equal(reply.source.totalTurns, 16);
    assert.deepEqual(reply.recent_history.map(item => item.messageId), [21, 22, 23, 24, 25, 26, 27, 28, 30, 31]);
    assert.deepEqual(reply.recent_history.map(item => item.userTurn), [11, 12, 12, 13, 13, 14, 14, 15, 16, 16]);
    assert.equal(reply.omitted.recent.unread, 22); assert.equal(reply.omitted.recent.messageIdBase, 0);
    assert.equal(reply.omitted.recent.rangesInclusive, true);
    assert.deepEqual(reply.omitted.recent.notReturnedMessageIdRanges, [[0, 20], [29, 29]]);
    assert.ok(JSON.stringify(reply).length <= 6000);
    const defaultRead = await f.read(a.scope);
    assert.equal('notReturnedMessageIdRanges' in defaultRead.omitted.recent, false, 'ledger-only reads do not gain raw-history range metadata');
    a.messages.splice(0, a.messages.length, { is_user: false, mes: 'Opening before the player speaks' }); a.writeChat();
    const opening = await f.read({ ...a.scope, includeRecent: true });
    assert.equal(opening.recent_history[0].userTurn, 0); assert.equal(opening.source.totalTurns, 0);
    assert.deepEqual(opening.omitted.recent.notReturnedMessageIdRanges, []);
});

test('TOCTOU mutation returns stale instead of combining an old ledger with new source', async t => {
    const f = fixture(t), a = f.session();
    let changed = false;
    const reader = createStoryLedgerSnapshotReader({ onOpen: async file => {
        if (!changed && file === a.chatPath) { changed = true; await fsp.appendFile(file, '\n' + JSON.stringify({ is_user: true, mes: 'concurrent write' })); }
    } });
    const result = await loadStoryProfileStoryRead({ directories: f.directories, payload: a.scope,
        listWorldsFn: async () => f.worlds, readSnapshotFn: reader.read });
    assert.equal(result.status, 'stale'); assert.deepEqual(result.ledger, {});
});

test('disabled auto mode retains readable saved summaries, and a change during final metadata validation remains stale', async t => {
    const f = fixture(t), a = f.session();
    a.state.enabled = false; a.writeState();
    const ready = await f.read(a.scope);
    assert.equal(ready.status, 'ready'); assert.equal(ready.source.autoEnabled, false);
    assert.deepEqual(ready.ledger.timeline, [...a.record.ledger.timeline].reverse());
    let metadataReads = 0;
    const result = await loadStoryProfileStoryRead({ directories: f.directories, payload: a.scope, readSnapshotFn: f.reader.read,
        listWorldsFn: async () => {
            metadataReads++;
            if (metadataReads === 2) { a.messages.push({ is_user: true, mes: 'Concurrent final append' }); a.writeChat(); }
            return structuredClone(f.worlds);
        } });
    assert.equal(result.status, 'stale'); assert.deepEqual(result.ledger, {});
});

test('ledger-only edits, restore receipts and foreign headers invalidate the scope cache without falling back to another branch', async t => {
    const f = fixture(t), a = f.session();
    const first = await f.read({ ...a.scope, view: 'objects' });
    a.record.ledger.objects[0].status = 'now unfolded'; a.writeState();
    const changed = await f.read({ ...a.scope, view: 'objects' });
    assert.equal(changed.ledger.objects[0].status, 'now unfolded'); assert.notEqual(changed.source.revision, first.source.revision);
    a.header.chat_metadata.nora_restore = { id: 'new-restore' }; a.writeChat();
    const restored = await f.read(a.scope);
    assert.equal(restored.status, 'stale'); assert.deepEqual(restored.ledger, {});
    a.state.restoreId = 'new-restore'; a.writeState();
    assert.equal((await f.read(a.scope)).status, 'ready');
    a.header.chat_metadata.nora_session.id = 'foreign'; a.writeChat();
    const foreign = await f.read({ ...a.scope, includeRecent: true });
    assert.equal(foreign.status, 'unavailable'); assert.deepEqual(foreign.ledger, {}); assert.deepEqual(foreign.recent_history, []);
});

test('oversized identity and invalid options stay bounded without truncating complete names or opening alternate sources', async t => {
    const f = fixture(t), a = f.session('w', 's', { worldName: '长名称'.repeat(2000) });
    const result = await f.read({ ...a.scope, maxChars: 1000 });
    assert.ok(JSON.stringify(result).length <= 1000);
    assert.ok(!result.scope?.worldName || result.scope.worldName === a.world.name);
    for (const payload of [null, { ...a.scope, maxChars: 999 }, { ...a.scope, recentLimit: 11 }, { ...a.scope, query: 'x'.repeat(129) }]) {
        await assert.rejects(f.read(payload), { code: 'STORY_READ_OPTIONS_INVALID' });
    }
});

test('cursor-only continuation retains explicit recent permission and returns every complete matched item only once', async t => {
    const f = fixture(t), a = f.session();
    a.record.ledger.facts = Array.from({ length: 16 }, (_, i) => ({ id: `f${i}`, content: `${i}: ${'完整事实'.repeat(35)}`, known_by: ['__user__'] })); a.writeState();
    let page = await f.read({ ...a.scope, view: 'facts', includeRecent: true, recentLimit: 2, maxChars: 1300 });
    const facts = [], raw = [];
    for (let pages = 0; ; pages++) {
        assert.ok(pages < 24, 'source-bound pagination terminates without draining anything automatically');
        assert.ok(JSON.stringify(page).length <= 1300);
        const ids = new Set(page.recent_history.map(item => item.messageId));
        const ranges = page.omitted.recent.notReturnedMessageIdRanges;
        assert.ok(ranges.length <= page.recent_history.length + 1);
        assert.equal(ranges.reduce((count, [start, end]) => count + end - start + 1, 0), 32 - ids.size);
        assert.deepEqual(ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i)),
            Array.from({ length: 32 }, (_, i) => i).filter(id => !ids.has(id)));
        facts.push(...(page.ledger.facts || [])); raw.push(...page.recent_history);
        if (!page.nextCursor) break;
        await assert.rejects(f.read({ cursor: page.nextCursor, includeRecent: false }), { code: 'STORY_READ_CURSOR_CONFLICT' });
        page = await f.read({ cursor: page.nextCursor, maxChars: 1300 });
    }
    assert.deepEqual(facts, a.record.ledger.facts); assert.deepEqual(raw.map(item => item.messageId), [30, 31]);
    facts[0].content = 'must not poison the cached source';
    assert.notEqual((await f.read({ ...a.scope, view: 'facts' })).ledger.facts[0].content, facts[0].content);
});

test('deleting a target between revision check and open returns stale without an unhandled read-stream error', async t => {
    const f = fixture(t), a = f.session();
    const reader = createStoryLedgerSnapshotReader({ onOpen: file => { if (file === a.chatPath) fs.unlinkSync(file); } });
    const result = await loadStoryProfileStoryRead({ directories: f.directories, payload: a.scope,
        listWorldsFn: async () => f.worlds, readSnapshotFn: reader.read });
    assert.equal(result.status, 'stale'); assert.deepEqual(result.recent_history, []); assert.deepEqual(result.ledger, {});
});

test('legacy progress filters Session before calling the collector rather than reading sibling chats first', async t => {
    const f = fixture(t); f.session('w', 'one'); f.session('w', 'two');
    await loadStoryProfileStoryProgress({ directories: f.directories, worldId: 'w', sessionId: 'two', worlds: f.worlds,
        collectProgressFn: async (_directories, list) => {
            assert.deepEqual((await list())[0].sessions.items.map(item => item.session_id), ['two']); return [];
        } });
});
