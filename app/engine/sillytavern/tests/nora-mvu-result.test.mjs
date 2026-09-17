import assert from 'node:assert/strict';
import test from 'node:test';
import lodash from 'lodash';
import { z } from 'zod';
import { registerMvuSchema } from '../../../native-extensions/nora-mvu/mvu-zod.js';
import { createEmptyMvuUpdateStatus, createMvuUpdateObserver, projectMvuTransaction } from '../public/scripts/nora-compat/mvu-update-observer.js';

test('unobserved status matches the observer and never shares mutable validation errors', () => {
    const observer = createMvuUpdateObserver({
        eventSource: { on() {} },
        events: { VARIABLE_UPDATE_STARTED: 'start', COMMAND_PARSED: 'commands', VARIABLE_UPDATE_ENDED: 'end' },
        identity: () => 'test-chat',
    });
    const first = createEmptyMvuUpdateStatus();
    assert.deepEqual(first, observer.status());
    first.lastUpdateValidationErrors.push({ reason: 'previous failure' });
    first.updatePhase = 'failed';
    const next = createEmptyMvuUpdateStatus();
    assert.equal(next.updatePhase, 'unobserved');
    assert.deepEqual(next.lastUpdateValidationErrors, []);
    assert.deepEqual(next, observer.status());
});

test('UI and diagnostics share terminal projection without trusting a payload status', () => {
    const cases = [
        ['committed', 'updated', true, 'committed', 'completed', true],
        ['committed', 'unchanged', false, 'no-change', 'no-change', true],
        ['committed', 'skipped', false, 'skipped', 'no-command', null],
        ['failed', 'cancelled', false, 'cancelled', 'cancelled', null],
        ['failed', 'stale', false, 'stale', 'stale', null],
        ['failed', 'rejected', false, 'failed', 'failed', false],
        ['failed', 'unverified', false, 'failed', 'failed', false],
        ['failed', 'persistence-unknown', true, 'failed', 'failed', false],
    ];
    for (const [terminal, outcome, modified, status, phase, operational] of cases) {
        const detail = { outcome, status: 'spoofed', diagnostics: { modified, command_count: 1 }, persisted: false };
        const ui = projectMvuTransaction(detail, terminal);
        const observed = projectMvuTransaction(detail, terminal, 0);
        assert.deepEqual(ui, observed);
        assert.equal(ui.status, status);
        assert.equal(ui.updatePhase, phase);
        assert.equal(ui.updateOperational, operational);
        if (outcome === 'persistence-unknown') assert.equal(ui.stateChanged, null);
    }
    // Preserve historical defaults for incomplete third-party events.
    const legacy = { diagnostics: { command_count: 0 } };
    assert.equal(projectMvuTransaction(legacy).status, 'committed');
    assert.equal(projectMvuTransaction(legacy, 'committed', 0).updatePhase, 'no-change');
    const failed = projectMvuTransaction({ error: 'x'.repeat(2000), diagnostics: { errors: Array(20).fill({ content: 'x'.repeat(600) }) } }, 'failed');
    assert.equal(failed.lastUpdateError.length, 800);
    assert.equal(failed.lastUpdateValidationErrors.length, 12);
    assert.equal(failed.lastUpdateValidationErrors[0].reason.length, 400);
});

test('inline observation without execution evidence does not invent a no-change failure', () => {
    const listeners = new Map();
    const reports = [];
    const observer = createMvuUpdateObserver({
        eventSource: { on: (event, fn) => listeners.set(event, fn), off() {} },
        events: { VARIABLE_UPDATE_STARTED: 'start', COMMAND_PARSED: 'commands', VARIABLE_UPDATE_ENDED: 'end' },
        identity: () => 'test-chat', report: value => reports.push(value),
    });
    listeners.get('start')();
    listeners.get('commands')({}, [{ type: 'set', args: ['score', '50'] }]);
    listeners.get('end')({ stat_data: { score: 50 } }, { stat_data: { score: 50 } });
    assert.equal(observer.status().lastUpdateError, null);
    assert.equal(reports.length, 0);
});

test('transaction-owned end events do not traverse snapshots or override terminal evidence', () => {
    const listeners = new Map();
    const observer = createMvuUpdateObserver({
        eventSource: { on: (event, fn) => listeners.set(event, fn), off() {} },
        events: { VARIABLE_UPDATE_STARTED: 'start', COMMAND_PARSED: 'commands', VARIABLE_UPDATE_ENDED: 'end',
            TRANSACTION_STARTED: 'tx-start', TRANSACTION_COMMITTED: 'tx-commit', TRANSACTION_FAILED: 'tx-fail' },
        identity: () => 'test-chat',
    });
    let reads = 0;
    const snapshot = { get stat_data() { reads += 1; return { score: 50 }; } };
    listeners.get('tx-start')({ had_snapshot: true });
    listeners.get('end')(snapshot, snapshot);
    assert.equal(reads, 0, 'The transaction already owns final state comparison');
    assert.equal(observer.status().updatePhase, 'updating');
    listeners.get('tx-commit')({ outcome: 'unchanged', diagnostics: { command_count: 1, modified: false } });
    assert.equal(observer.status().updatePhase, 'no-change');
    // Legacy-only events still need their state comparison.
    listeners.get('start')();
    listeners.get('commands')({}, [{ type: 'set' }]);
    listeners.get('end')({ stat_data: { score: 51 } }, snapshot);
    assert.equal(reads, 1);
    assert.equal(observer.status().stateChanged, true);
    assert.equal(observer.status().updatePhase, 'unverified');
});

