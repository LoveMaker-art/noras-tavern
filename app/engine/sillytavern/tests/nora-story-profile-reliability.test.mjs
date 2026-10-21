import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { createPreferenceCheckpointCoordinator, readPreferenceSettings, writePreferenceSettings, PREFERENCE_CONSENT_VERSION, reflectionJobId } from '../../../../story-profile/adapters/nora/preference-checkpoint.js';
import { readActiveNoraTextModel } from '../../../../story-profile/adapters/nora/model-config.js';
import { resolveStoryProfileProxy } from '../src/nora-story-profile-adapter.js';
import { readStoryProfileState } from '../src/nora-story-profile.js';

function fixture(t, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-profile-reliability-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = { turns: 15, session: 'first', calls: [] };
    const options = {
        stateDirectory: root,
        loadProgress: async worldId => ({ world_id: worldId, session_id: state.session, revision: `r${state.turns}`, user_turns: state.turns }),
        loadContext: async worldId => ({ world_id: worldId, session_id: state.session, revision: `r${state.turns}`, story: Array.from({ length: state.turns }, (_, i) => ({ id: String(i), role: 'user', text: `用户${i}` })) }),
        runReflection: async context => { state.calls.push(context); return { ok: true, status: 'completed', extraction_complete: true, processed: { session_id: context.session_id, from_user_turn: 1, to_user_turn: state.turns }, summary_status: 'current' }; },
        ...overrides,
    };
    return { root, state, options, coordinator: createPreferenceCheckpointCoordinator(options) };
}
function enable(root) { writePreferenceSettings(root, { auto_enabled: true, consent_version: PREFERENCE_CONSENT_VERSION }); }

test('automatic reflection defaults on without creating a choice; eligibility and reads remain model-free', async t => {
    const { root, state, coordinator } = fixture(t);
    assert.equal(readPreferenceSettings(root).auto_enabled, true);
    assert.equal(readPreferenceSettings(root).choice_recorded, false);
    assert.equal(fs.existsSync(path.join(root, 'story_profile_preference_settings.json')), false);
    coordinator.status('world');
    state.turns = 14;
    assert.equal((await coordinator.checkpoint('world')).scheduled, false);
    assert.equal(state.calls.length, 0);
    state.turns = 15;
    assert.equal((await coordinator.checkpoint('world')).scheduled, true);
    await coordinator.waitForIdle('world');
    assert.equal((await coordinator.checkpoint('world')).scheduled, false);
    assert.equal(state.calls.length, 1);
    assert.equal(fs.existsSync(path.join(root, 'story_profile_preference_settings.json')), false);
});

test('explicit off survives restart; manual reflection does not enable automatic reflection', async t => {
    const { root, state, options } = fixture(t);
    writePreferenceSettings(root, { auto_enabled: false });
    const coordinator = createPreferenceCheckpointCoordinator(options);
    state.turns = 30;
    assert.equal((await coordinator.checkpoint('world')).reason, 'auto_disabled');
    assert.equal(state.calls.length, 0);
    await coordinator.reflect('world');
    assert.equal(readPreferenceSettings(root).auto_enabled, false);
    state.turns = 45;
    assert.equal((await createPreferenceCheckpointCoordinator(options).checkpoint('world')).reason, 'auto_disabled');
    assert.equal(state.calls.length, 1);
    enable(root);
    assert.equal(readPreferenceSettings(root).auto_enabled, true);
});

test('existing boolean choices survive missing or older notice versions without being rewritten', t => {
    const { root } = fixture(t);
    const file = path.join(root, 'story_profile_preference_settings.json');
    for (const auto_enabled of [false, true]) {
        for (const consent_version of [undefined, 'story-profile-auto/legacy', PREFERENCE_CONSENT_VERSION]) {
            const content = JSON.stringify({ auto_enabled, consent_version });
            fs.writeFileSync(file, content);
            assert.equal(readPreferenceSettings(root).auto_enabled, auto_enabled);
            assert.equal(readPreferenceSettings(root).choice_recorded, true);
            assert.equal(fs.readFileSync(file, 'utf8'), content);
        }
    }
});

