import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrateState } from '../updater/migrate-state.mjs';
import { createLegacyState } from './fixtures/node-v1.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function setup(t) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-migration-test-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const state = path.join(temp, 'prepared/state');
    const fixture = await createLegacyState(state, repository);
    return { ...fixture, state, app: path.join(repository, 'app') };
}

test('v1 migration preserves 30 rounds, reasoning, swipes, MVU values and original Profile files', async t => {
    const f = await setup(t);
    const before = (await fs.readFile(f.chat, 'utf8')).split('\n').slice(1);
    const profiles = await Promise.all(['story_profile.json', 'profile_eras.json', 'profile_events.jsonl'].map(file => fs.readFile(path.join(f.state, file))));
    const report = await migrateState(f.state, f.app);
    assert.deepEqual(report.users[0].migrated, [f.registry.id]);
    assert.equal(report.modelsCalled, 0);
    const lines = (await fs.readFile(f.chat, 'utf8')).split('\n');
    assert.deepEqual(lines.slice(1), before);
    const header = JSON.parse(lines[0]);
    assert.ok(header.chat_metadata.nora_session.id);
    assert.equal(header.chat_metadata.variables.stat_data.time, 30);
    const after = await Promise.all(['story_profile.json', 'profile_eras.json', 'profile_events.jsonl'].map(file => fs.readFile(path.join(f.state, file))));
    assert.deepEqual(after, profiles);
    const again = await migrateState(f.state, f.app);
    assert.deepEqual(again.users[0].migrated, []);
    assert.equal(again.users[0].after, 1);
});

test('new v2 session identities are not re-derived from old v1 rules', async t => {
    const f = await setup(t);
    await migrateState(f.state, f.app);
    const directory = path.join(f.root, 'nora-world-core/worlds');
    const [name] = await fs.readdir(directory);
    const world = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    world.source.type = 'import';
    world.sessions.items[0].session_id = 'session:new-core-identity';
    world.sessions.default_session_id = 'session:new-core-identity';
    await fs.writeFile(path.join(directory, name), JSON.stringify(world));
    const lines = (await fs.readFile(f.chat, 'utf8')).split('\n');
    const header = JSON.parse(lines[0]);
    header.chat_metadata.nora_session.id = world.sessions.default_session_id;
    lines[0] = JSON.stringify(header);
    await fs.writeFile(f.chat, lines.join('\n'));
    const result = await migrateState(f.state, f.app);
    assert.equal(result.users[0].after, 1);
    assert.deepEqual(result.users[0].migrated, []);
});

test('missing linked card blocks migration instead of committing a broken World', async t => {
    const f = await setup(t);
    await fs.unlink(path.join(f.root, 'characters/legacy.png'));
    await assert.rejects(migrateState(f.state, f.app), /requires repair/);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'nora-world-core/worlds')), []);
});

test('corrupt v2 manifests are rejected before WorldStore quarantine', async t => {
    const f = await setup(t);
    const directory = path.join(f.root, 'nora-world-core/worlds');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'corrupt.json'), '{broken');
    await assert.rejects(migrateState(f.state, f.app));
    assert.equal(await fs.readFile(path.join(directory, 'corrupt.json'), 'utf8'), '{broken');
});

test('unknown Profile schemas block instead of being silently reinitialized on first use', async t => {
    const f = await setup(t);
    const file = path.join(f.state, 'story_profile.json');
    await fs.writeFile(file, '{"schema_version":999}');
    await assert.rejects(migrateState(f.state, f.app), /Unsupported Story Profile/);
    assert.equal(await fs.readFile(file, 'utf8'), '{"schema_version":999}');
});
