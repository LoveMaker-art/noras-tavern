import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { documentFileName } from '../src/nora-world-core/atomic-json.js';
import { materializationFromWorld, normalizeMaterialization, validateWorldManifest } from '../src/nora-world-core/domain.js';
import { WorldStore } from '../src/nora-world-core/store.js';
import { collectStoryProgress } from '../src/nora-story-ledger/profile-projection.js';
import { ledgerStatePath } from '../src/nora-story-ledger/state-file.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-session-name-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const coreRoot = path.join(root, 'nora-world-core');
    const directories = { root, chats: path.join(root, 'chats') };
    const materializer = { materialize: async (command, identities) => ({
        runtimeCard: { engine: 'sillytavern', binding: { avatar: `${identities.worldId.replace(':', '-')}.png` }, ownership: 'owned' },
        defaultSession: { engine: 'sillytavern', binding: { chat_id: `${identities.sessionId.replaceAll(':', '-')}-chat` }, openingState: 'empty',
            ...(Object.hasOwn(command.payload, 'test_session_name') ? { name: command.payload.test_session_name } : {}) },
        knowledge: [], declaredCapabilities: [],
    }) };
    const core = () => createNoraWorldCore({ root: coreRoot, materializer });
    const create = async (name, sessionName) => (await core().createWorld({ name, persona: { name: '测试者', description: '原有配置' },
        payload: sessionName === undefined ? {} : { test_session_name: sessionName } }, { idempotencyKey: name })).world;
    const worldPath = world => path.join(coreRoot, 'worlds', documentFileName(world.world_id));
    function writeStory(world, session) {
        const scope = { worldId: world.world_id, sessionId: session.session_id };
        const messages = Array.from({ length: 32 }, (_, index) => ({ is_user: index % 2 === 0, mes: `原有故事 ${index}` }));
        const header = { chat_metadata: { nora_world: { id: world.world_id }, nora_session: { id: session.session_id } } };
        const chatPath = path.join(directories.chats, world.runtime_card.binding.avatar.replace(/\.png$/i, ''), `${session.binding.chat_id}.jsonl`);
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.writeFileSync(chatPath, [header, ...messages].map(value => JSON.stringify(value)).join('\n'));
        const statePath = ledgerStatePath(root, scope); fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ enabled: false, active: null, pending: {
            id: `summary-${session.session_id}`, coveredTurns: 15, messageCount: 30, createdAt: 2000,
            signature: crypto.createHash('sha256').update(prefixText(messages, 30)).digest('hex'),
            ledger: { timeline: [`${world.name}已有剧情`], facts: [], open_threads: ['原有线索'], objects: [], secrets: [],
                scene: { time: '', place: '原有场景', participants: [] }, style_notes: [] },
        } }));
    }
    return { root, coreRoot, core, create, worldPath, directories, writeStory };
}

function snapshot(root) {
    const files = {};
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(target);
            else files[path.relative(root, target)] = [fs.statSync(target).mtimeMs, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')];
        }
    }
    visit(root); return files;
}

test('authored default Session name survives creation, durable manifest, restart read and the yearbook source', async t => {
    const f = fixture(t), world = await f.create('海边故事', '  港口重逢  ');
    const session = world.sessions.items[0];
    assert.equal(session.name, '港口重逢');
    assert.equal(JSON.parse(fs.readFileSync(f.worldPath(world))).sessions.items[0].name, '港口重逢');
    const restored = materializationFromWorld(world);
    assert.equal(restored.defaultSession.name, '港口重逢');
    assert.equal(normalizeMaterialization(restored).defaultSession.name, '港口重逢');
    f.writeStory(world, session);
    const before = snapshot(f.root), reopened = f.core();
    const read = (await reopened.inspectWorlds())[0];
    assert.equal(read.sessions.items[0].name, '港口重逢');
    const progress = await collectStoryProgress(f.directories, () => reopened.inspectWorlds(), () => {});
    assert.equal(progress[0].session_id, session.session_id); assert.equal(progress[0].session_name, '港口重逢');
    assert.equal(progress[0].summary_status, 'prepared'); assert.equal(progress[0].enabled, false);
    assert.deepEqual(snapshot(f.root), before, 'reading a stored name must not repair or rewrite any source');
});

test('legacy unnamed Sessions stay readable and are not backfilled with their opaque identity', async t => {
    const f = fixture(t), world = await f.create('旧无名故事');
    f.writeStory(world, world.sessions.items[0]);
    const before = snapshot(f.root), reopened = f.core();
    const read = (await reopened.inspectWorlds())[0];
    assert.equal(Object.hasOwn(read.sessions.items[0], 'name'), false);
    assert.equal(Object.hasOwn(materializationFromWorld(read).defaultSession, 'name'), false);
    const progress = await collectStoryProgress(f.directories, () => reopened.inspectWorlds(), () => {});
    assert.equal(progress[0].session_name, ''); assert.notEqual(progress[0].session_name, progress[0].session_id);
    assert.deepEqual(snapshot(f.root), before);
});