test('unreadable settings are preserved and cannot silently use the enabled default', t => {
    const { root } = fixture(t);
    const file = path.join(root, 'story_profile_preference_settings.json');
    for (const content of ['{broken', '{"auto_enabled":"false"}', '{}', 'null', '[]', 'false']) {
        fs.writeFileSync(file, content);
        assert.throws(() => readPreferenceSettings(root), error => error.code === 'STORY_PROFILE_SETTINGS_UNREADABLE');
        assert.throws(() => writePreferenceSettings(root, { auto_enabled: true, consent_version: PREFERENCE_CONSENT_VERSION }), error => error.code === 'STORY_PROFILE_SETTINGS_UNREADABLE');
        assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
});

test('session change does not reuse prior 300-turn cursor and switch back preserves its progress', async t => {
    const { root, state, coordinator, options } = fixture(t);
    enable(root); state.turns = 300;
    await coordinator.checkpoint('world'); await coordinator.waitForIdle('world');
    state.session = 'second'; state.turns = 15;
    const restarted = createPreferenceCheckpointCoordinator(options);
    assert.equal((await restarted.checkpoint('world')).scheduled, true);
    await restarted.waitForIdle('world');
    assert.equal(state.calls.at(-1).after_user_turns, 0);
    state.session = 'first'; state.turns = 300;
    assert.equal((await restarted.checkpoint('world')).scheduled, false);
});

test('partial success advances only actual processed range and preserves summary recovery identity', async t => {
    const { root, coordinator, options, state } = fixture(t, { runReflection: async () => ({ ok: false, status: 'partial', extraction_complete: true, job_id: 'saved-job', processed: { from_user_turn: 1, to_user_turn: 9 }, summary_status: 'failed', code: 'SUMMARY_FAILED', error: '总结未完成' }) });
    enable(root);
    await coordinator.checkpoint('world'); await coordinator.waitForIdle('world');
    assert.equal(coordinator.status('world').reflected_at_turns, 9);
    assert.equal(coordinator.status('world').summary_status, 'failed');
    assert.equal((await coordinator.checkpoint('world')).scheduled, false);
    const restarted = createPreferenceCheckpointCoordinator(options);
    assert.equal(restarted.status('world').job_id, 'saved-job');
    assert.equal(state.calls.length, 0);
});

test('provider policy failure is visible and is not automatically replayed', async t => {
    let calls = 0;
    const { root, coordinator } = fixture(t, { runReflection: async () => { calls++; return { ok: false, status: 'failed', extraction_complete: false, code: 'MODEL_CONTENT_POLICY', retryable: false, error: '渠道拒绝' }; } });
    enable(root);
    await coordinator.checkpoint('world'); await coordinator.waitForIdle('world');
    assert.equal((await coordinator.checkpoint('world')).reason, 'manual_retry_required');
    assert.equal(coordinator.status('world').reflected_at_turns, 0);
    assert.equal(coordinator.status('world').last_code, 'MODEL_CONTENT_POLICY');
    assert.equal(calls, 1);
});

test('manual and automatic calls use one execution queue across worlds', async t => {
    let active = 0, peak = 0, release;
    const { root, coordinator } = fixture(t, { runReflection: async context => { active++; peak = Math.max(peak, active); if (context.world_id === 'automatic') await new Promise(resolve => { release = resolve; }); active--; return { ok: true, extraction_complete: true, processed: { to_user_turn: 15 }, summary_status: 'current' }; } });
    enable(root);
    await coordinator.checkpoint('automatic');
    const manual = coordinator.reflect('manual');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(peak, 1);
    release();
    await coordinator.waitForIdle('automatic'); await manual;
    assert.equal(peak, 1);
});

test('corrupt checkpoint and profile cannot silently become fresh zero records', t => {
    const { root } = fixture(t);
    fs.writeFileSync(path.join(root, 'story_profile.json'), '{broken');
    assert.throws(() => readStoryProfileState(root), error => error.code === 'STORY_PROFILE_STORAGE_UNREADABLE');
    fs.writeFileSync(path.join(root, 'story_profile_preference_checkpoints.json'), '{broken');
    assert.throws(() => fixture(t, { stateDirectory: root }), error => error.code === 'STORY_PROFILE_CHECKPOINT_UNREADABLE');
    assert.equal(fs.readFileSync(path.join(root, 'story_profile.json'), 'utf8'), '{broken');
});

test('saved custom transport options and model budgets reach the reflection process without exposing them in status', () => {
    const config = readActiveNoraTextModel({ root: '/test' }, { parseYaml, readSettings: () => ({ settings: { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_url: 'https://example.invalid/v1', custom_model: 'test', openai_max_tokens: 4000, openai_max_context: 32000, custom_include_headers: 'X-Provider: required', custom_include_body: 'top_p: 0.8', custom_exclude_body: '- frequency_penalty' } } }), readApiKey: () => 'private-test-key' });
    assert.equal(config.max_tokens, 4000);
    assert.equal(config.context_tokens, 32000);
    assert.equal(config.headers['X-Provider'], 'required');
    assert.equal(config.body_parameters.top_p, 0.8);
    assert.deepEqual(config.exclude_body, ['frequency_penalty']);
});

