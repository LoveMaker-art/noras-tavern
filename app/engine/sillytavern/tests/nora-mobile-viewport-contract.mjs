import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createViewportController } from '../../../native-extensions/nora-ui/viewport-controller.js';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.dirname(testsRoot);
const uiRoot = path.resolve(engineRoot, '../../native-extensions/nora-ui');

function eventTarget(properties = {}) {
    const listeners = new Map();
    return Object.assign({
        addEventListener(name, listener) {
            const group = listeners.get(name) || new Set();
            group.add(listener);
            listeners.set(name, group);
        },
        removeEventListener(name, listener) {
            listeners.get(name)?.delete(listener);
        },
        dispatch(name) {
            for (const listener of listeners.get(name) || []) listener({ type: name });
        },
        listenerCount(name) {
            return listeners.get(name)?.size || 0;
        },
    }, properties);
}

function fixture({ innerHeight = 800, visualHeight, offsetTop = 0 } = {}) {
    const values = new Map();
    const root = {
        style: {
            setProperty(name, value) { values.set(name, value); },
        },
    };
    const viewport = visualHeight === undefined ? undefined : eventTarget({ height: visualHeight, offsetTop });
    const windowRef = eventTarget({ innerHeight, visualViewport: viewport });
    const observed = [];
    let disconnected = false;
    class ResizeObserverFake {
        constructor(callback) { this.callback = callback; }
        observe(element) { observed.push(element); }
        disconnect() { disconnected = true; }
    }
    const controller = createViewportController({
        windowRef,
        root,
        scheduleFrame: callback => callback(),
        ResizeObserverImpl: ResizeObserverFake,
    });
    return { controller, windowRef, viewport, root, values, observed, disconnected: () => disconnected };
}

{
    const state = fixture({ innerHeight: 800, visualHeight: 420 });
    state.controller.mount();
    assert.equal(state.values.get('--nora-vh'), '420px', 'the composer must stay above an overlay keyboard');
    assert.equal(state.values.get('--nora-vv-top'), '0px');
    assert.deepEqual(state.observed, [state.root]);

    state.viewport.height = 360;
    state.viewport.offsetTop = 24;
    state.viewport.dispatch('resize');
    assert.equal(state.values.get('--nora-vh'), '360px');
    assert.equal(state.values.get('--nora-vv-top'), '24px', 'panned WebViews must align the shell with the visible viewport');

    state.controller.dispose();
    assert.equal(state.viewport.listenerCount('resize'), 0);
    assert.equal(state.viewport.listenerCount('scroll'), 0);
    assert.equal(state.disconnected(), true);
}

{
    const state = fixture({ innerHeight: 800 });
    state.controller.mount();
    assert.equal(state.values.get('--nora-vh'), '800px', 'desktop and older WebViews must fall back to innerHeight');
    state.windowRef.innerHeight = 640;
    state.windowRef.dispatch('resize');
    assert.equal(state.values.get('--nora-vh'), '640px');
}

{
    const shell = fs.readFileSync(path.join(uiRoot, 'shell-controller.js'), 'utf8');
    const style = fs.readFileSync(path.join(uiRoot, 'style.css'), 'utf8');
    const earlyShell = fs.readFileSync(path.join(engineRoot, 'public/index.html'), 'utf8');
    assert.match(shell, /createViewportController\(\)/);
    assert.match(shell, /viewport\.mount\(\)/);
    assert.match(style, /#nora-layout\s*\{[^}]*top:\s*var\(--nora-vv-top\);[^}]*height:\s*var\(--nora-vh\);/s);
    assert.match(earlyShell, /#nora-layout\s*\{[^}]*top:\s*var\(--nora-vv-top\);[^}]*height:\s*var\(--nora-vh\);/s);
    assert.match(
        earlyShell,
        /body\.nora-product\s*>\s*\[name="templatesAndPopupsWrapper"\]\s*\{[^}]*display:\s*none\s*!important;/s,
        'legacy ST popup and editor hosts must never enter the mobile document flow when the keyboard pans the viewport',
    );
}

console.log('nora-mobile-viewport-contract=PASS');
