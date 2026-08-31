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
        performanceReporter: { phase() {}, milestone() {}, usable() {} } });
    await startup.finalizeUi();
    await Promise.resolve();
    assert.equal(resolved, true, 'a waiter registered before startup must resolve in an empty workspace');
    assert.equal(usable, false, 'no World exists yet, so the user-outcome event must not fire');
    await wait();
});