test('saved model temperature reaches reflection, including zero, instead of a hidden task default', () => {
    for (const temperature of [0, 1]) {
        const config = readActiveNoraTextModel({ root: '/test' }, {
            readSettings: () => ({ settings: { main_api: 'openai', oai_settings: {
                chat_completion_source: 'custom', custom_url: 'https://example.invalid/v1', custom_model: 'test',
                temp_openai: temperature,
            } } }), readApiKey: () => 'private-fixture-key',
        });
        assert.equal(config.temperature, temperature);
    }
});

test('concurrent manual submits and automatic admission join one actual model job', async t => {
    let calls = 0, release;
    const { root, coordinator } = fixture(t, { runReflection: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { ok: true, status: 'completed', extraction_complete: true, processed: { to_user_turn: 15 }, summary_status: 'current' }; } });
    enable(root);
    const submits = Array.from({ length: 20 }, () => coordinator.reflect('world'));
    const automatic = await coordinator.checkpoint('world');
    assert.equal(automatic.scheduled, false);
    assert.equal(calls, 1);
    release(); await Promise.all(submits);
    assert.equal(calls, 1);
});

test('interrupted persisted job is unknown and never silently replayed after restart', async t => {
    const { root, state, options } = fixture(t);
    enable(root);
    fs.writeFileSync(path.join(root, 'story_profile_preference_checkpoints.json'), JSON.stringify({ schema: 'nora-story-profile-preference-checkpoints/v2', worlds: { world: { session_id: 'first', status: 'running', reflected_at_turns: 0 } }, sessions: {}, operation: { status: 'running' } }));
    const restarted = createPreferenceCheckpointCoordinator(options);
    assert.equal(restarted.status('world').status, 'unknown');
    assert.equal((await restarted.checkpoint('world')).reason, 'previous_outcome_unknown');
    assert.equal(state.calls.length, 0);
});

test('pending canonical commit is reported without reading journal contents or pretending zero', t => {
    const { root } = fixture(t);
    const journal = '{private pending canonical documents}';
    fs.writeFileSync(path.join(root, 'profile_commit.json'), journal);
    assert.throws(() => readStoryProfileState(root), error => error.code === 'STORY_PROFILE_COMMIT_PENDING');
    assert.equal(fs.readFileSync(path.join(root, 'profile_commit.json'), 'utf8'), journal);
});

test('summary recovery clears saved partial summary state but cannot clear unconfirmed extraction', async t => {
    const { root, coordinator } = fixture(t, { runReflection: async context => ({ ok: false, status: 'partial', stage: 'summary', extraction_complete: context.world_id === 'saved', summary_status: 'failed', processed: { to_user_turn: 15 }, review_required: true, candidate_ids: ['candidate'], error: 'summary failed' }) });
    enable(root);
    await coordinator.reflect('saved'); await coordinator.reflect('unconfirmed');
    assert.equal(coordinator.status('saved').review_required, true);
    coordinator.summaryRecovered();
    assert.equal(coordinator.status('saved').status, 'completed');
    assert.equal(coordinator.status('unconfirmed').status, 'partial');
});

