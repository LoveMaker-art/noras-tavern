/* global globalThis */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorldController } from '../../../native-extensions/nora-ui/world-controller.js';

function deferred() {
    let resolve;
    const promise = new Promise(accept => { resolve = accept; });
    return { promise, resolve };
}

test('rapid world selection only completes supporting work for the latest world', async () => {
    const firstActivation = deferred();
    const firstActivationStarted = deferred();
    const settings = {};
    const activated = [];
    const primed = [];
    const refreshed = [];
    const reflected = [];
    const settingsSaves = [];
    const milestones = [];
    const elements = new Map();
    const makeElement = () => ({
        textContent: '',
        setAttribute() {},
        removeAttribute() {},
    });
    const select = selector => {
        if (!elements.has(selector)) elements.set(selector, makeElement());
        return elements.get(selector);
    };
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = {
        body: {
            classList: {
                toggle() {},
                remove() {},
                contains() { return true; },
            },
        },
    };
    globalThis.window = { __NORA_REPORT_BOOT_METRICS__: () => {} };

    try {
        const controller = createWorldController({
            settingsDomain: {
                uiSettings: () => settings,
                saveUiSettings: options => settingsSaves.push(options),
                isGenerating: () => false,
            },
            worldRuntime: {
                activate: async worldId => {
                    activated.push(worldId);
                    if (worldId === 'first') {
                        firstActivationStarted.resolve();
                        await firstActivation.promise;
                    }
                },
            },
            store: { read: () => ({ worldModels: [] }) },
            operations: {
                isBusy: () => false,
                run: async (_scope, operation) => operation(),
            },
            storyScroller: {
                followLatest: () => () => {},
                toLatest: async () => {},
            },
            select,
            selectAll: () => [],
            escapeHtml: value => value,
            icons: { trash: '' },
            readState: () => ({ messages: [] }),
            activeWorldModel: () => ({ id: 'origin' }),
            showToast: () => {},
            confirmAction: async () => false,
            normalizeError: error => error.message,
            timedUiStep: async (_name, operation) => operation(),
            recordBootMilestone: milestone => milestones.push(milestone),
            performanceReporter: { timedMilestone: milestone => milestones.push({ name: milestone }) },
            primeActiveWorldbook: async () => primed.push(settings.lastWorldId),
            resolveCharacterCapabilities: async characterId => ({ characterId }),
            promptCharacterCapabilities: async () => {},
            closeDrawers: () => {},
            refresh: () => refreshed.push(settings.lastWorldId),
            refreshWorldsAfterCommit: async () => true,
            updateComposer: () => {},
            isGenerating: () => false,
            onWorldLeaving: worldId => reflected.push(worldId),
        });

        const first = controller.queueSelection({ id: 'first', name: 'First', characterId: 1, interactionId: 'first' });
        await firstActivationStarted.promise;
        const second = controller.queueSelection({ id: 'second', name: 'Second', characterId: 2, interactionId: 'second' });
        firstActivation.resolve();
        await Promise.all([first, second]);

        assert.deepEqual(activated, ['first', 'second']);
        assert.equal(settings.lastWorldId, 'second');
        assert.deepEqual(settingsSaves, [{ immediate: true }]);
        assert.deepEqual(primed, ['second']);
        assert.deepEqual(refreshed, ['second']);
        assert.equal(elements.get('#nora-world-buffer-title').textContent, 'Second');
        assert.equal(milestones.filter(item => item.name === 'world-selected').length, 1);
        assert.deepEqual(reflected, ['origin']);
    } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});

