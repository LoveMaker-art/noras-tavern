import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyLauncherStability, verifyLauncherSourceReports, launcherSourceIdentity,
    launcherStabilityOptions } from '../tooling/checks/verify-launcher-stability.mjs';
const fixtureGate = options => verifyLauncherStability({ checkEnvironment: () => ({ environment: process.env }), ...options });
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const deploymentTest = name => path.join(repositoryRoot, 'tests/deployment', `${name}.test.cjs`);

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
        'launcher_test_lifecycle', 'launcher_manual_acceptance', 'launcher_lifecycle_diagnostics', 'launcher_network_policy', 'launcher_pair_retry', 'launcher_skill_update', 'launcher_updater_policy', 'updater_task_capability', 'updater_process_identity',
        'launcher_shared_update_routes', 'launcher_shutdown', 'launcher_guidance_flow']) {
        assert.ok(calls[0].args.includes(deploymentTest(name)), name);
    }
    const javascriptFiles = calls[0].args.filter(arg => arg.endsWith('.test.cjs'));
    assert.equal(javascriptFiles.length, 25);
    assert.equal(new Set(javascriptFiles).size, javascriptFiles.length, 'Every authored file is run exactly once');
    assert.ok(javascriptFiles.every(file => path.isAbsolute(file)),
        'Forwarded test entries must also have unambiguous native process ownership');
    for (const name of ['test_first_install_transaction', 'test_managed_partial_repair', 'test_update_partial_repair',
        'test_update_recovery', 'test_update_dependency_materialization', 'test_standalone_update_entry', 'test_standalone_update_recovery', 'test_updater_task_backend', 'test_updater_task_entry', 'test_updater_skill_environment', 'test_nora_system', 'test_update_migration_contract',
        'test_update_space', 'test_update_space_contract', 'test_launcher_test_environment', 'test_manual_acceptance',
        'test_update_target', 'test_update_error_diagnostics']) {
        assert.ok(calls[1].args.includes(`tests.deployment.${name}`), name);
    }
});

test('invalid test prerequisites stop the stability gate before any test process starts', () => {
    let calls = 0;
    const cause = Object.assign(new Error('fixture Python path is gone'), { category: 'test_environment' });
    assert.throws(() => verifyLauncherStability({ checkEnvironment: () => { throw cause; }, run: () => { calls++; } }), error => error === cause);
    assert.equal(calls, 0);
});

test('Windows and Intel Mac give complete serial source groups separate bounded budgets', () => {
    for (const [platform, arch, expectedJavascript, expectedPython] of [['win32', 'x64', 900000, 480000],
        ['darwin', 'x64', 900000, 240000], ['darwin', 'arm64', 240000, 240000], ['linux', 'x64', 240000, 240000]]) {
        const calls = [];
        fixtureGate({ platform, arch, run: (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0 };
        } });
        assert.deepEqual(calls.map(call => call.options.timeout), [expectedJavascript, expectedPython]);
        assert.deepEqual(calls.map(call => call.args.slice(1,3)),
            [['--timeout-ms',String(expectedJavascript-15000)],['--timeout-ms',String(expectedPython-15000)]],
            'An internal timer leaves forced-close time before the Windows hard outer deadline');
        assert.ok(calls.every(call => call.options.killSignal === 'SIGTERM'), 'Give the bounded projection runner its child-close and export-preservation path');
        assert.equal(calls[0].args.filter(arg => arg.endsWith('.test.cjs')).length, 25);
        assert.equal(calls[1].args.filter(arg => arg.startsWith('tests.deployment.')).length, 18);
    }
    let completed = 0;
    fixtureGate({ platform: 'win32', run: (command, args, options) => {
        // The latest hosted JS group outgrew the former 600s outer budget.
        // This tests the bounded policy, not actual hosted completion.
        const required = [600001, 240001][completed++];
        return options.timeout >= required ? { status: 0 }
            : { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    } });
    assert.equal(completed, 2);
    for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64']]) for (const failingGroup of [0, 1]) {
        let group = 0;
        assert.throws(() => fixtureGate({ platform, arch, run: (command, args, options) => {
            const required = group++ === failingGroup ? options.timeout + 1 : 1;
            return required <= options.timeout ? { status: 0 }
                : { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
        } }), /Launcher source stability failed/);
        assert.equal(group, failingGroup + 1, 'A budget overrun must still stop the gate');
    }
});