test('read-only status for a newly selected session does not display the old 300-turn coverage', async t => {
    const { root, state, coordinator } = fixture(t);
    enable(root); state.turns = 300;
    await coordinator.reflect('world');
    const value = coordinator.status('world', { session_id: 'new-session', revision: 'new', user_turns: 15 });
    assert.equal(value.session_id, 'new-session');
    assert.equal(value.reflected_at_turns, 0);
    assert.equal(state.calls.length, 1);
    assert.equal(coordinator.status('world').reflected_at_turns, 300);
});

test('aggregate status preserves session identity and coverage for every world', async t => {
    const { coordinator } = fixture(t);
    await coordinator.reflect('one'); await coordinator.reflect('two');
    const worlds = coordinator.statuses().worlds;
    assert.equal(worlds.length, 2);
    assert.deepEqual(worlds.map(world => world.session_id), ['first', 'first']);
    assert.deepEqual(worlds.map(world => world.reflected_at_turns), [15, 15]);
});

function durableJob(root, context, stage, extra = {}) {
    const jobId = reflectionJobId(context);
    const folder = path.join(root, 'story_profile_jobs');
    fs.mkdirSync(folder, { recursive: true });
    const processed = { world_id: context.world_id, session_id: context.session_id, revision: context.revision, from_user_turn: 1, to_user_turn: 15, skipped_before: 0 };
    const value = { schema: 'story-profile-reflection-job/1', world_id: context.world_id, job_id: jobId, stage, processed, ...extra };
    const file = path.join(folder, jobId + '.json');
    fs.writeFileSync(file, JSON.stringify(value));
    return { jobId, file, value };
}

test('Node and Python use the same compact Unicode source identity', () => {
    const id = reflectionJobId({ world_id: '雾都', session_id: 's', revision: 'r', story: [{ id: 'm1', role: 'user', text: '偏好🌙' }] });
    assert.equal(id, 'reflect_89606ea865355e60cf16d724f1097df0');
});

test('timeout after saved preferences reconciles durable phase and resumes summary after chat changes', async t => {
    let root, saved, calls = 0;
    const f = fixture(t, { runReflection: async context => {
        calls++;
        if (calls === 1) {
            saved = durableJob(root, context, 'requesting_summary', { texts: ['慢热'], extraction_complete: true,
                result: { ok: true, extraction_complete: true, processed: { world_id: context.world_id, session_id: context.session_id, revision: context.revision, from_user_turn: 1, to_user_turn: 15, skipped_before: 0 } } });
            throw new Error('Story Profile adapter deadline exceeded.');
        }
        assert.equal(context.resume_job_id, saved.jobId);
        assert.equal(context.revision, 'r16');
        const result = { ok: true, status: 'completed', stage: 'complete', extraction_complete: true, job_id: saved.jobId,
            processed: saved.value.processed, summary_status: 'current' };
        fs.writeFileSync(saved.file, JSON.stringify({ ...saved.value, stage: 'completed', result }));
        return result;
    } });
    root = f.root;
    await f.coordinator.reflect('world');
    const checkpointFile = path.join(root, 'story_profile_preference_checkpoints.json');
    const beforeRead = fs.readFileSync(checkpointFile, 'utf8');
    const read = f.coordinator.status('world');
    assert.equal(read.status, 'partial'); assert.equal(read.extraction_complete, true);
    assert.equal(read.reflected_at_turns, 15); assert.equal(read.resume_available, true);
    assert.equal(fs.readFileSync(checkpointFile, 'utf8'), beforeRead);
    f.state.turns = 16;
    const restarted = createPreferenceCheckpointCoordinator(f.options);
    await restarted.reflect('world', { retry: true });
    assert.equal(calls, 2);
    assert.equal(restarted.status('world').status, 'completed');
    assert.equal(restarted.status('world').reflected_at_turns, 15);
});

