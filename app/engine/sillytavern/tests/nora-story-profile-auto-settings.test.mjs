import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPreferenceCheckpointCoordinator, readPreferenceSettings, writePreferenceSettings, PREFERENCE_CONSENT_VERSION } from '../../../../story-profile/adapters/nora/preference-checkpoint.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-auto-choice-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDirectory = path.join(root, 'profile'), preferenceFile = path.join(root, 'default-user/story_profile_preferences.json');
    fs.mkdirSync(path.dirname(preferenceFile), { recursive: true });
    const options = { preferenceFile };
    const legacy = value => fs.writeFileSync(preferenceFile, typeof value === 'string' ? value : JSON.stringify(value));
    const read = () => readPreferenceSettings(stateDirectory, options);
    const write = auto_enabled => writePreferenceSettings(stateDirectory, { auto_enabled, consent_version: PREFERENCE_CONSENT_VERSION }, options);
    return { root, stateDirectory, preferenceFile, options, legacy, read, write };
}

test('a main-branch saved off remains off and cannot schedule an automatic checkpoint', async t => {
    const f = fixture(t);
    f.legacy({ automatic_reflection: { noticeVersion: 1, enabled: false }, unrelated: ['retained'] });
    const before = fs.readFileSync(f.preferenceFile);
    let calls = 0;
    const options = { stateDirectory: f.stateDirectory, preferenceFile: f.preferenceFile,
        loadProgress: async worldId => ({ world_id: worldId, session_id: 's', revision: 'r', user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, session_id: 's', revision: 'r', story: Array.from({ length: 15 }, () => ({ role: 'user', text: '继续' })) }),
        runReflection: async () => { calls++; return { ok: true, extraction_complete: true }; } };
    assert.equal(f.read().auto_enabled, false);
    assert.equal(f.read().choice_recorded, true);
    for (let restart = 0; restart < 2; restart++) {
        assert.equal((await createPreferenceCheckpointCoordinator(options).checkpoint('world')).reason, 'auto_disabled');
    }
    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(f.preferenceFile), before);
    assert.equal(fs.existsSync(path.join(f.stateDirectory, 'story_profile_preference_settings.json')), false);
});

test('conflicting choices stay off until an explicit setting resolves the same unchanged legacy source', t => {
    const f = fixture(t);
    f.legacy({ automatic_reflection: { enabled: false } });
    fs.mkdirSync(f.stateDirectory, { recursive: true });
    const currentFile = path.join(f.stateDirectory, 'story_profile_preference_settings.json');
    fs.writeFileSync(currentFile, JSON.stringify({ auto_enabled: true }));
    const original = fs.readFileSync(f.preferenceFile);
    assert.equal(f.read().auto_enabled, false);
    assert.equal(f.write(true).auto_enabled, true);
    assert.equal(f.read().auto_enabled, true);
    assert.deepEqual(fs.readFileSync(f.preferenceFile), original);
    f.legacy({ automatic_reflection: { enabled: false }, changed: true });
    assert.equal(f.read().auto_enabled, false, 'a later legacy change invalidates the previous explicit override');
    const otherFile = path.join(f.root, 'other-user.json');
    fs.writeFileSync(otherFile, original);
    assert.equal(readPreferenceSettings(f.stateDirectory, { preferenceFile: otherFile }).auto_enabled, false,
        'the same bytes at another user root cannot reuse the override');
    f.write(false);
    f.legacy({ automatic_reflection: { enabled: true } });
    assert.equal(f.read().auto_enabled, false);
    f.write(true);
    assert.equal(f.read().auto_enabled, true);
});

test('missing choices default on while valid legacy booleans and unknown records remain distinct', t => {
    const f = fixture(t);
    assert.equal(f.read().auto_enabled, true);
    assert.equal(f.read().choice_recorded, false);
    assert.equal(fs.existsSync(f.stateDirectory), false);
    for (const value of [{}, { unrelated: true }, { automatic_reflection: { enabled: true } }, { automatic_reflection: { enabled: false } }]) {
        f.legacy(value);
        assert.equal(f.read().auto_enabled, value.automatic_reflection?.enabled ?? true);
        assert.equal(f.read().choice_recorded, Object.hasOwn(value, 'automatic_reflection'));
    }
    for (const value of ['{broken', 'null', '[]', 'false', '{}', '{"automatic_reflection":null}', '{"automatic_reflection":[]}', '{"automatic_reflection":{"enabled":"false"}}', '{"automatic_reflection":{}}']) {
        if (value === '{}') continue; // An empty preference document has no choice.
        f.legacy(value);
        assert.throws(f.read, error => error.code === 'STORY_PROFILE_SETTINGS_UNREADABLE');
        assert.equal(fs.readFileSync(f.preferenceFile, 'utf8'), value);
    }
    const corrupt = fs.readFileSync(f.preferenceFile);
    assert.equal(f.write(true).auto_enabled, true, 'an explicit user action may resolve unchanged readable legacy bytes');
    assert.deepEqual(fs.readFileSync(f.preferenceFile), corrupt);
    fs.unlinkSync(f.preferenceFile);
    fs.mkdirSync(f.preferenceFile);
    assert.throws(f.read, error => error.code === 'STORY_PROFILE_SETTINGS_UNREADABLE');
    assert.throws(() => f.write(true), error => error.code === 'STORY_PROFILE_SETTINGS_UNREADABLE');
});

