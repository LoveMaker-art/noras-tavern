import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppearanceController } from '../../../native-extensions/nora-ui/appearance-controller.js';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { validateControl } from '../public/scripts/nora-controls/contract.js';

function fixture(hostname = 'localhost', initial = {}) {
    const settings = { ...initial, globalTheme: { theme: { text: '#abc' } } };
    const attributes = new Map(); const listeners = new Set();
    const root = { style: {}, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k) };
    const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
    let stored; let fail = false;
    const options = { root, media, hostname, settings: () => settings, persist: async () => {
        if (fail) throw new Error('save failed');
        stored = structuredClone(settings);
    } };
    const controller = createAppearanceController(options);
    return { controller, options, root, media, settings, attributes, listeners,
        stored: () => stored, failSave: () => { fail = true; },
        system: dark => { media.matches = dark; listeners.forEach(fn => fn()); } };
}

test('local appearance persists, restores and follows system only in automatic mode', async () => {
    const f = fixture();
    assert.equal(f.controller.inspect().effectiveMode, 'light');
    const dark = await f.controller.set({ mode: 'dark', expectedRevision: 'system' });
    assert.equal(dark.saved, true);
    assert.equal(dark.effectiveMode, 'dark');
    assert.equal(f.attributes.get('data-nora-appearance'), 'dark');
    assert.equal(f.stored().appearanceMode, 'dark');
    assert.deepEqual(f.stored().globalTheme, { theme: { text: '#abc' } });
    f.controller.dispose();
    const restored = createAppearanceController({ ...f.options, settings: () => f.stored() });
    assert.equal(restored.inspect().mode, 'dark');
    restored.dispose();
    const c = createAppearanceController(f.options);
    f.system(true);
    await c.set({ mode: 'light', expectedRevision: 'dark' });
    assert.equal(c.inspect().effectiveMode, 'light');
    assert.equal(f.root.style.colorScheme, 'light');
    await c.set({ mode: 'system', expectedRevision: 'light' });
    assert.equal(f.attributes.has('data-nora-appearance'), false);
    assert.equal(c.inspect().effectiveMode, 'dark');
    f.system(false);
    assert.equal(c.inspect().effectiveMode, 'light');
    c.dispose();
    assert.equal(f.listeners.size, 0);
});

test('remote Liveware ignores local manual preference and rejects manual control', async () => {
    const f = fixture('tavern.example.org', { appearanceMode: 'dark' });
    assert.equal(f.controller.inspect().controllable, false);
    assert.equal(f.controller.inspect().mode, 'system');
    assert.equal(f.controller.inspect().effectiveMode, 'light');
    assert.equal(f.attributes.has('data-nora-appearance'), false);
    f.system(true);
    assert.equal(f.controller.inspect().effectiveMode, 'dark');
    await assert.rejects(f.controller.set({ mode: 'light', expectedRevision: 'dark' }), { code: 'NORA_APPEARANCE_AUTOMATIC' });
    assert.equal(f.settings.appearanceMode, 'dark');
});

test('invalid, stale and failed writes leave previous preference intact', async () => {
    const f = fixture('127.0.0.1');
    await assert.rejects(f.controller.set({ mode: 'wrong', expectedRevision: 'system' }), { code: 'NORA_CONTROL_INVALID' });
    await assert.rejects(f.controller.set({ mode: 'dark', expectedRevision: 'light' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    f.failSave();
    await assert.rejects(f.controller.set({ mode: 'dark', expectedRevision: 'system' }), /save failed/);
    assert.equal(f.settings.appearanceMode, undefined);
    assert.equal(f.controller.inspect().mode, 'system');
    assert.equal(f.attributes.has('data-nora-appearance'), false);
});

test('formal control entry reaches the page controller without an active World', async () => {
    const f = fixture('[::1]');
    const runtime = createRuntimeControls({ getContext: () => ({ chatMetadata: {} }),
        story: { model: {}, settings: { uiSettings: () => f.settings } }, assertIdle: () => {},
        globalRef: { NoraUI: { appearanceState: f.controller.inspect, setAppearance: f.controller.set } } });
    const command = { action: 'appearance.inspect', params: {}, worldId: '', sessionId: '' };
    assert.equal((await runtime.execute(command)).mode, 'system');
    const write = { ...command, action: 'appearance.set', confirm: true, params: { mode: 'dark', expectedRevision: 'system' } };
    assert.throws(() => validateControl({ ...write, confirm: false }), { code: 'NORA_CONFIRMATION_REQUIRED' });
    assert.throws(() => validateControl({ ...write, params: { ...write.params, mode: 'invalid' } }), { code: 'NORA_CONTROL_INVALID' });
    assert.equal((await runtime.execute(write)).effectiveMode, 'dark');
    assert.equal((await runtime.execute(command)).savedMode, 'dark');
});
