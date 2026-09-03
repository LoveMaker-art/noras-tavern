import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createStartupController } from '../../../native-extensions/nora-ui/startup-controller.js';

test('empty-workspace finalization releases existing prerequisites without claiming World usability', async (t) => {
    const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const name = source.includes('function waitForNoraRuntimeReady()') ? 'waitForNoraRuntimeReady' : 'waitForNoraUsable';
    const start = source.indexOf(`function ${name}()`);
    const implementation = source.slice(start, source.indexOf('async function finishDeferredInitialization', start));
    const events = new EventTarget();
    const classes = new Set();
    const doc = { body: { classList: { add: value => classes.add(value), contains: value => classes.has(value) } } };
    const originals = Object.fromEntries(['document', 'window', 'dispatchEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    globalThis.document = doc;
    globalThis.window = {};
    globalThis.dispatchEvent = event => events.dispatchEvent(event);
    const wait = new Function('document', 'globalThis', `${implementation};return ${name};`)(doc, events);
    let resolved = false;
    let usable = false;
    events.addEventListener('nora:usable', () => { usable = true; });
    void wait().then(() => { resolved = true; });
    const startup = createStartupController({ finishBootScreen() {}, readState: () => ({ activeCharacterId: -1, activeChatId: null, messages: [] }),
        select: () => ({ disabled: false, getAttribute: () => null }), messageView: { hasMessages: () => true },
        messageController: { updateComposer() {} }, openInitialWorld: async () => {},
        storyScroller: { followLatest: () => () => {}, toLatest: async () => {} }, selectAll: () => [],
        performanceReporter: { phase() {}, milestone() {}, usable() {} } });
    await startup.finalizeUi();
    await Promise.resolve();
    assert.equal(resolved, false, 'shell readiness must not start compatibility extensions before World restoration settles');
    await startup.restoreInitialWorld();
    await Promise.resolve();
    assert.equal(resolved, true, 'an empty workspace must still release runtime prerequisites after restoration settles');
    assert.equal(usable, false, 'no World exists yet, so the user-outcome event must not fire');
    await wait();
});

test('application shell becomes ready before the initial World is restored', async (t) => {
    const calls = [];
    const events = new EventTarget();
    const classes = new Set();
    const originals = Object.fromEntries(['document', 'window', 'dispatchEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    globalThis.document = { body: { classList: { add: value => classes.add(value), contains: value => classes.has(value) } } };
    globalThis.window = {};
    globalThis.dispatchEvent = event => events.dispatchEvent(event);
    let usable = false;
    events.addEventListener('nora:usable', () => { usable = true; });

    const startup = createStartupController({
        state: { subscribe() {} },
        messageView: { hasMessages: () => true },
        messageController: { observeMessages() {}, updateComposer: () => calls.push('composer'), syncGenerating() {} },
        select: selector => selector === '#nora-input'
            ? { disabled: false, value: '' }
            : { getAttribute: () => null, requestSubmit() {} },
        selectAll: () => [],
        readState: () => ({ activeCharacterId: 0, activeChatId: 'chat-one', messages: [] }),
        settings() {},
        buildLayout() {},
        bindLayoutEvents() {},
        refresh: () => calls.push('refresh'),
        loadWorlds: async () => calls.push('worlds'),
        openInitialWorld: async () => calls.push('initial-world'),
        storyScroller: { followLatest: () => () => {}, toLatest: async () => calls.push('latest') },
        openNewWorldSheet() {},
        runPanelAction() {},
        updateActiveWorldSummary() {},
        finishBootScreen: () => calls.push('shell-ready'),
        recordBootMilestone() {},
        performanceReporter: { phase() {}, milestone() {}, usable() {} },
        onStarted() {},
    });

    await startup.hydrateUi();
    assert.deepEqual(calls, ['refresh', 'worlds', 'composer']);
    await startup.finalizeUi();
    assert.equal(classes.has('nora-app-ready'), true);
    assert.equal(classes.has('nora-runtime-ready'), false);
    assert.equal(calls.includes('shell-ready'), true);
    assert.equal(usable, false);

    await startup.restoreInitialWorld();
    assert.ok(calls.indexOf('initial-world') > calls.indexOf('shell-ready'));
    assert.ok(calls.indexOf('latest') > calls.indexOf('initial-world'));
    assert.equal(classes.has('nora-runtime-ready'), true);
    assert.equal(usable, true);
});

test('a failed initial World releases runtime prerequisites without claiming usability', async (t) => {
    const events = new EventTarget();
    const classes = new Set();
    const originals = Object.fromEntries(['document', 'window', 'dispatchEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    globalThis.document = { body: { classList: { add: value => classes.add(value), contains: value => classes.has(value) } } };
    globalThis.window = {};
    globalThis.dispatchEvent = event => events.dispatchEvent(event);
    let usable = false;
    events.addEventListener('nora:usable', () => { usable = true; });

    const startup = createStartupController({
        messageView: { hasMessages: () => false },
        messageController: { updateComposer() {} },
        select: () => ({ disabled: false, getAttribute: () => null }),
        selectAll: () => [],
        readState: () => ({ activeCharacterId: -1, activeChatId: null, messages: [] }),
        openInitialWorld: async () => { throw new Error('broken World'); },
        storyScroller: { followLatest: () => () => {}, toLatest: async () => {} },
        finishBootScreen() {},
        performanceReporter: { phase() {}, milestone() {}, usable() {} },
    });

    await assert.rejects(startup.restoreInitialWorld(), /broken World/);
    assert.equal(classes.has('nora-runtime-ready'), true);
    assert.equal(usable, false);
});
