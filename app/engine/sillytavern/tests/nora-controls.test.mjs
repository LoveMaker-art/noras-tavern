import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlBroker } from '../src/nora-control-broker.js';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { CONTROL_ACTIONS, validateControl } from '../public/scripts/nora-controls/contract.js';
import { createStMvuSettingsAdapter } from '../public/scripts/nora-adapters/st-mvu-settings-adapter.js';
import { initializeHeadlessMvuSettings } from '../../../native-extensions/nora-mvu/runtime.js';
import { createHelperControlAdapter, synchronizeHelperRuntimeReadiness } from '../../../native-extensions/JS-Slash-Runner/nora-control-adapter.js';
import { createInteractionBridge } from '../public/scripts/nora-compat/interaction-bridge.js';
import { createTavernHelperActionAdapter } from '../public/scripts/nora-adapters/tavern-helper-action-adapter.js';
import { createStoryActionDispatcher } from '../../../native-extensions/nora-ui/story-action-dispatcher.js';

const identity = { clientId: 'fixture-client', worldId: 'world-a', sessionId: 'session-a' };
const command = (action, params = {}) => ({ ...identity, action, params, idempotencyKey: action, confirm: true, allowModelCall: true, allowScriptExecution: true });
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-controls-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('late-loaded Tavern Helper observes Nora application readiness', () => {
    const pending = { app_ready: false };
    assert.equal(synchronizeHelperRuntimeReadiness(pending, { documentRef: { documentElement: { dataset: {} } } }), false);
    assert.equal(synchronizeHelperRuntimeReadiness(pending, { documentRef: { documentElement: { dataset: { noraAppReadyMs: '15900' } } } }), true);
    assert.equal(pending.app_ready, true);
});

test('catalog enforces explicit model/script consent and read/write separation', () => {
    assert.throws(() => validateControl({ ...command('mvu.retry'), allowModelCall: false }), { code: 'NORA_MODEL_CALL_NOT_AUTHORIZED' });
    assert.throws(() => validateControl({ ...command('scripts.create', { scope: 'global', name: 'x', content: '', expectedRevision: 'a' }), allowScriptExecution: false }), { code: 'NORA_SCRIPT_NOT_AUTHORIZED' });
    assert.throws(() => validateControl(command('mvu.enabled', { enabled: false }), { readOnly: true }), { code: 'NORA_CONTROL_WRITE_DENIED' });
    assert.throws(() => validateControl(command('eval', { code: 'arbitrary' })), { code: 'NORA_CONTROL_UNSUPPORTED' });
    assert.throws(() => validateControl(command('mvu.status', { extra: true })), { code: 'NORA_CONTROL_INVALID' });
});

test('broker requires live exact target, deduplicates, never redelivers claimed work, survives restart without replay', async t => {
    const root = temporary(t); const broker = createControlBroker(root);
    assert.throws(() => broker.submit(command('mvu.status')), { code: 'NORA_CONTROL_OFFLINE' });
    const auth = { ...identity, ...broker.hello(identity) };
    assert.throws(() => broker.submit({ ...command('mvu.status'), worldId: 'other' }), { code: 'NORA_CONTROL_SCOPE_CHANGED' });
    const created = broker.submit(command('mvu.status'));
    assert.equal(broker.submit(command('mvu.status')).id, created.id);
    assert.throws(() => broker.submit({ ...command('plugins.list'), idempotencyKey: 'mvu.status' }), { code: 'NORA_CONTROL_CONFLICT' });
    const received = await broker.poll(auth, null, 1);
    assert.equal(received.id, created.id);
    assert.equal(await broker.poll(auth, null, 1), null);
    const restarted = createControlBroker(root);
    assert.equal(restarted.inspect(created.id).status, 'unknown');
    assert.equal(restarted.submit(command('mvu.status')).status, 'unknown');
    assert.throws(() => broker.ack({ ...auth, clientId: 'wrong-client', id: created.id, status: 'completed' }), { code: 'NORA_CONTROL_CLIENT_STALE' });
    broker.ack({ ...auth, id: created.id, status: 'completed', result: { runtimeReady: true } });
    assert.equal(broker.inspect(created.id).result.runtimeReady, true);
    assert.equal(broker.ack({ ...auth, id: created.id, status: 'completed' }).status, 'completed');
    const receipt = path.join(root, 'nora-controls', created.id.slice(8, 10), created.id.slice(8) + '.json');
    assert.equal(fs.readFileSync(receipt, 'utf8').includes('runtimeReady'), false, 'receipt excludes returned private data');
});

