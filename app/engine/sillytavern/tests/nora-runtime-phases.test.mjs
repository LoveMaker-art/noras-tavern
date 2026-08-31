import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseRuntimePhases,
    summarizeRuntimePhases,
} from '../../../../ops/scripts/analyze-runtime-phases.mjs';

function event(runId, mode, phase, durationMs, status = 'ok') {
    return `[NORA_RUNTIME_PHASE] ${JSON.stringify({ runId, mode, phase, durationMs, status })}`;
}

test('keeps delivery, native, World, capability, and import timings separate', () => {
    const log = [
        event('cold-1', 'cold', 'delivery.download', 2_100),
        event('cold-1', 'cold', 'native.spawn-to-health', 1_400),
        event('cold-1', 'cold', 'world.base-open', 3_200),
        event('cold-1', 'cold', 'world.capabilities', 5_000, 'degraded'),
        event('cold-1', 'cold', 'import.parse', 800),
        event('warm-1', 'warm', 'world.base-open', 900),
        'noise',
        '[NORA_RUNTIME_PHASE] {partial',
    ].join('\n');

    const summary = summarizeRuntimePhases(parseRuntimePhases(log));

    assert.equal(summary.runs, 2);
    assert.deepEqual(summary.modes, ['cold', 'warm']);
    assert.equal(summary.phases.length, 6);
    assert.deepEqual(summary.phases.find(item => item.phase === 'world.capabilities').statuses, { degraded: 1 });
    assert.equal(summary.phases.find(item => item.mode === 'cold' && item.phase === 'world.base-open').p95, 3_200);
    assert.equal(summary.phases.find(item => item.mode === 'warm' && item.phase === 'world.base-open').p50, 900);
});

test('does not treat malformed or incomplete events as timing samples', () => {
    const events = parseRuntimePhases([
        '[NORA_RUNTIME_PHASE] {"runId":"x","phase":"world.base-open"}',
        '[NORA_RUNTIME_PHASE] {"phase":"world.base-open","durationMs":10}',
        '[NORA_RUNTIME_PHASE] not-json',
    ].join('\n'));

    assert.deepEqual(events, []);
});
