import assert from 'node:assert/strict';
import test from 'node:test';
import lodash from 'lodash';
import { z } from 'zod';
import { registerMvuSchema } from '../../../native-extensions/nora-mvu/mvu-zod.js';
import { createMvuUpdateObserver, projectMvuTransaction } from '../public/scripts/nora-compat/mvu-update-observer.js';

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