test('broker expires never-delivered commands and isolates users and switched sessions', async t => {
    let clock = 1000; const root = temporary(t);
    const broker = createControlBroker(root, { now: () => clock, queueMs: 10 });
    const auth = { ...identity, ...broker.hello(identity) };
    const job = broker.submit(command('plugins.list'));
    clock += 11;
    assert.equal(broker.inspect(job.id).status, 'expired');
    assert.equal(await broker.poll(auth, null, 1), null);
    const next = broker.submit(command('mvu.status'));
    assert.equal(await broker.poll({ ...auth, worldId: 'world-b' }, null, 1), null);
    assert.equal(broker.inspect(next.id).status, 'failed');
    const other = createControlBroker(temporary(t));
    assert.throws(() => other.inspect(job.id), { code: 'NORA_CONTROL_NOT_FOUND' });
});

function runtimeFixture() {
    let saved = 0; let failSave = false; let trees = [{ type: 'script', id: 'one', name: 'One', content: 'original', enabled: true }, { type: 'script', id: 'two', name: 'Two', content: 'unchanged', enabled: true }];
    const context = { chatMetadata: { nora_world: { id: identity.worldId }, nora_session: { id: identity.sessionId } },
        characterId: 0, characters: [{ name: 'Fixture', avatar: 'runtime.png' }],
        extensionSettings: { disabledExtensions: [], nora_mvu: {}, mvu_settings: { '更新方式': '额外模型解析', '额外模型解析配置': { '启用自动请求': true, '最大回复token数': 4096, '密钥': 'fixture-secret' } },
            tavern_helper: { script: { enabled: { global: true, characters: [], presets: [] }, scripts: [] } }, example: { color: 'red' } },
        getActiveExtensionNames: () => ['regex', 'third-party/JS-Slash-Runner'],
        saveSettingsStrict: async () => { if (failSave) throw new Error('save rejected'); saved++; },
    };
    const mv = { getMvuData: () => ({ stat_data: { hp: 10 }, schema: {} }), reloadSettings() {}, retryLastUpdate: async () => {} };
    const mvu = createStMvuSettingsAdapter(() => context, { readMvuRuntime: () => mv });
    // Deliberately separate Helper's live store from ST's serialized settings.
    const live = { settings: structuredClone(context.extensionSettings.tavern_helper) };
    const helperControl = createHelperControlAdapter({ globalStore: () => live,
        scopeStore: type => ({ source: type === 'global' ? 'global' : 'Fixture', enabled: true }),
        clone: structuredClone, validateSettings: value => value,
        flushScope: async () => { context.extensionSettings.tavern_helper = structuredClone(live.settings); },
    });
    let stopped = '';
    const controls = createRuntimeControls({ getContext: () => context, story: { mvu, messages: { isGenerating: () => false } },
        dispatch: () => ({ cancel: async scope => { stopped = scope; }, execute: async command => ({ status: 'completed', value: await command.run?.() }) }),
        assertIdle: () => {}, globalRef: { Mvu: mv, TavernHelper: { noraControls: helperControl, getScriptTrees: () => structuredClone(trees), replaceScriptTrees: async next => { trees = structuredClone(next); }, getAllEnabledScriptButtons: () => ({}) } },
        loadExtensions: async () => ({ extensionNames: ['regex', 'memory', 'third-party/JS-Slash-Runner', 'third-party/nora-mvu', 'example'],
            enableExtension: async name => { context.extensionSettings.disabledExtensions = context.extensionSettings.disabledExtensions.filter(item => item !== name); },
            disableExtension: async name => { context.extensionSettings.disabledExtensions.push(name); } }),
    });
    return { context, controls, get saved() { return saved; }, get trees() { return trees; }, get stopped() { return stopped; }, set failSave(value) { failSave = value; } };
}