test('Zod reports accepted unchanged commands before consuming them', (t) => {
    const names = ['_', 'z', 'eventOn', 'registerVariableSchema'];
    const original = new Map(names.map(name => [name, globalThis[name]]));
    t.after(() => {
        for (const [name, value] of original) {
            if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
        }
    });
    const listeners = new Map();
    globalThis._ = lodash;
    globalThis.z = z;
    globalThis.eventOn = (event, fn) => listeners.set(event, fn);
    globalThis.registerVariableSchema = () => {};
    registerMvuSchema(z.object({ score: z.number() }));
    const commands = [{ type: 'set', args: ['score', '50'], full_match: '_.set("score", 50);' }];
    const diagnostics = { command_count: 1, accepted_count: 0, modified: false, errors: [] };
    listeners.get('mag_command_parsed_for_zod')({ stat_data: { score: 50 } }, commands, '', diagnostics);
    assert.equal(commands.length, 0);
    assert.equal(diagnostics.accepted_count, 1);
    assert.deepEqual(diagnostics.errors, []);
});

test('Zod rejection remains a rejection even when notifications are off', (t) => {
    const names = ['_', 'z', 'eventOn', 'registerVariableSchema'];
    const original = new Map(names.map(name => [name, globalThis[name]]));
    t.after(() => {
        for (const [name, value] of original) {
            if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
        }
    });
    const listeners = new Map();
    globalThis._ = lodash;
    globalThis.z = z;
    globalThis.eventOn = (event, fn) => listeners.set(event, fn);
    globalThis.registerVariableSchema = () => {};
    registerMvuSchema(z.object({ score: z.number() }));
    const commands = [{ type: 'set', args: ['score', '"wrong"'], full_match: '_.set("score", "wrong");' }];
    const diagnostics = { command_count: 1, accepted_count: 0, modified: false, errors: [] };
    listeners.get('mag_command_parsed_for_zod')({ stat_data: { score: 50 } }, commands, '', diagnostics);
    listeners.get('mag_command_parsed_ended_for_zod')({}, commands);
    assert.equal(diagnostics.accepted_count, 0);
    assert.equal(diagnostics.errors.length, 1);
});

test('legacy insert infers a missing container from schema, not argument count', (t) => {
    const names = ['_', 'z', 'eventOn', 'registerVariableSchema'];
    const original = new Map(names.map(name => [name, globalThis[name]]));
    t.after(() => original.forEach((value, name) => {
        if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }));
    const listeners = new Map();
    Object.assign(globalThis, { _: lodash, z, eventOn: (name, fn) => listeners.set(name, fn), registerVariableSchema() {} });
    registerMvuSchema(z.object({
        records: z.record(z.string(), z.object({ score: z.number() })).nullish(),
        items: z.array(z.string()).nullish(),
    }));
    const cases = [
        [{}, ['records', { new: { score: 1 } }], { records: { new: { score: 1 } } }],
        [{}, ['records', 'new', { score: 1 }], { records: { new: { score: 1 } } }],
        [{}, ['items', 0, 'entry'], { items: ['entry'] }],
        [{ items: null }, ['items', 'entry'], { items: ['entry'] }],
        [{ items: ['a'] }, ['items', '-', 'b'], { items: ['a', 'b'] }],
        [{ records: { old: { score: 2 } } }, ['records', { new: { score: 1 } }], { records: { old: { score: 2 }, new: { score: 1 } } }],
    ];
    for (const [initial, args, expected] of cases) {
        const variables = { stat_data: structuredClone(initial) };
        const commands = [{ type: 'insert', args }];
        const diagnostics = { accepted_count: 0, errors: [] };
        listeners.get('mag_command_parsed_for_zod')(variables, commands, '', diagnostics);
        assert.deepEqual(variables.stat_data, expected);
        assert.equal(diagnostics.accepted_count, 1);
        assert.deepEqual(diagnostics.errors, [], 'failed object probe is not a rejected command');
    }
    const variables = { stat_data: {} };
    const diagnostics = { accepted_count: 0, errors: [] };
    listeners.get('mag_command_parsed_for_zod')(variables, [{ type: 'insert', args: ['items', 0, 7] }], '', diagnostics);
    assert.deepEqual(variables.stat_data, {}, 'failed probes never leak candidate state');
    assert.equal(diagnostics.accepted_count, 0);
    assert.equal(diagnostics.errors.length, 1);
});

test('persisted partial transactions are visible as partial, never full success or total failure', () => {
    const detail = { outcome: 'partial', persisted: true, error_code: 'MVU_COMMAND_VALIDATION_FAILED',
        diagnostics: { command_count: 3, accepted_count: 2, modified: true, errors: [{ command: 'set', content: 'enum mismatch' }] } };
    for (const terminal of ['committed', 'failed']) {
        const result = projectMvuTransaction(detail, terminal);
        assert.equal(result.status, 'partial');
        assert.equal(result.updatePhase, 'partial');
        assert.equal(result.updateOperational, false, 'partial is not all commands accepted');
        assert.equal(result.lastUpdateAcceptedCount, 2);
        assert.equal(result.lastUpdatePersisted, true);
        assert.equal(result.stateChanged, true);
        assert.equal(result.lastUpdateValidationErrors.length, 1);
    }
    assert.equal(projectMvuTransaction({ ...detail, persisted: false }, 'failed').status, 'failed');
});
