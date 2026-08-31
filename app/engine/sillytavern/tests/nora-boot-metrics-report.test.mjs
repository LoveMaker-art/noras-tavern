import assert from 'node:assert/strict';
import test from 'node:test';

import {
    diagnoseBootSession,
    parseBootMetrics,
    selectRecentBootSessions,
    summarizeBootMetrics,
} from '../../../../ops/scripts/analyze-boot-metrics.mjs';

function event(sessionId, capturedAt, milestones, steps = []) {
    return `[NORA_BOOT_METRICS] ${JSON.stringify({
        phase: 'nora-runtime-ready',
        metrics: { sessionId, capturedAt, readyAt: 300, milestones, steps },
    })}`;
}

test('summarizes each page session once and ignores later manual world timing', () => {
    const log = [
        'unrelated output',
        event('one', 500, [
            { name: 'shell-rendered', at: 20 },
            { name: 'world-selected', interactionId: 'initial-world', at: 420 },
            { name: 'nora-runtime-ready', at: 500 },
        ], [{ name: 'extensions-critical', duration: 80 }]),
        event('one', 60_000, [
            { name: 'shell-rendered', at: 20 },
            { name: 'world-selected', interactionId: 'initial-world', at: 420 },
            { name: 'nora-runtime-ready', at: 500 },
            { name: 'nora-usable', at: 4_800 },
            { name: 'world-selected', interactionId: 'world-later', at: 60_000 },
            { name: 'first-generation-settled', duration: 1_200, status: 'completed' },
        ], [
            { name: 'extensions-critical', duration: 80 },
            { name: 'nora.world-select.world-later.character-chat', duration: 20_000 },
        ]),
    ].join('\n');

    const summary = summarizeBootMetrics(parseBootMetrics(log));

    assert.equal(summary.sessions, 1);
    assert.equal(summary.timings.initialWorldReady.p50, 420);
    assert.equal(summary.timings.runtimeReady.p50, 500);
    assert.equal(summary.timings.usable.p50, 4_800);
    assert.equal(summary.usableBudget.targetMs, 5_000);
    assert.equal(summary.usableBudget.passed, 1);
    assert.equal(summary.usableBudget.failed, 0);
    assert.equal(summary.usableBudget.passRate, 1);
    assert.equal(summary.timings.firstGeneration.p50, 1_200);
    assert.equal(summary.slowSteps.some(step => step.name.includes('world-later')), false);
});

test('reports sessions that never became usable or exceeded the five second budget', () => {
    const log = [
        event('fast', 4_500, [{ name: 'nora-usable', at: 4_500 }]),
        event('slow', 7_000, [{ name: 'nora-usable', at: 7_000 }]),
        event('missing', 9_000, [{ name: 'nora-runtime-ready', at: 9_000 }]),
    ].join('\n');

    const summary = summarizeBootMetrics(parseBootMetrics(log));

    assert.equal(summary.timings.usable.samples, 2);
    assert.deepEqual(summary.usableBudget, {
        targetMs: 5_000,
        passed: 1,
        failed: 1,
        missing: 1,
        passRate: 0.5,
    });
});

test('reports sessions that activated the initial world more than once', () => {
    const milestones = [
        { name: 'world-selected', interactionId: 'initial-world', at: 400 },
        { name: 'world-selected', interactionId: 'initial-world', at: 470 },
    ];

    const summary = summarizeBootMetrics(parseBootMetrics(event('duplicate', 500, milestones)));

    assert.equal(summary.duplicateInitialWorldSessions, 1);
});

test('derives initial world readiness from timed steps in older logs', () => {
    const summary = summarizeBootMetrics(parseBootMetrics(event('legacy', 500, [], [
        { name: 'nora.world-select.initial-world.character-chat', endedAt: 410, duration: 90 },
        { name: 'nora.world-select.initial-world.worldbook', endedAt: 425, duration: 15 },
    ])));

    assert.equal(summary.timings.initialWorldReady.p50, 425);
});