test('actual MVU adapter distinguishes extra-model switch from managed runtime, and disabled runtime stays disabled after initialization', async () => {
    const f = runtimeFixture();
    const state = await f.controls.execute(command('mvu.enabled', { enabled: false }));
    assert.equal(state.runtimeApplied, true);
    assert.equal(f.context.extensionSettings.mvu_settings['更新方式'], '随AI输出');
    assert.equal((await f.controls.execute(command('mvu.data'))).data.stat_data.hp, 10);
    const disabled = await f.controls.execute(command('mvu.runtime', { enabled: false }));
    assert.equal(disabled.runtimeApplied, false); assert.equal(disabled.reloadRequired, true);
    const restoredContext = { extensionSettings: structuredClone(f.context.extensionSettings) };
    initializeHeadlessMvuSettings(restoredContext);
    assert.equal(restoredContext.extensionSettings.nora_mvu.managedRuntimeEnabled, false);
    const data = await f.controls.execute(command('mvu.settings'));
    assert.equal(JSON.stringify(data).includes('fixture-secret'), false);
    f.failSave = true;
    await assert.rejects(f.controls.execute(command('mvu.enabled', { enabled: true })), /save rejected/);
});

test('MVU status exposes managed-runtime failure evidence without changing settings', async () => {
    const f = runtimeFixture();
    const controls = createRuntimeControls({
        getContext: () => f.context,
        story: {
            mvu: createStMvuSettingsAdapter(() => f.context, { readMvuRuntime: () => undefined }),
            messages: { isGenerating: () => false },
        },
        dispatch: () => ({ cancel: async () => {}, execute: async command => ({ status: 'completed', value: await command.run?.() }) }),
        globalRef: {
            NoraMvu: { status: () => ({
                phase: 'failed',
                error: 'bundle failed',
                registration: 'removed',
                updatePhase: 'failed',
                lastUpdateCode: 'MVU_NO_UPDATE_COMMAND',
                lastUpdateStage: 'validation',
                lastUpdateError: 'No valid MVU update command was found.',
                lastUpdateCommandCount: 0,
                lastUpdateValidationErrors: [{ commandType: 'unknown', reason: 'missing UpdateVariable block' }],
                transactionAttempt: 2,
                transactionDurationMs: 5712,
                lastUpdateAt: 1788318000000,
            }) },
        },
    });

    const status = await controls.execute(command('mvu.status'));

    assert.equal(status.managedPhase, 'failed');
    assert.equal(status.managedError, 'bundle failed');
    assert.equal(status.legacyScriptCleanup, 'removed');
    assert.equal(status.updatePhase, 'failed');
    assert.equal(status.lastUpdateCode, 'MVU_NO_UPDATE_COMMAND');
    assert.equal(status.lastUpdateStage, 'validation');
    assert.equal(status.lastUpdateError, 'No valid MVU update command was found.');
    assert.equal(status.lastUpdateCommandCount, 0);
    assert.deepEqual(status.lastUpdateValidationErrors, [{ commandType: 'unknown', reason: 'missing UpdateVariable block' }]);
    assert.equal(status.transactionAttempt, 2);
    assert.equal(status.transactionDurationMs, 5712);
    assert.equal(status.lastUpdateAt, 1788318000000);
});

test('script management uses helper API, preserves siblings, rejects stale edits, creates disabled scripts', async () => {
    const f = runtimeFixture();
    const before = await f.controls.execute(command('scripts.list', { scope: 'global' }));
    await f.controls.execute(command('scripts.update', { scope: 'global', id: 'one', patch: { content: 'updated' }, expectedRevision: before.revision }));
    assert.equal(f.trees[0].content, 'updated'); assert.equal(f.trees[1].content, 'unchanged');
    await assert.rejects(f.controls.execute(command('scripts.enabled', { scope: 'global', id: 'one', enabled: false, expectedRevision: before.revision })), { code: 'NORA_CONTROL_EDIT_STALE' });
    const current = await f.controls.execute(command('scripts.list', { scope: 'global' }));
    const created = await f.controls.execute(command('scripts.create', { scope: 'global', name: 'New', content: 'code', expectedRevision: current.revision }));
    assert.equal(f.trees.find(item => item.id === created.id).enabled, false);
});

