import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createStartupController } from '../../../native-extensions/nora-ui/startup-controller.js';

test('a mounted-page navigation cancels an automatic resume that has not been consumed', () => {
    const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const start = source.indexOf("document.addEventListener('click', (event) => {");
    const end = source.indexOf('}, true);', start) + '}, true);'.length;
    let handler;
    const state = { pendingAction: { name: 'world', source: 'resume', worldId: 'world:last' } };
    const document = { addEventListener: (_name, callback) => { handler = callback; }, body: { classList: { contains: () => true } } };
    class Element { closest(selector) { return selector.includes('[data-action]') ? this : null; } }
    new Function('document', 'state', 'Element', source.slice(start, end))(document, state, Element);
    handler({ target: new Element() });
    assert.equal(state.skipResume, true);
    assert.equal(state.pendingAction, null);
});

test('real early resume selection hands off after mounting, regardless of bootstrap timing', async t => {
    const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const start = source.indexOf('state.resumePromise = Promise.all([shellPromise, dataPromise])');
    assert.ok(start >= 0);
    const end = source.indexOf('.catch(failEarlyShell);', start) + '.catch(failEarlyShell);'.length;
    const selectResume = new Function('state', 'shellPromise', 'dataPromise', 'document', 'list', 'queueWorld', 'failEarlyShell', 'globalThis', source.slice(start, end));
    const originalWindow = globalThis.window;
    t.after(() => { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
    for (const timing of ['before-mount', 'after-mount']) {
        for (const scenario of ['resume', 'user-world', 'user-panel', 'cancel', 'deleted', 'missing', 'no-history']) {
            const early = { pendingAction: null, pendingSend: false };
            globalThis.window = { __NORA_EARLY__: early };
            let settle;
            const data = new Promise(resolve => { settle = resolve; });
            const world = { id: 'world:last', lifecycleStatus: scenario === 'deleted' ? 'DELETED' : 'READY' };
            selectResume(early, Promise.resolve({ worlds: scenario === 'missing' ? [] : [world] }), data,
                { body: { classList: { contains: () => true } } }, { querySelectorAll: () => [] },
                (world, _target, source) => { early.pendingAction = { name: 'world', worldId: world.id, source, clickedAt: 1 }; },
                error => assert.fail(error.message), { __NORA_BOOT_METRICS__: { milestones: [] } });
            const opened = [];
            const startup = createStartupController({
                select: () => ({}), selectAll: () => [],
                openWorldById: async id => opened.push(id), runPanelAction: name => opened.push(name),
            });
            if (scenario === 'user-world') early.pendingAction = { name: 'world', worldId: 'world:chosen' };
            if (scenario === 'user-panel') early.pendingAction = { name: 'library' };
            if (scenario === 'cancel') early.skipResume = true;
            if (timing === 'before-mount') {
                settle({ lastWorldId: scenario === 'no-history' ? '' : world.id });
                await early.resumePromise;
            }
            const consumed = startup.consumeEarlyIntent();
            if (timing === 'after-mount') {
                await Promise.resolve();
                assert.deepEqual(opened, [], 'Hydration must wait for resume selection');
                settle({ lastWorldId: scenario === 'no-history' ? '' : world.id });
            }
            await consumed;
            await startup.consumeEarlyIntent();
            assert.deepEqual(opened, scenario === 'resume' ? ['world:last'] : scenario === 'user-world' ? ['world:chosen'] : scenario === 'user-panel' ? ['library'] : [], `${timing}: ${scenario}`);
        }
    }
});

test('empty-workspace finalization releases runtime prerequisites at the World list', async (t) => {
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
        messageController: { updateComposer() {} }, selectAll: () => [],
        performanceReporter: { phase() {}, milestone() {}, usable() {} } });
    await startup.finalizeUi();
    await Promise.resolve();
    assert.equal(resolved, true, 'the World list must release compatibility prerequisites without opening a World');
    assert.equal(usable, true, 'the interactive World list is a usable product state');
    await wait();
});

test('application startup stops at the World list without restoring a World', async (t) => {
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
        openWorldById: async () => calls.push('requested-world'),
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
    assert.equal(classes.has('nora-runtime-ready'), true);
    assert.equal(calls.includes('shell-ready'), true);
    assert.equal(usable, true);
    assert.equal(calls.includes('requested-world'), false);
});