test('existing World update names exactly one branch, survives restart and preserves other stories and bindings', async t => {
    const f = fixture(t), first = await f.create('第一故事'), other = await f.create('其他故事', '其他分支');
    const store = new WorldStore({ root: f.coreRoot });
    const withBranch = await store.update(first.world_id, current => ({ ...current, sessions: { ...current.sessions,
        items: [...current.sessions.items, { ...current.sessions.items[0], session_id: 'session:alternate', name: '旧分支名', binding: { chat_id: 'alternate-chat' } }] } }));
    const main = withBranch.sessions.items[0], alternate = withBranch.sessions.items[1];
    f.writeStory(withBranch, main); f.writeStory(withBranch, alternate); f.writeStory(other, other.sessions.items[0]);
    const beforeOther = fs.readFileSync(f.worldPath(other), 'utf8');
    const beforeFiles = snapshot(f.root), core = f.core();
    const renamed = await core.updateWorld(first.world_id, { session: { session_id: alternate.session_id, name: '  接受邀请的分支  ' } }, { expectedRevision: withBranch.revision });
    assert.equal(renamed.sessions.items[1].name, '接受邀请的分支');
    assert.deepEqual(renamed.sessions.items[0], main);
    assert.deepEqual(renamed.sessions.items[1].binding, alternate.binding);
    assert.equal(renamed.sessions.default_session_id, withBranch.sessions.default_session_id);
    assert.deepEqual(renamed.persona, withBranch.persona); assert.deepEqual(renamed.runtime_card, withBranch.runtime_card);
    assert.equal(fs.readFileSync(f.worldPath(other), 'utf8'), beforeOther);
    const afterFiles = snapshot(f.root);
    for (const [file, value] of Object.entries(beforeFiles)) {
        if (file !== path.relative(f.root, f.worldPath(first))) assert.deepEqual(afterFiles[file], value, file);
    }
    const reopened = f.core(), progress = await collectStoryProgress(f.directories, () => reopened.inspectWorlds(), () => {});
    assert.equal(progress.find(item => item.world_id === first.world_id && item.session_id === alternate.session_id).session_name, '接受邀请的分支');
    assert.equal(progress.find(item => item.world_id === other.world_id).session_name, '其他分支');
    const cleared = await reopened.updateWorld(first.world_id, { session: { session_id: alternate.session_id, name: '   ' } }, { expectedRevision: renamed.revision });
    assert.equal(Object.hasOwn(cleared.sessions.items[1], 'name'), false);
    assert.equal(cleared.sessions.items[1].session_id, alternate.session_id);
});

test('branch names reject stale revisions, foreign/unknown Session ids and malformed metadata without changing files', async t => {
    const f = fixture(t), world = await f.create('严格归属故事'), foreign = await f.create('别的世界');
    const core = f.core(), sessionId = world.sessions.items[0].session_id;
    const before = snapshot(f.root);
    for (const session of [
        { session_id: foreign.sessions.items[0].session_id, name: '不能跨故事重命名' },
        { session_id: 'session:missing', name: '不存在的分支' },
        { session_id: sessionId, name: 123 }, { session_id: sessionId, name: 'x'.repeat(501) },
        { session_id: sessionId, name: '合法名', binding: { chat_id: '不能改绑定' } },
        { session_id: sessionId }, { name: '缺少身份' },
    ]) await assert.rejects(core.updateWorld(world.world_id, { session }, { expectedRevision: world.revision }), { code: 'NORA_WORLD_INVALID' });
    await assert.rejects(core.updateWorld(world.world_id, { session: { session_id: sessionId, name: '过期修订' } }, { expectedRevision: world.revision - 1 }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    assert.deepEqual(snapshot(f.root), before);
});

test('manifest normalization validates optional name text without changing Session identity or inventing a default', async t => {
    const f = fixture(t), world = await f.create('字段验证故事');
    for (const name of [123, {}, 'x'.repeat(501)]) {
        const invalid = structuredClone(world); invalid.sessions.items[0].name = name;
        assert.throws(() => validateWorldManifest(invalid), { code: 'NORA_WORLD_INVALID' });
    }
    const named = structuredClone(world); named.sessions.items[0].name = '  真正的分支名  ';
    const normalized = validateWorldManifest(named);
    assert.equal(normalized.sessions.items[0].name, '真正的分支名');
    assert.equal(normalized.sessions.items[0].session_id, world.sessions.items[0].session_id);
});