test('product exclusions, dependency protection, strict configuration fields and stale World guard are enforced', async () => {
    const f = runtimeFixture();
    const list = await f.controls.execute(command('plugins.list'));
    assert.equal(list.plugins.find(item => item.name === 'memory').controllable, false);
    assert.equal(list.quickReply.available, false);
    await assert.rejects(f.controls.execute(command('plugins.enabled', { name: 'memory', enabled: true })), { code: 'NORA_CONTROL_PROTECTED' });
    await assert.rejects(f.controls.execute(command('plugins.enabled', { name: 'third-party/JS-Slash-Runner', enabled: false })), { code: 'NORA_CONTROL_DEPENDENCY' });
    const changed = await f.controls.execute(command('plugins.configure', { name: 'example', updates: { color: 'blue' } }));
    assert.equal(changed.runtimeApplied, false); assert.equal(changed.reloadRequired, true);
    await assert.rejects(f.controls.execute(command('plugins.configure', { name: 'example', updates: { '__proto__.pollution': true } })), { code: 'NORA_CONTROL_FIELD_DENIED' });
    await f.controls.execute(command('story.stop')); assert.equal(f.stopped, 'visible');
    f.context.chatMetadata.nora_world.id = 'another';
    await assert.rejects(f.controls.execute(command('mvu.status')), { code: 'NORA_CONTROL_SCOPE_CHANGED' });
});

test('embedded MVU configuration exposes token limits but not credentials and rejects invalid values before mutation', async () => {
    const f = runtimeFixture();
    const result = await f.controls.execute(command('mvu.configure', { updates: { '额外模型解析配置.最大回复token数': 20000 } }));
    assert.equal(result.settings['额外模型解析配置']['最大回复token数'], 20000);
    assert.equal(result.settings['额外模型解析配置']['密钥'], '[redacted]');
    const before = structuredClone(f.context.extensionSettings.mvu_settings);
    await assert.rejects(f.controls.execute(command('mvu.configure', { updates: { '额外模型解析配置.请求方式': 'bad-enum' } })), { code: 'NORA_CONTROL_INVALID' });
    await assert.rejects(f.controls.execute(command('mvu.configure', { updates: { '额外模型解析配置.最大回复token数': -1 } })), { code: 'NORA_CONTROL_INVALID' });
    assert.deepEqual(f.context.extensionSettings.mvu_settings, before);
});

test('Helper control adapter changes the live store and explicitly flushes the serialized copy', async () => {
    const live = { settings: { render: { enabled: true }, script: { enabled: { global: true } } } };
    let disk = structuredClone(live.settings); let source = 'preset-a'; let flushed = 0;
    const scopeStore = { get source() { return source; }, get enabled() { return live.settings.script.enabled.global; }, set enabled(value) { live.settings.script.enabled.global = value; } };
    const adapter = createHelperControlAdapter({ globalStore: () => live, scopeStore: () => scopeStore,
        validateSettings: next => { assert.equal(typeof next.render.enabled, 'boolean'); return next; }, clone: structuredClone,
        flushScope: async () => { flushed++; disk = structuredClone(live.settings); },
    });
    const next = adapter.settings(); next.render.enabled = false; adapter.configure(next);
    assert.equal(live.settings.render.enabled, false); assert.equal(disk.render.enabled, true);
    await adapter.flush('preset', 'preset-a'); assert.equal(disk.render.enabled, false);
    adapter.setScopeEnabled('global', false); assert.equal(scopeStore.enabled, false);
    source = 'preset-b'; await assert.rejects(adapter.flush('preset', 'preset-a'), /scope changed/); assert.equal(flushed, 1);
});