test('durably extracted but uncommitted output resumes original save without advancing coverage', async t => {
    let root, saved, calls = 0;
    const f = fixture(t, { runReflection: async context => {
        calls++;
        if (calls === 1) { saved = durableJob(root, context, 'extracted', { texts: ['慢热'] }); throw new Error('deadline'); }
        assert.equal(context.resume_job_id, saved.jobId);
        return { ok: false, status: 'failed', stage: 'save', extraction_complete: false, job_id: saved.jobId, error: 'retained fixture output', summary_status: 'not_started' };
    } });
    root = f.root;
    await f.coordinator.reflect('world');
    assert.equal(f.coordinator.status('world').stage, 'save');
    assert.equal(f.coordinator.status('world').extraction_complete, false);
    assert.equal(f.coordinator.status('world').reflected_at_turns, 0);
    f.state.turns = 16;
    await f.coordinator.reflect('world', { retry: true });
    assert.equal(calls, 2);
});

test('unknown extraction with changed source gets new explicit job identity and preserves old record', async t => {
    let root, old, calls = 0;
    const f = fixture(t, { runReflection: async context => {
        calls++;
        if (calls === 1) { old = durableJob(root, context, 'requesting_extract'); throw new Error('deadline'); }
        assert.equal(context.resume_job_id, '');
        assert.notEqual(reflectionJobId(context), old.jobId);
        assert.equal(context.retry, true);
        return { ok: false, status: 'failed', extraction_complete: false, error: 'fixture stops before paid call' };
    } });
    root = f.root;
    await f.coordinator.reflect('world');
    const oldBytes = fs.readFileSync(old.file, 'utf8');
    f.state.turns = 16;
    await f.coordinator.reflect('world', { retry: true });
    assert.equal(fs.readFileSync(old.file, 'utf8'), oldBytes);
    assert.equal(calls, 2);
});

test('successful independent summary recovery remains current across stale job metadata and restart', async t => {
    let root;
    const f = fixture(t, { runReflection: async context => {
        durableJob(root, context, 'summary_failed', { texts: ['慢热'], extraction_complete: true, result: { ok: false, status: 'partial', stage: 'summary', extraction_complete: true, error: 'old failure' } });
        throw new Error('deadline');
    } });
    root = f.root;
    await f.coordinator.reflect('world');
    assert.equal(f.coordinator.status('world').status, 'partial');
    f.coordinator.summaryRecovered();
    assert.equal(f.coordinator.status('world').status, 'completed');
    const restarted = createPreferenceCheckpointCoordinator(f.options);
    assert.equal(restarted.status('world').status, 'completed');
});

test('durable completed result resolves adapter timeout instead of invisibly blocking future automatic work', async t => {
    let root, calls = 0;
    const f = fixture(t, { runReflection: async context => {
        calls++;
        if (calls === 1) {
            durableJob(root, context, 'completed', { texts: ['慢热'], extraction_complete: true,
                result: { ok: true, status: 'completed', extraction_complete: true, summary_status: 'current' } });
            throw new Error('deadline after durable completion');
        }
        assert.equal(context.after_user_turns, 15);
        assert.equal(context.resume_job_id, '');
        return { ok: true, status: 'completed', extraction_complete: true, processed: { to_user_turn: 30 }, summary_status: 'current' };
    } });
    root = f.root; enable(root);
    await f.coordinator.checkpoint('world'); await f.coordinator.waitForIdle('world');
    assert.equal(f.coordinator.status('world').status, 'completed');
    f.state.turns = 30;
    assert.equal((await f.coordinator.checkpoint('world')).scheduled, true);
    await f.coordinator.waitForIdle('world');
    assert.equal(calls, 2);
});

test('reflection receives an explicit direct route instead of consulting OS proxy settings', () => {
    const options = { readSettings: () => ({ settings: { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_url: 'https://model.invalid/v1', custom_model: 'test' } } }), readApiKey: () => '' };
    assert.equal(readActiveNoraTextModel({ root: '/test' }, options).proxy_url, '');
});