test('isolated CI source steps retain finite budgets while the native report barrier only verifies evidence', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/build-integrated-launcher.yml', import.meta.url), 'utf8');
    const step = workflow.split('- name: Require launcher source stability before preparing runtimes')[1]?.split('\n      - name:')[0];
    assert.ok(step, 'The native source gate must remain present');
    assert.match(step, /timeout-minutes: 5/); assert.match(step, /--verify-reports/);
    assert.doesNotMatch(step, /updater_task_capability\.test|--group/);
    const shard = workflow.split('- name: Run the complete isolated source group')[1]?.split('\n      - name:')[0];
    assert.match(shard, /--group "\$SOURCE_GROUP" --report/);
    assert.match(shard, /matrix\.group == 'javascript'.*&& 16.*&& 9 \|\| 5/);
    for (const [outerMinutes, innerBudget] of [[16, 900000], [9, 480000], [5, 240000]])
        assert.ok(outerMinutes * 60000 > innerBudget, 'The hosted step leaves finite child-close headroom');
});

test('strict group selection partitions the exact complete serial coverage without filtering cases', () => {
    const full = [], selected = [];
    fixtureGate({ run: (_command, args) => { full.push(args); return { status: 0 }; } });
    for (const group of ['javascript', 'python']) {
        let calls = 0;
        fixtureGate({ group, run: (_command, args) => { calls++; selected.push(args); return { status: 0 }; } });
        assert.equal(calls, 1);
    }
    assert.deepEqual(selected, full);
    for (const args of [['--group', 'unknown'], ['--group'], ['--group', 'javascript', '--group', 'python'],
        ['--skip', 'anything'], ['--group=javascript'], ['--report'], ['--verify-reports', '/tmp/report', '--group', 'all']])
        assert.throws(() => launcherStabilityOptions(args));
    assert.deepEqual(launcherStabilityOptions([]), {});
    assert.deepEqual(launcherStabilityOptions(['--group', 'python', '--report', '/tmp/report.json']), { group: 'python', reportPath: '/tmp/report.json' });
});

function reportFixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-report-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = { commit: 'a'.repeat(40), sha256: 'b'.repeat(64), fileCount: 2000 };
    const environment = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'fixture/tavern',
        GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: source.commit, GITHUB_JOB: 'source-checks',
        GITHUB_WORKFLOW_REF: 'fixture/tavern/.github/workflows/build-integrated-launcher.yml@refs/heads/fixture',
        RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_NAME: 'fixture-runner' };
    const facts = { profile: 'source', node: { node: process.versions.node }, npm: { version: '11.6.2' },
        python: { version: [3, 11, 16], psutil: '7.0.0', yaml: '6.0.2' }, openssl: { version: 'OpenSSL fixture' } };
    const options = { directory, environment, identifySource: () => source,
        checkEnvironment: () => ({ environment, facts }) };
    const write = (group, extra = {}) => {
        const reportPath = path.join(directory, group + '.json');
        verifyLauncherStability({ ...options, group, reportPath, run: () => ({ status: 0 }), ...extra });
        const report = JSON.parse(fs.readFileSync(reportPath));
        report.runner.hostname = `isolated-fixture-${group}`;
        fs.writeFileSync(reportPath, JSON.stringify(report));
        return report;
    };
    return { directory, source, environment, facts, options, write };
}

