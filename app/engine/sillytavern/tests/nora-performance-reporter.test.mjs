import assert from 'node:assert/strict';
import test from 'node:test';

import { createPerformanceReporter } from '../../../native-extensions/nora-ui/performance-reporter.js';

test('records a timed step and reports only the first generation', async () => {
    const metrics = { startedAt: 10, milestones: [], steps: [] };
    const clock = [20, 35, 36, 50, 51];
    const phases = [];
    const reporter = createPerformanceReporter({
        getMetrics: () => metrics,
        reportPhase: phase => phases.push(phase),
        now: () => clock.shift(),
    });

    assert.equal(await reporter.step('nora.test', async () => 'done'), 'done');
    reporter.firstGeneration({ duration: 1_200.04, mode: 'send', status: 'completed' });
    reporter.firstGeneration({ duration: 900, mode: 'regenerate', status: 'completed' });

    assert.deepEqual(metrics.steps, [{
        name: 'nora.test',
        startedAt: 10,
        endedAt: 25,
        duration: 16,
        status: 'ok',
    }]);
    assert.deepEqual(metrics.milestones, [{
        name: 'first-generation-settled',
        at: 40,
        duration: 1_200,
        mode: 'send',
        status: 'completed',
    }]);
    assert.deepEqual(phases, ['first-interaction']);
});

test('records the first genuinely usable state with its readiness evidence', () => {
    const metrics = { startedAt: 10, milestones: [], steps: [] };
    const phases = [];
    const reporter = createPerformanceReporter({
        getMetrics: () => metrics,
        reportPhase: phase => phases.push(phase),
        now: () => 4_210,
    });

    reporter.usable({
        activeWorld: true,
        renderedMessages: 61,
        composerEnabled: true,
        criticalExtensionsReady: true,
    });
    reporter.usable({ activeWorld: false });

    assert.deepEqual(metrics.milestones, [{
        name: 'nora-usable',
        at: 4_200,
        activeWorld: true,
        renderedMessages: 61,
        composerEnabled: true,
        criticalExtensionsReady: true,
    }]);
    assert.deepEqual(phases, ['nora-usable']);
});

test('keeps visible-shell and hydrated-runtime milestones separate', () => {
    const metrics = { startedAt: 10, shellReadyAt: 120, milestones: [], steps: [] };
    const reporter = createPerformanceReporter({ getMetrics: () => metrics, now: () => 410 });

    assert.deepEqual(reporter.hydrateShell({ alreadyVisible: true }), { shellReadyAt: 120, hydratedAt: 400 });
    assert.equal(metrics.hydratedAt, 400);
    assert.deepEqual(metrics.milestones, [{ name: 'shell-hydrated', at: 400 }]);
});
