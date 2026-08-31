import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(import.meta.dirname, '../../../..');
const builder = 'app/engine/sillytavern/build/sync-story-profile-runtime.mjs';

test('one exported checkout builds and validates Story Profile without a sibling repo or Git metadata', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-profile-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(repository, 'story-profile'), path.join(root, 'story-profile'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, builder)), { recursive: true });
    fs.copyFileSync(path.join(repository, builder), path.join(root, builder));
    const env = { ...process.env };
    delete env.NORA_STORY_PROFILE_SOURCE;
    const run = (...args) => spawnSync(process.execPath, [path.join(root, builder), ...args], { encoding: 'utf8', env });
    const synced = run();
    assert.equal(synced.status, 0, synced.stderr);
    const manifestPath = path.join(root, 'app/story_profile_runtime/manifest.json');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    assert.equal(manifest, fs.readFileSync(path.join(repository, 'app/story_profile_runtime/manifest.json'), 'utf8'));
    assert.equal(run('--check-source').status, 0);
    assert.match(run().stdout, /changed=0/);
    fs.appendFileSync(path.join(root, 'story-profile/core/reflection.py'), '\n# changed source\n');
    assert.notEqual(run('--check-source').status, 0, 'stale source must be rejected');
    assert.equal(run().status, 0);
    assert.notEqual(JSON.parse(fs.readFileSync(manifestPath)).sourceRevision, JSON.parse(manifest).sourceRevision);
    assert.equal(run('--check-source').status, 0);
    assert.equal(run('--check').status, 0);
});

test('the canonical in-repository adapter resolves Tavern without environment path overrides', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-profile-adapter-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, TAVERN_PERSONALITY_FILE: path.join(root, 'SOUL.md'), PYTHONDONTWRITEBYTECODE: '1' };
    delete env.TAVERN_APP_DIR;
    fs.writeFileSync(env.TAVERN_PERSONALITY_FILE, 'fixture personality\n');
    const result = spawnSync('python3', [path.join(repository, 'story-profile/adapters/nora/cli.py'), 'personality-read'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).content, 'fixture personality\n');
});