test('script buttons invoke the original Helper event bus without a DOM button or synthesized click', async () => {
    const events = []; const f = runtimeFixture();
    const controls = createRuntimeControls({ getContext: () => ({ ...f.context, eventSource: { emit: async id => events.push(id) } }),
        story: { messages: { isGenerating: () => false } }, assertIdle: () => {},
        dispatch: () => ({ execute: async input => ({ status: 'completed', value: await input.run() }) }),
        globalRef: { TavernHelper: { getScriptTrees() {}, getAllEnabledScriptButtons: () => ({ id: [{ button_id: 'script_123', button_name: 'Run' }] }) } },
    });
    const result = await controls.execute(command('scripts.button', { buttonId: 'script_123' }));
    assert.deepEqual(events, ['script_123']); assert.equal(result.completionKnown, false);
    await assert.rejects(controls.execute(command('scripts.button', { buttonId: 'arbitrary-event' })), { code: 'NORA_CONTROL_BUTTON_MISSING' });
});

test('control mutation participates in the actual dispatcher session guard until persistence settles', async () => {
    let releaseSave; const saving = new Promise(resolve => { releaseSave = resolve; });
    const f = runtimeFixture(); f.context.saveSettingsStrict = () => saving;
    const bridge = createInteractionBridge(); const messages = { isGenerating: () => false };
    const actions = createStoryActionDispatcher({ messages, getSessionKey: () => identity.sessionId });
    const helperAdapter = createTavernHelperActionAdapter({ storyActions: actions, messages, bridge, globalRef: {} }); helperAdapter.start();
    const controls = createRuntimeControls({ getContext: () => f.context, story: { messages }, dispatch: () => actions, assertIdle: () => bridge.assertSessionIdle() });
    const change = controls.execute(command('mvu.runtime', { enabled: false }));
    await Promise.resolve();
    assert.throws(() => bridge.assertSessionIdle(), { code: 'NORA_SESSION_BUSY' });
    releaseSave(); await change;
    assert.doesNotThrow(() => bridge.assertSessionIdle()); helperAdapter.stop();
});

test('regex controls preserve sibling rules, reject invalid nested fields and stale revisions', async () => {
    const f = runtimeFixture(); let rules = [{ id: 'a', scriptName: 'A', disabled: false }, { id: 'b', scriptName: 'B', disabled: false }];
    const controls = createRuntimeControls({ getContext: () => f.context, story: { messages: { isGenerating: () => false } }, assertIdle: () => {},
        dispatch: () => ({ execute: async input => ({ status: 'completed', value: await input.run() }) }),
        loadRegex: async () => ({ getScriptsByType: () => rules, saveScriptsByType: async next => { rules = next; } }),
    });
    const before = await controls.execute(command('regex.list', { scope: 'global' }));
    await assert.rejects(controls.execute(command('regex.update', { scope: 'global', id: 'a', expectedRevision: before.revision, patch: { placement: ['bad'] } })), { code: 'NORA_CONTROL_INVALID' });
    await controls.execute(command('regex.enabled', { scope: 'global', id: 'a', enabled: false, expectedRevision: before.revision }));
    assert.equal(rules[0].disabled, true); assert.equal(rules[1].disabled, false);
    await assert.rejects(controls.execute(command('regex.delete', { scope: 'global', id: 'b', expectedRevision: before.revision })), { code: 'NORA_CONTROL_EDIT_STALE' });
});

test('shared blank/legacy runtime cards cannot be edited as if they belonged exclusively to one World', async () => {
    const f = runtimeFixture(); f.context.getRequestHeaders = () => ({}); const writes = [];
    const controls = createRuntimeControls({ getContext: () => f.context, story: { messages: { isGenerating: () => false }, worlds: { usesRuntimeCard: () => true } }, assertIdle: () => {},
        dispatch: () => ({ execute: async input => ({ status: 'completed', value: await input.run() }) }),
        fetcher: async (route, options) => {
            writes.push([route, options.method]);
            return { ok: true, json: async () => route.endsWith('/open-plan') ? { plan: { world_id: identity.worldId, runtime_card: { binding: { avatar: 'runtime.png' }, ownership: 'shared' } } } : { data: { first_mes: 'old' } } };
        },
    });
    const inspected = await controls.execute(command('cards.inspect'));
    await assert.rejects(controls.execute(command('cards.opening', { text: 'new', expectedRevision: inspected.revision })), { code: 'NORA_CONTROL_CARD_SHARED' });
    assert.equal(writes.some(([route]) => route.endsWith('/merge-attributes')), false);
});