test('an early World click is handed to the authoritative activation path without opening two Worlds', async (t) => {
    const calls = [];
    const classes = new Set();
    const originals = Object.fromEntries(['document', 'window', 'dispatchEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    globalThis.document = { body: { classList: { add: value => classes.add(value), contains: value => classes.has(value) } } };
    globalThis.window = { __NORA_EARLY__: { pendingAction: { name: 'world', worldId: 'world:two', clickedAt: 42 }, pendingSend: false } };
    globalThis.dispatchEvent = () => {};

    const startup = createStartupController({
        messageView: { hasMessages: () => true },
        messageController: { updateComposer: () => calls.push('composer') },
        select: () => ({ disabled: false, getAttribute: () => null }),
        selectAll: () => [],
        readState: () => ({ activeCharacterId: 0, activeChatId: 'chat-two', messages: [] }),
        openWorldById: async (worldId, options) => calls.push(['requested-world', worldId, options]),
        performanceReporter: { phase() {}, milestone() {}, usable() {} },
    });

    await startup.consumeEarlyIntent();
    assert.deepEqual(calls[0], ['requested-world', 'world:two', { interactionId: 'early-world-42', showBuffer: true }]);
    assert.equal(globalThis.window.__NORA_EARLY__.pendingAction, null);
});

test('a returning user resumes the server-validated last World through the same activation path', async (t) => {
    const calls = [];
    const classes = new Set(['nora-world-opening']);
    const originals = Object.fromEntries(['document', 'window', 'dispatchEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    globalThis.document = { body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } } };
    globalThis.window = { __NORA_EARLY__: { pendingAction: { name: 'world', source: 'resume', worldId: 'world:last', clickedAt: 84 }, pendingSend: false } };
    globalThis.dispatchEvent = () => {};

    const startup = createStartupController({
        messageView: { hasMessages: () => true },
        messageController: { updateComposer() {} },
        select: () => ({ disabled: false, getAttribute: () => null, setAttribute() {} }),
        selectAll: () => [],
        readState: () => ({ activeCharacterId: 0, activeChatId: 'chat-last', messages: [] }),
        openWorldById: async (worldId, options) => calls.push(['resume', worldId, options]),
        refresh: () => calls.push('refresh'),
        recordBootMilestone: milestone => calls.push(['milestone', milestone]),
        performanceReporter: { phase() {}, milestone() {}, usable() {} },
    });

    await startup.consumeEarlyIntent();
    assert.deepEqual(calls[0], ['resume', 'world:last', { interactionId: 'early-world-84', showBuffer: true }]);
    assert.equal(classes.has('nora-world-opening'), true);
});

test('a failed automatic resume returns to the World list without failing application hydration', async (t) => {
    const calls = [];
    const classes = new Set(['nora-world-opening']);
    const buffer = { setAttribute: (...args) => calls.push(['buffer', ...args]) };
    const originals = Object.fromEntries(['document', 'window', 'dispatchEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
    globalThis.document = { body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } } };
    globalThis.window = { __NORA_EARLY__: { pendingAction: { name: 'world', source: 'resume', worldId: 'world:gone', clickedAt: 126 }, pendingSend: false } };
    globalThis.dispatchEvent = () => {};

    const startup = createStartupController({
        messageView: { hasMessages: () => true },
        messageController: { updateComposer() {} },
        select: selector => selector === '#nora-world-buffer' ? buffer : { disabled: false, getAttribute: () => null },
        selectAll: () => [],
        readState: () => ({ activeCharacterId: -1, activeChatId: null, messages: [] }),
        openWorldById: async () => { throw new Error('missing World'); },
        refresh: () => calls.push('refresh'),
        recordBootMilestone: milestone => calls.push(['milestone', milestone]),
        performanceReporter: { phase() {}, milestone() {}, usable() {} },
    });

    await startup.consumeEarlyIntent();
    assert.equal(classes.has('nora-world-opening'), false);
    assert.deepEqual(calls[0], ['buffer', 'aria-hidden', 'true']);
    assert.equal(calls.includes('refresh'), true);
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'milestone' && call[1].name === 'last-world-resume-failed'), true);
});