test('automatic execution is identified at the adapter boundary while manual execution is independent', async t => {
    const f = fixture(t), calls = [];
    const coordinator = createPreferenceCheckpointCoordinator({ stateDirectory: f.stateDirectory, preferenceFile: f.preferenceFile,
        loadProgress: async worldId => ({ world_id: worldId, session_id: 's', revision: 'r', user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, session_id: 's', revision: 'r', story: Array.from({ length: 15 }, () => ({ role: 'user', text: '继续' })) }),
        runReflection: async (_context, options) => { calls.push(options); return { ok: true, extraction_complete: true, processed: { to_user_turn: 15 }, summary_status: 'current' }; } });
    await coordinator.checkpoint('automatic'); await coordinator.waitForIdle('automatic');
    f.write(false);
    await coordinator.reflect('manual');
    assert.deepEqual(calls, [{ automatic: true }, { automatic: false }]);
});

test('Node admission and Python request dispatch agree on legacy choices and explicit conflict resolution', t => {
    const python = process.env.NORA_TEST_PYTHON || process.env.TAVERN_PYTHON || 'python3';
    const cli = fileURLToPath(new URL('../../../../story-profile/adapters/nora/cli.py', import.meta.url));
    const program = `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard_cli',sys.argv[1])
cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
cli.STATE_DIR=Path(sys.argv[2])
class Fake:
 config={'model':'offline','max_tokens':4000,'context_tokens':32000}
 def complete(self,messages):return 'dispatched'
cli.reflection.OpenAICompatibleModelClient=lambda _:Fake()
try:
 model=cli._model({'model':{},'automatic_preference_file':sys.argv[3]})
 print(json.dumps({'result':model.complete([])}))
except Exception as error:print(json.dumps({'code':getattr(error,'code','unexpected')}))`;
    const check = (f, expected, label) => {
        let admission;
        try { admission = f.read().auto_enabled ? 'dispatched' : 'STORY_PROFILE_AUTO_REFLECTION_DISABLED'; }
        catch (error) { admission = error.code; }
        assert.equal(admission, expected, label + ' Node');
        const child = spawnSync(python, ['-B', '-c', program, cli, f.stateDirectory, f.preferenceFile], { encoding: 'utf8',
            env: { ...process.env, HERMES_HOME: path.join(f.root, 'isolated-hermes'), PYTHONDONTWRITEBYTECODE: '1' } });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.equal(result.result || result.code, expected, label + ' Python');
    };
    for (const enabled of [false, true]) {
        const f = fixture(t);
        f.legacy('\ufeff' + JSON.stringify({ automatic_reflection: { enabled } }));
        check(f, enabled ? 'dispatched' : 'STORY_PROFILE_AUTO_REFLECTION_DISABLED', 'BOM legacy ' + enabled);
    }
    const f = fixture(t);
    check(f, 'dispatched', 'missing choices');
    f.legacy({}); check(f, 'dispatched', 'missing legacy field');
    f.legacy({ automatic_reflection: { enabled: false } });
    fs.mkdirSync(f.stateDirectory, { recursive: true });
    fs.writeFileSync(path.join(f.stateDirectory, 'story_profile_preference_settings.json'), JSON.stringify({ auto_enabled: true }));
    check(f, 'STORY_PROFILE_AUTO_REFLECTION_DISABLED', 'conflicting explicit off');
    f.write(true); check(f, 'dispatched', 'explicit unchanged legacy override');
    f.legacy({ automatic_reflection: { enabled: false }, changed: true });
    check(f, 'STORY_PROFILE_AUTO_REFLECTION_DISABLED', 'changed legacy invalidates override');
    f.write(false); f.legacy({ automatic_reflection: { enabled: true } });
    check(f, 'STORY_PROFILE_AUTO_REFLECTION_DISABLED', 'new off and legacy on');
    f.legacy('{broken'); check(f, 'STORY_PROFILE_SETTINGS_UNREADABLE', 'corrupt legacy');
    f.write(true); check(f, 'dispatched', 'explicit readable-corrupt legacy override');
    fs.writeFileSync(path.join(f.stateDirectory, 'story_profile_preference_settings.json'), 'null');
    check(f, 'STORY_PROFILE_SETTINGS_UNREADABLE', 'corrupt current');
});
