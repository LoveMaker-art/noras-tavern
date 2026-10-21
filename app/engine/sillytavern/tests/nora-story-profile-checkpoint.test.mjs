import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPreferenceCheckpointCoordinator as createStoryProfileCheckpointCoordinator } from '../../../../story-profile/adapters/nora/preference-checkpoint.js';

function story(userTurns) {
    return Array.from({ length: userTurns }, (_, index) => ([
        { role: 'user', text: `用户 ${index + 1}` }, { role: 'char', text: `角色 ${index + 1}` },
    ])).flat();
}
function stateDirectory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-checkpoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function completed(turns, written = false) {
    return { ok: true, status: 'completed', stage: 'complete', extraction_complete: true, summary_status: 'current', written,
        processed: { from_user_turn: 1, to_user_turn: turns } };
}
const optedIn = () => ({ auto_enabled: true });

test('opted-in automatic reflection runs once at each persisted 15-user-turn checkpoint', async t => {
    let turns = 14, release;
    const calls = [];
    const coordinator = createStoryProfileCheckpointCoordinator({ stateDirectory: stateDirectory(t), loadSettings: optedIn,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: turns }),
        loadContext: async worldId => ({ world_id: worldId, world_name: '雾都', story: story(turns), card: { name: '侦探' } }),
        runReflection: context => { calls.push(context); return new Promise(resolve => { release = resolve; }); },
    });
    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    turns = 15;
    assert.equal((await coordinator.checkpoint('mist')).scheduled, true);
    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    assert.equal(calls.length, 1);
    release(completed(15, true)); await coordinator.waitForIdle('mist');
    assert.equal(coordinator.status('mist').reflected_at_turns, 15);
    turns = 29;
    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    turns = 30;
    assert.equal((await coordinator.checkpoint('mist')).scheduled, true);
    release(completed(30)); await coordinator.waitForIdle('mist');
    assert.equal(calls.length, 2);
    assert.equal(coordinator.status('mist').reflected_at_turns, 30);
});

test('failed reflection preserves cursor; explicit retry recovers without automatic replay of unknown outcome', async t => {
    let attempts = 0;
    const coordinator = createStoryProfileCheckpointCoordinator({ stateDirectory: stateDirectory(t), loadSettings: optedIn,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, story: story(15) }),
        runReflection: async () => { if (++attempts === 1) throw new Error('model unavailable'); return completed(15, true); },
    });
    await coordinator.checkpoint('mist'); await coordinator.waitForIdle('mist');
    assert.equal(coordinator.status('mist').reflected_at_turns, 0);
    assert.match(coordinator.status('mist').last_error, /model unavailable/);
    assert.equal((await coordinator.checkpoint('mist')).scheduled, false);
    await coordinator.reflect('mist', { retry: true });
    assert.equal(attempts, 2);
    assert.equal(coordinator.status('mist').reflected_at_turns, 15);
    assert.equal(coordinator.status('mist').last_error, '');
});

test('reflection cursor survives process restart', async t => {
    let turns = 15, calls = 0;
    const options = { stateDirectory: stateDirectory(t), loadSettings: optedIn,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: turns }),
        loadContext: async worldId => ({ world_id: worldId, story: story(turns) }),
        runReflection: async () => { calls++; return completed(turns); },
    };
    const first = createStoryProfileCheckpointCoordinator(options);
    await first.checkpoint('mist'); await first.waitForIdle('mist');
    const restarted = createStoryProfileCheckpointCoordinator(options);
    assert.equal((await restarted.checkpoint('mist')).scheduled, false);
    turns = 30;
    assert.equal((await restarted.checkpoint('mist')).scheduled, true);
    await restarted.waitForIdle('mist');
    assert.equal(calls, 2);
});

test('not-due checks never load full context; 15/16/30 and duplicate requests retain scheduling rules', async t => {
    let turns = 14, contexts = 0, calls = 0, release;
    const options = { stateDirectory: stateDirectory(t), loadSettings: optedIn,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: turns, session_id: 's', revision: `r${turns}` }),
        loadContext: async worldId => { contexts++; return { world_id: worldId, session_id: 's', revision: `r${turns}`, story: story(turns) }; },
        runReflection: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    };
    const coordinator = createStoryProfileCheckpointCoordinator(options);
    await coordinator.checkpoint('one'); assert.equal(contexts, 0);
    turns = 15;
    const results = await Promise.all(Array.from({ length: 10 }, () => coordinator.checkpoint('one')));
    assert.equal(results.filter(result => result.scheduled).length, 1);
    assert.equal(calls, 1); assert.equal(contexts, 1);
    release(completed(15)); await coordinator.waitForIdle('one');
    turns = 16;
    assert.equal((await coordinator.checkpoint('one')).reason, 'not_due'); assert.equal(contexts, 1);
    const restarted = createStoryProfileCheckpointCoordinator(options);
    assert.equal((await restarted.checkpoint('one')).scheduled, false);
    turns = 30;
    assert.equal((await restarted.checkpoint('one')).scheduled, true);
    release(completed(30)); await restarted.waitForIdle('one');
    assert.equal(calls, 2);
});

test('changed default Session or revision between eligibility and context cannot dispatch stale job', async t => {
    let matches = false, calls = 0;
    const coordinator = createStoryProfileCheckpointCoordinator({ stateDirectory: stateDirectory(t), loadSettings: optedIn,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15, session_id: 's', revision: 'r1' }),
        loadContext: async worldId => ({ world_id: worldId, session_id: 's', revision: matches ? 'r1' : 'r2', story: story(15) }),
        runReflection: async () => { calls++; return completed(15); },
    });
    assert.equal((await coordinator.checkpoint('one')).reason, 'history_changed');
    assert.equal(calls, 0); assert.equal(coordinator.status('one').reflected_at_turns, 0);
    matches = true;
    assert.equal((await coordinator.checkpoint('one')).scheduled, true);
    await coordinator.waitForIdle('one'); assert.equal(calls, 1);
});

test('synchronously throwing runner releases queue and permits explicit subsequent retry', async t => {
    let calls = 0;
    const coordinator = createStoryProfileCheckpointCoordinator({ stateDirectory: stateDirectory(t), loadSettings: optedIn,
        loadProgress: async worldId => ({ world_id: worldId, user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, story: story(15) }),
        runReflection: () => { calls++; throw new Error('fixture failure'); },
    });
    await coordinator.checkpoint('one'); await coordinator.waitForIdle('one');
    await coordinator.reflect('one', { retry: true });
    assert.equal(coordinator.status('one').running, false);
    assert.equal(coordinator.status('one').reflected_at_turns, 0);
    assert.equal(calls, 2);
});
