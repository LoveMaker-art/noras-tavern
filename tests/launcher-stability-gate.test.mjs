import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { verifyLauncherStability } from '../tooling/checks/verify-launcher-stability.mjs';
const fixtureGate = options => verifyLauncherStability({ checkEnvironment: () => ({ environment: process.env }), ...options });

test('a failed, killed or timed-out source check cannot pass the launcher stability gate', () => {
    for (const failure of [{ status: 1 }, { status: null, signal: 'SIGKILL' },
        { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }]) {
        let calls = 0;
        assert.throws(() => fixtureGate({ run: () => { calls++; return failure; } }), /Launcher source stability failed/);
        assert.equal(calls, 1, 'Stop at the failure instead of reaching the next check');
    }
    let calls = 0;
    assert.throws(() => fixtureGate({ run: () => ({ status: ++calls === 2 ? 1 : 0 }) }),
        /installation and system transaction recovery/);
    assert.equal(calls, 2, 'Python recovery failures must also block the gate');
});

test('the stability gate exercises both existing maintenance entry points without filtered cases', () => {
    const calls = [];
    fixtureGate({ run: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; } });
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.command, process.execPath);
        assert.ok(path.isAbsolute(call.args[0]) && call.args[0].endsWith(path.join('tooling','run.mjs')),
            'The Windows service inspector must be able to locate every live runner entry');
        assert.ok(!call.args.some(value => value.startsWith('--test-name-pattern') || value.startsWith('--skip')));
    }
    assert.ok(calls[0].args.includes('--test-concurrency=1'));
    for (const name of ['launcher_process_output', 'launcher_operation_state', 'launcher_managed_partial_repair', 'launcher_uninstall',
        'launcher_test_lifecycle', 'launcher_manual_acceptance', 'launcher_lifecycle_diagnostics', 'launcher_network_policy']) {
        assert.ok(calls[0].args.includes(`tests/deployment/${name}.test.cjs`), name);
    }
    for (const name of ['test_first_install_transaction', 'test_managed_partial_repair', 'test_update_partial_repair',
        'test_update_recovery', 'test_nora_system', 'test_update_migration_contract',
        'test_update_space', 'test_update_space_contract', 'test_launcher_test_environment', 'test_manual_acceptance']) {
        assert.ok(calls[1].args.includes(`tests.deployment.${name}`), name);
    }
});

test('invalid test prerequisites stop the stability gate before any test process starts', () => {
    let calls = 0;
    const cause = Object.assign(new Error('fixture Python path is gone'), { category: 'test_environment' });
    assert.throws(() => verifyLauncherStability({ checkEnvironment: () => { throw cause; }, run: () => { calls++; } }), error => error === cause);
    assert.equal(calls, 0);
});

test('Windows gives the complete serial source groups separate bounded budgets', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
        const calls = [];
        fixtureGate({ platform, run: (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0 };
        } });
        assert.deepEqual(calls.map(call => call.options.timeout), platform === 'win32' ? [480000, 240000] : [240000, 240000]);
        assert.equal(calls[0].args.filter(arg => arg.startsWith('tests/deployment/')).length, 17);
        assert.equal(calls[1].args.filter(arg => arg.startsWith('tests.deployment.')).length, 10);
    }
    let completed = 0;
    fixtureGate({ platform: 'win32', run: (command, args, options) => {
        // Full native execution took 171s/53s. Comparable hosted Windows cases
        // were 1.878 times slower: the old 240s JS budget cannot cover that run.
        const required = [320000, 100000][completed++];
        return options.timeout >= required ? { status: 0 }
            : { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    } });
    assert.equal(completed, 2);
    for (const failingGroup of [0, 1]) {
        let group = 0;
        assert.throws(() => fixtureGate({ platform: 'win32', run: (command, args, options) => {
            const required = group++ === failingGroup ? options.timeout + 1 : 1;
            return required <= options.timeout ? { status: 0 }
                : { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
        } }), /Launcher source stability failed/);
        assert.equal(group, failingGroup + 1, 'A budget overrun must still stop the gate');
    }
});

test('the Windows CI source step leaves finite setup headroom above both group budgets', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/build-integrated-launcher.yml', import.meta.url), 'utf8');
    const step = workflow.split('- name: Require launcher source stability before preparing runtimes')[1]?.split('\n      - name:')[0];
    assert.ok(step, 'The native source gate must remain present');
    assert.match(step, /timeout-minutes: \$\{\{ runner\.os == 'Windows' && 15 \|\| 10 \}\}/);
});