test('reflection selects the exact per-target Tavern proxy and keeps credentials out of checkpoint metadata', async t => {
    const proxy = 'http://fixture-user:fixture-proxy-password@proxy.invalid:8080';
    const targets = [];
    const model = readActiveNoraTextModel({ root: '/test' }, {
        readSettings: () => ({ settings: { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_url: 'https://model.invalid/v1/', custom_model: 'test' } } }),
        readApiKey: () => '', resolveProxy: target => { targets.push(target); return proxy; },
    });
    assert.equal(model.proxy_url, proxy);
    assert.deepEqual(targets, ['https://model.invalid/v1/chat/completions']);
    const { root, coordinator } = fixture(t, { runReflection: async () => { assert.equal(model.proxy_url, proxy); return { ok: true, status: 'completed', extraction_complete: true, processed: { from_user_turn: 1, to_user_turn: 15 }, summary_status: 'current' }; } });
    await coordinator.reflect('world');
    assert.equal(JSON.stringify(coordinator.statuses()).includes('fixture-proxy-password'), false);
    assert.equal(fs.readFileSync(path.join(root, 'story_profile_preference_checkpoints.json'), 'utf8').includes('fixture-proxy-password'), false);
});

test('network route follows the actual protocol agent including target bypass and disabled proxy', () => {
    const seen = [];
    const configured = { getProxyForUrl(target) { seen.push(target); return new URL(target).hostname === 'bypass.invalid' ? '' : 'http://proxy.invalid:7897'; } };
    assert.equal(resolveStoryProfileProxy('https://model.invalid/v1/chat/completions', { httpsAgent: {} }), '');
    assert.equal(resolveStoryProfileProxy('https://model.invalid/v1/chat/completions', { httpsAgent: configured }), 'http://proxy.invalid:7897');
    assert.equal(resolveStoryProfileProxy('https://bypass.invalid/v1/chat/completions', { httpsAgent: configured }), '');
    assert.equal(resolveStoryProfileProxy('http://model.invalid/v1/chat/completions', { httpAgent: configured }), 'http://proxy.invalid:7897');
    assert.equal(seen.length, 3);
});

test('an unresolvable network route fails before dispatch without echoing proxy credentials', () => {
    const options = { readSettings: () => ({ settings: { main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_url: 'https://model.invalid/v1', custom_model: 'test' } } }), readApiKey: () => '', resolveProxy: () => { throw new Error('http://private-user:private-password@proxy.invalid'); } };
    assert.throws(() => readActiveNoraTextModel({ root: '/test' }, options), error => error.code === 'NORA_MODEL_NETWORK_POLICY_INVALID' && !error.message.includes('private-password'));
});

test('manual completed source reuses its job; edited same-count source gets a bounded recent review', async t => {
    let root, revision = 'original', originalJob, extractions = 0;
    const contexts = [];
    const f = fixture(t, {
        loadProgress: async worldId => ({ world_id: worldId, session_id: 'first', revision, user_turns: 15 }),
        loadContext: async worldId => ({ world_id: worldId, session_id: 'first', revision,
            story: Array.from({ length: 15 }, (_, i) => ({ id: String(i), role: 'user', text: `${revision}用户${i}` })) }),
        runReflection: async context => {
            contexts.push(context);
            if (context.resume_job_id) {
                assert.equal(context.resume_job_id, originalJob.jobId);
                return originalJob.value.result;
            }
            extractions++;
            const processed = { world_id: context.world_id, session_id: context.session_id, revision: context.revision, from_user_turn: 1, to_user_turn: 15, skipped_before: 0 };
            const result = { ok: true, status: 'completed', stage: 'complete', extraction_complete: true, processed, summary_status: 'current' };
            const stored = durableJob(root, context, 'completed', { texts: ['慢热'], extraction_complete: true, result });
            originalJob ||= stored;
            return result;
        },
    });
    root = f.root;
    await f.coordinator.reflect('world');
    await f.coordinator.reflect('world');
    assert.equal(extractions, 1);
    assert.equal(contexts[1].resume_job_id, originalJob.jobId);
    revision = 'edited-same-count';
    enable(root);
    assert.equal((await f.coordinator.checkpoint('world')).reason, 'not_due');
    await f.coordinator.reflect('world');
    assert.equal(extractions, 2);
    assert.equal(contexts[2].after_user_turns, 0);
    assert.equal(contexts[2].resume_job_id, '');
    assert.equal(f.coordinator.status('world').processed.revision, revision);
});