test('cold MVU World delegates the complete readiness lifecycle to World Runtime', async () => {
    const calls = [];
    const settings = {};
    const elements = new Map();
    const makeElement = () => ({
        textContent: '',
        setAttribute() {},
        removeAttribute() {},
    });
    const select = selector => {
        if (!elements.has(selector)) elements.set(selector, makeElement());
        return elements.get(selector);
    };
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = {
        body: {
            classList: {
                toggle() {},
                remove() {},
                contains() { return false; },
            },
        },
    };
    globalThis.window = { __NORA_REPORT_BOOT_METRICS__: () => {} };

    try {
        const controller = createWorldController({
            settingsDomain: {
                uiSettings: () => settings,
                saveUiSettings: () => {},
                isGenerating: () => false,
            },
            worldRuntime: {
                activate: async () => calls.push('lifecycle'),
            },
            store: { read: () => ({ worldModels: [] }) },
            operations: {
                isBusy: () => false,
                run: async (_scope, operation) => operation(),
            },
            storyScroller: {
                followLatest: () => () => {},
                toLatest: async () => {},
            },
            select,
            selectAll: () => [],
            escapeHtml: value => value,
            icons: { trash: '' },
            readState: () => ({ messages: [] }),
            activeWorldModel: () => null,
            showToast: () => {},
            confirmAction: async () => false,
            normalizeError: error => error.message,
            timedUiStep: async (_name, operation) => operation(),
            recordBootMilestone: () => {},
            performanceReporter: { timedMilestone: () => {} },
            primeActiveWorldbook: async () => {},
            resolveCharacterCapabilities: async () => ({ name: 'MVU card' }),
            promptCharacterCapabilities: async () => {},
            closeDrawers: () => {},
            refresh: () => {},
            refreshWorldsAfterCommit: async () => true,
            updateComposer: () => {},
            isGenerating: () => false,
        });
        const selection = {
            id: 'cold-mvu',
            name: 'Cold MVU',
            characterId: 1,
            interactionId: 'cold-mvu',
        };

        await controller.queueSelection(selection);

        assert.equal(selection.failed, undefined);
        assert.deepEqual(calls, ['lifecycle']);
    } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});

test('v2 base activation completes before asynchronous capability readiness settles', async () => {
    const capabilityStarted = deferred();
    const capabilityRelease = deferred();
    const calls = [];
    const elements = new Map();
    const makeElement = () => ({ textContent: '', setAttribute() {}, removeAttribute() {} });
    const select = selector => {
        if (!elements.has(selector)) elements.set(selector, makeElement());
        return elements.get(selector);
    };
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = {
        body: {
            classList: {
                toggle() {},
                remove() {},
                contains() { return true; },
            },
        },
    };
    globalThis.window = { __NORA_REPORT_BOOT_METRICS__: () => {} };

    try {
        const controller = createWorldController({
            settingsDomain: { uiSettings: () => ({}), saveUiSettings() {}, isGenerating: () => false },
            worldRuntime: { mode: 'v2', activate: async () => calls.push('base-activated') },
            store: { read: () => ({ worldModels: [] }) },
            operations: { isBusy: () => false, run: async (_scope, operation) => operation() },
            storyScroller: { followLatest: () => () => {}, toLatest: async () => {} },
            select,
            selectAll: () => [],
            escapeHtml: value => value,
            icons: { trash: '' },
            readState: () => ({ messages: [] }),
            activeWorldModel: () => null,
            showToast: () => {},
            confirmAction: async () => false,
            normalizeError: error => error.message,
            timedUiStep: async (_name, operation) => operation(),
            recordBootMilestone: () => {},
            performanceReporter: { timedMilestone: () => {} },
            primeActiveWorldbook: async options => calls.push(options?.force ? 'worldbook-force' : 'worldbook-cache'),
            resolveCharacterCapabilities: async () => { throw new Error('v2 must not use the legacy loader'); },
            promptCharacterCapabilities: async () => { throw new Error('v2 must not use the legacy loader'); },
            loadWorldCapabilities: async () => {
                calls.push('capability-started');
                capabilityStarted.resolve();
                await capabilityRelease.promise;
                calls.push('capability-settled');
            },
            closeDrawers: () => {},
            refresh: () => calls.push('refresh'),
            refreshWorldsAfterCommit: async () => true,
            updateComposer: () => {},
            isGenerating: () => false,
        });
        let baseResolved = false;
        const opening = controller.queueSelection({
            id: 'world:v2',
            name: 'V2 World',
            characterId: 1,
            interactionId: 'v2-async',
        }).then(() => { baseResolved = true; });

        await capabilityStarted.promise;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(baseResolved, true);
        assert.deepEqual(calls.slice(0, 4), ['base-activated', 'refresh', 'worldbook-cache', 'capability-started']);

        capabilityRelease.resolve();
        await opening;
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(calls.includes('capability-settled'));
    } finally {
        capabilityRelease.resolve();
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});