test('parses dedicated telemetry NDJSON without relying on console log markers', () => {
    const line = JSON.stringify({
        schemaVersion: 1,
        kind: 'client-summary',
        phase: 'nora-usable',
        traceId: 'structured',
        metrics: { sessionId: 'structured', capturedAt: 4_200, milestones: [{ name: 'nora-usable', at: 4_200 }] },
    });

    const events = parseBootMetrics(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].metrics.sessionId, 'structured');
});

test('attributes slow sessions to measured backend, compatibility, main-thread, or transfer evidence', () => {
    const base = {
        sessionId: 'slow',
        capturedAt: 9_000,
        milestones: [{ name: 'nora-usable', at: 9_000 }],
        resources: [],
        steps: [],
        longTasks: [],
    };

    const apiResource = { name: '/api/nora-worlds-v2/worlds', start: 100, responseEnd: 2_500, duration: 2_400, downloadDuration: 10, decodedBodySize: 100, source: 'network' };
    assert.equal(diagnoseBootSession({ metrics: { ...base, resources: [apiResource] } }, [{ path: apiResource.name, durationMs: 2_100 }]).primaryCause, 'backend');
    assert.equal(diagnoseBootSession({ metrics: { ...base, steps: [{ name: 'nora.world-select.initial-world.mvu-runtime', startedAt: 1_000, endedAt: 3_200, duration: 2_200 }] } }, []).primaryCause, 'compatibility-runtime');
    assert.equal(diagnoseBootSession({ metrics: { ...base, longTasks: [{ duration: 1_700 }] } }, []).primaryCause, 'main-thread');
    assert.equal(diagnoseBootSession({ metrics: {
        ...base,
        resources: [{ name: '/assets/app.js', start: 100, responseEnd: 2_500, duration: 2_400, downloadDuration: 2_000, decodedBodySize: 2_000_000, source: 'network' }],
    } }, []).primaryCause, 'payload-transfer');
});

test('does not blame compatibility work that starts after the product is already usable', () => {
    const metrics = {
        sessionId: 'background', capturedAt: 20_000,
        milestones: [{ name: 'nora-usable', at: 5_000 }],
        resources: [], longTasks: [],
        steps: [{ name: 'nora.world-select.initial-world.capabilities', startedAt: 5_100, endedAt: 20_000, duration: 14_900 }],
    };
    const result = diagnoseBootSession({ metrics }, []);
    assert.equal(result.primaryCause, 'within-budget');
    assert.equal(result.signals.blockingStepCount, 0);
    assert.equal(result.signals.backgroundStepCount, 1);
    assert.equal(result.signals.backgroundMaxMs, 14_900);
});

test('keeps explicitly background lifecycle spans out of the blocking diagnosis even when they start before usable', () => {
    const metrics = {
        sessionId: 'overlap', capturedAt: 15_000,
        milestones: [{ name: 'nora-usable', at: 5_000 }], resources: [], longTasks: [],
        steps: [{ name: 'world.snapshot.runtime.background.event.chat-loaded', startedAt: 4_800, endedAt: 14_800, duration: 10_000 }],
    };
    const result = diagnoseBootSession({ metrics }, []);
    assert.equal(result.primaryCause, 'within-budget');
    assert.equal(result.signals.blockingStepCount, 0);
    assert.equal(result.signals.backgroundStepCount, 1);
});

test('selects recent client sessions together with their server spans', () => {
    const events = [
        { kind: 'client-summary', receivedAt: '2026-08-29T00:00:00Z', traceId: 'old', metrics: { sessionId: 'old' } },
        { kind: 'server-span', traceId: 'old', durationMs: 10 },
        { kind: 'client-summary', receivedAt: '2026-08-30T00:00:00Z', traceId: 'new', metrics: { sessionId: 'new' } },
        { kind: 'server-span', traceId: 'new', durationMs: 20 },
    ];

    assert.deepEqual(selectRecentBootSessions(events, 1).map(event => event.traceId), ['new', 'new']);
});
