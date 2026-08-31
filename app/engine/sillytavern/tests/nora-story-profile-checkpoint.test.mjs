import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPreferenceCheckpointCoordinator as createStoryProfileCheckpointCoordinator } from '../../../story_profile_runtime/adapters/nora/preference-checkpoint.js';

function story(userTurns) {
    return Array.from({ length: userTurns }, (_, index) => ([
        { role: 'user', text: `用户 ${index + 1}` },
        { role: 'char', text: `角色 ${index + 1}` },
    ])).flat();
}

test('automatic reflection runs once at each persisted 15-user-turn checkpoint', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-checkpoint-'));
    let turns = 14;
    let release;
    const calls = [];
    const coordinator = createStoryProfileCheckpointCoordinator({
        stateDirectory,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: turns }),
        loadContext: async worldId => ({ world_id: worldId, world_name: '雾都', story: story(turns), card: { name: '侦探' } }),
        runReflection: context => {
            calls.push(context);
            return new Promise(resolve => { release = resolve; });
        },
    });

    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    turns = 15;
    assert.equal((await coordinator.checkpoint('mist')).scheduled, true);
    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    assert.equal(calls.length, 1);
    release({ written: true });
    await coordinator.waitForIdle('mist');
    assert.equal(coordinator.status('mist').reflected_at_turns, 15);

    turns = 29;
    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    turns = 30;
    assert.equal((await coordinator.checkpoint('mist')).scheduled, true);
    release({ written: false });
    await coordinator.waitForIdle('mist');
    assert.equal(calls.length, 2);
    assert.equal(coordinator.status('mist').reflected_at_turns, 30);
});

test('failed reflection preserves the cursor and is retried at the same checkpoint', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-checkpoint-retry-'));
    let attempts = 0;
    const coordinator = createStoryProfileCheckpointCoordinator({
        stateDirectory,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, world_name: '雾都', story: story(15), card: { name: '侦探' } }),
        runReflection: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('model unavailable');
            return { written: true };
        },
    });

    assert.equal((await coordinator.checkpoint('mist')).scheduled, true);
    await coordinator.waitForIdle('mist');
    assert.equal(coordinator.status('mist').reflected_at_turns, 0);
    assert.match(coordinator.status('mist').last_error, /model unavailable/);

    assert.equal((await coordinator.checkpoint('mist')).scheduled, true);
    await coordinator.waitForIdle('mist');
    assert.equal(attempts, 2);
    assert.equal(coordinator.status('mist').reflected_at_turns, 15);
    assert.equal(coordinator.status('mist').last_error, '');
});

test('reflection cursor survives a process restart', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-checkpoint-restart-'));
    let turns = 15;
    let calls = 0;
    const options = {
        stateDirectory,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: turns }),
        loadContext: async worldId => ({ world_id: worldId, world_name: '雾都', story: story(turns), card: { name: '侦探' } }),
        runReflection: async () => { calls += 1; return { written: false }; },
    };
    const first = createStoryProfileCheckpointCoordinator(options);
    await first.checkpoint('mist');
    await first.waitForIdle('mist');

    const restarted = createStoryProfileCheckpointCoordinator(options);
    assert.equal((await restarted.checkpoint('mist')).scheduled, false);
    turns = 30;
    assert.equal((await restarted.checkpoint('mist')).scheduled, true);
    await restarted.waitForIdle('mist');
    assert.equal(calls, 2);
});

test('not-due checks never load full context; 15/16/30 and duplicate requests retain scheduling rules', async t => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-checkpoint-progress-'));
    t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
    let turns = 14;
    let contexts = 0;
    let calls = 0;
    let release;
    const options = { stateDirectory,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: turns, session_id: 's', revision: `r${turns}` }),
        loadContext: async worldId => {
            contexts += 1;
            return { world_id: worldId, session_id: 's', revision: `r${turns}`, story: story(turns) };
        },
        runReflection: () => { calls += 1; return new Promise(resolve => { release = resolve; }); },
    };
    const coordinator = createStoryProfileCheckpointCoordinator(options);
    await coordinator.checkpoint('one');
    assert.equal(contexts, 0);
    turns = 15;
    const results = await Promise.all(Array.from({ length: 10 }, () => coordinator.checkpoint('one')));
    assert.equal(results.filter(result => result.scheduled).length, 1);
    assert.equal(calls, 1);
    assert.equal(contexts, 1);
    release();
    await coordinator.waitForIdle('one');
    turns = 16;
    assert.equal((await coordinator.checkpoint('one')).reason, 'not_due');
    assert.equal(contexts, 1);
    const restarted = createStoryProfileCheckpointCoordinator(options);
    assert.equal((await restarted.checkpoint('one')).scheduled, false);
    turns = 30;
    assert.equal((await restarted.checkpoint('one')).scheduled, true);
    release();
    await restarted.waitForIdle('one');
    assert.equal(calls, 2);
});

test('a changed default Session or revision between eligibility and context cannot dispatch a stale job', async t => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-checkpoint-stale-'));
    t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
    let matches = false;
    let calls = 0;
    const coordinator = createStoryProfileCheckpointCoordinator({ stateDirectory,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15, session_id: 's', revision: 'r1' }),
        loadContext: async worldId => ({ world_id: worldId, session_id: 's', revision: matches ? 'r1' : 'r2', story: story(15) }),
        runReflection: async () => { calls += 1; },
    });
    assert.equal((await coordinator.checkpoint('one')).reason, 'history_changed');
    assert.equal(calls, 0);
    assert.equal(coordinator.status('one').reflected_at_turns, 0);
    matches = true;
    assert.equal((await coordinator.checkpoint('one')).scheduled, true);
    await coordinator.waitForIdle('one');
    assert.equal(calls, 1);
});

test('synchronously throwing model runner clears the job and permits a subsequent retry', async t => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-checkpoint-sync-error-'));
    t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
    let calls = 0;
    const coordinator = createStoryProfileCheckpointCoordinator({ stateDirectory,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, story: story(15) }),
        runReflection: () => { calls += 1; throw new Error('fixture failure'); },
    });
    for (let index = 0; index < 2; index += 1) {
        await coordinator.checkpoint('one');
        await coordinator.waitForIdle('one');
        assert.equal(coordinator.status('one').running, false);
        assert.equal(coordinator.status('one').reflected_at_turns, 0);
    }
    assert.equal(calls, 2);
});
