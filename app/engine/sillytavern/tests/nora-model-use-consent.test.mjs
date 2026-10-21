import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStoryLedger } from '../src/nora-story-ledger/core.js';
import * as mvu from '../public/scripts/nora-compat/mvu-settings.js';
import { createPreferenceCheckpointCoordinator } from '../../../../story-profile/adapters/nora/preference-checkpoint.js';

const choice = { noticeVersion: 1, enabled: true };
const chat = () => Array.from({ length: 16 }, (_, i) => [
    { is_user: true, mes: `Action ${i}` }, { is_user: false, mes: `Reply ${i}` },
]).flat();
const scope = { worldId: 'world', sessionId: 'session' };
const reflected = context => ({ ok: true, status: 'completed', stage: 'complete', extraction_complete: true, summary_status: 'current',
    processed: { world_id: context.world_id, session_id: context.session_id, revision: context.revision,
        from_user_turn: 1, to_user_turn: context.story.filter(message => message.role === 'user').length } });

test('legacy MVU configuration is preserved but extra requests need a disclosed choice', () => {
    const raw = { 更新方式: '额外模型解析', 额外模型解析配置: { 启用自动请求: true, 模型名称: 'saved-model' } };
    const before = structuredClone(raw);
    assert.equal(mvu.isMvuVariableModelEnabled(mvu.mvuSettingsForExecution(raw)), false);
    assert.deepEqual(raw, before);
    assert.equal(mvu.isMvuVariableModelEnabled(mvu.mvuSettingsForExecution(raw, choice)), true);
    assert.equal(mvu.isMvuVariableModelEnabled(mvu.mvuSettingsForExecution(raw, { ...choice, enabled: false })), false);
});

test('legacy ledger reads and scheduling do not start a model; explicit enable does', async () => {
    let state = { enabled: true, config: { outputTokenLimit: 2048 }, sentinel: 'keep' };
    let calls = 0;
    const messages = chat();
    const plugin = createStoryLedger({
        readChat: () => ({ messages, entities: ['__user__'] }),
        readState: () => structuredClone(state), writeState: (_, next) => { state = next; },
        merge: async () => { calls++; throw new Error('fixture provider unavailable'); },
    });
    const before = structuredClone(state);
    assert.equal((await plugin.inspect(scope)).enabled, false);
    await plugin.status(scope);
    await plugin.schedule(scope, { retry: true });
    assert.equal(calls, 0);
    assert.deepEqual(state, before);
    await plugin.configure(scope, { enabled: true });
    await plugin.waitForIdle(scope);
    assert.equal(calls, 1);
    assert.equal(state.sentinel, 'keep');
    await plugin.configure(scope, { enabled: false });
    await plugin.schedule(scope, { retry: true });
    assert.equal(calls, 1);
    assert.equal(messages.length, 32);
});

test('automatic preference reflection defaults on, preserves cursors and remembers an explicit off across restart', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-consent-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'story_profile_preference_checkpoints.json'), JSON.stringify({
        schema: 'nora-story-profile-preference-checkpoints/v1', worlds: { world: { reflected_at_turns: 15 } },
    }));
    let calls = 0, reflectedContext;
    const options = { stateDirectory: root,
        loadProgress: async worldId => ({ world_id: worldId, session_id: 'session', revision: 'r30', user_turns: 30 }),
        loadContext: async worldId => ({ world_id: worldId, session_id: 'session', revision: 'r30', story: Array.from({ length: 30 }, () => ({ role: 'user', text: 'story' })) }),
        runReflection: async context => { calls++; reflectedContext = context; return reflected(context); },
    };
    const coordinator = createPreferenceCheckpointCoordinator(options);
    assert.deepEqual(coordinator.automaticSettings(), { enabled: true, consentRequired: false });
    assert.equal(fs.existsSync(path.join(root, 'story_profile_preferences.json')), false, 'reading a default must not write a user choice');
    assert.equal(coordinator.status('world').reflected_at_turns, 15);
    assert.equal((await coordinator.checkpoint('world')).scheduled, true);
    await coordinator.waitForIdle('world');
    assert.equal(calls, 1);
    assert.equal(reflectedContext.after_user_turns, 0, 'a legacy cursor without a Session cannot claim coverage for a newly identified Session');
    const restarted = createPreferenceCheckpointCoordinator(options);
    assert.equal(restarted.automaticSettings().enabled, true);
    assert.equal((await restarted.checkpoint('world')).scheduled, false);
    restarted.configureAutomatic(false);
    const disabledRestart = createPreferenceCheckpointCoordinator(options);
    assert.equal(disabledRestart.automaticSettings().enabled, false);
    assert.equal((await disabledRestart.checkpoint('another')).scheduled, false);
    assert.equal(calls, 1);
});

test('preference defaults preserve older boolean choices, unrelated settings and damaged records', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-preference-default-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const preferenceFile = path.join(root, 'story_profile_preferences.json');
    const coordinator = createPreferenceCheckpointCoordinator({ stateDirectory: root,
        loadProgress: async () => { throw new Error('settings read must not schedule'); },
        loadContext: async () => { throw new Error('settings read must not load a story'); },
        runReflection: async () => { throw new Error('settings read must not call a model'); } });
    for (const [value, enabled] of [
        [{ other: 'keep' }, true], [{ automatic_reflection: { enabled: false } }, false],
        [{ automatic_reflection: { enabled: true, noticeVersion: 0 } }, true],
        [{ automatic_reflection: { enabled: false, noticeVersion: 0 } }, false],
    ]) {
        const raw = JSON.stringify(value); fs.writeFileSync(preferenceFile, raw);
        assert.equal(coordinator.automaticSettings().enabled, enabled);
        assert.equal(fs.readFileSync(preferenceFile, 'utf8'), raw);
    }
    // 1.31 preserves unreadable choices as unknown instead of displaying a
    // synthetic disabled choice. Existing records must remain byte-identical.
    for (const raw of ['{broken', JSON.stringify({ automatic_reflection: { enabled: 'true' } }), 'null', '[]']) {
        fs.writeFileSync(preferenceFile, raw);
        assert.throws(() => coordinator.automaticSettings(), error => /UNREADABLE|INVALID/.test(error.code));
        assert.equal(fs.readFileSync(preferenceFile, 'utf8'), raw);
    }
});


test('turning off while preference context is loading prevents dispatch and preserves the cursor', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-consent-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let entered, release, calls = 0;
    const reached = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const coordinator = createPreferenceCheckpointCoordinator({ stateDirectory: root,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15 }),
        loadContext: async worldId => { entered(); await hold; return { world_id: worldId,
            story: Array.from({ length: 15 }, () => ({ role: 'user', text: 'synthetic' })) }; },
        runReflection: async () => { calls++; },
    });
    coordinator.configureAutomatic(true);
    const waiting = coordinator.checkpoint('world'); await reached;
    coordinator.configureAutomatic(false); release();
    // Admission may already have queued the local job; the execution guard
    // must stop the provider dispatch and leave its cursor unchanged.
    await waiting;
    await coordinator.waitForIdle('world');
    assert.equal(coordinator.status('world').status, 'disabled');
    assert.equal(calls, 0); assert.equal(coordinator.status('world').reflected_at_turns, 0);
});