test('reports bind successful full groups to source bytes, actual runtime and same workflow; failed attempts emit no report', t => {
    const f = reportFixture(t); f.write('javascript'); f.write('python');
    const reports = verifyLauncherSourceReports(f.options); assert.equal(reports.length, 2);
    assert.equal(reports[0].tests.javascript.length, 25); assert.equal(reports[1].tests.python.length, 18);
    for (const failure of [{ status: 1 }, { status: null, signal: 'SIGKILL' }, { error: new Error('timed out') }]) {
        const reportPath = path.join(f.directory, 'failed.json');
        assert.throws(() => verifyLauncherStability({ ...f.options, group: 'python', reportPath, run: () => failure }));
        assert.equal(fs.existsSync(reportPath), false);
    }
    assert.throws(() => f.write('python'), /already exists/);
});

test('source report acceptance permits retained successful jobs from earlier attempts of only the same run', t => {
    const f = reportFixture(t); f.write('javascript'); f.write('python');
    const environment = { ...f.environment, GITHUB_RUN_ATTEMPT: '2' };
    assert.equal(verifyLauncherSourceReports({ ...f.options, environment }).length, 2);
    for (const extra of [{ GITHUB_RUN_ID: '124' }, { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_SHA: 'c'.repeat(40) },
        { GITHUB_REPOSITORY: 'another/tavern' }, { GITHUB_WORKFLOW_REF: 'fixture/tavern/.github/workflows/other.yml@refs/heads/fixture' }])
        assert.throws(() => verifyLauncherSourceReports({ ...f.options, environment: { ...environment, ...extra } }));
});

test('missing, incomplete, changed, foreign and same-machine source reports all fail closed', t => {
    const f = reportFixture(t), js = f.write('javascript'), py = f.write('python');
    const file = path.join(f.directory, 'python.json');
    for (const mutate of [r => r.outcome = 'failed', r => r.group = 'javascript', r => r.tests.python.pop(),
        r => r.tests.python.push(r.tests.python[0]), r => r.source.sha256 = 'c'.repeat(64),
        r => r.source.commit = 'c'.repeat(40), r => r.platform = 'foreign', r => r.arch = 'foreign',
        r => r.workflow.runAttempt = 2, r => r.job = 'build', r => r.runtime.psutil = 'wrong', r => r.runtime.npm = '12.0.0',
        r => r.runner.environment = 'self-hosted', r => r.runner.hostname = js.runner.hostname,
        r => r.completedAt = 'not-a-completion-time', r => r.startedAt = '2100-01-01T00:00:00.000Z']) {
        const report = structuredClone(py); mutate(report); fs.writeFileSync(file, JSON.stringify(report));
        assert.throws(() => verifyLauncherSourceReports(f.options));
    }
    fs.rmSync(file); assert.throws(() => verifyLauncherSourceReports(f.options));
    fs.symlinkSync(path.join(f.directory, 'javascript.json'), file); assert.throws(() => verifyLauncherSourceReports(f.options), /Invalid source report file/);
});

test('source changes during a successful group cannot acquire an acceptance report', t => {
    const f = reportFixture(t); let reads = 0;
    assert.throws(() => f.write('javascript', { identifySource: () => ++reads === 1 ? f.source : { ...f.source, sha256: 'c'.repeat(64) } }), /changed during/);
    assert.equal(fs.existsSync(path.join(f.directory, 'javascript.json')), false);
});

test('source identity hashes tracked bytes instead of trusting commit labels or directory names', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']); fs.writeFileSync(path.join(root, 'source.js'), 'original'); git(['add', '.']);
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgSign=false', 'commit', '-qm', 'source']);
    const first = launcherSourceIdentity(root); assert.equal(first.fileCount, 1);
    fs.writeFileSync(path.join(root, 'source.js'), 'different'); assert.throws(() => launcherSourceIdentity(root), /clean committed tree/);
    git(['update-index', '--assume-unchanged', 'source.js']);
    const second = launcherSourceIdentity(root); assert.equal(second.commit, first.commit); assert.notEqual(second.sha256, first.sha256);
});
