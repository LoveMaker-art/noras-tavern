import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { checkLauncherTestEnvironment } from './launcher-test-environment.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

// Source fixtures exercise real plans, operation records and isolated file trees.
// They do not accept a packaged APP, an installer or the production network.
const javascript = [
    'launcher_install_source.test.cjs',
    'launcher_release_plan.test.cjs',
    'launcher_process_output.test.cjs',
    'launcher_diagnostics.test.cjs',
    'launcher_lifecycle_diagnostics.test.cjs',
    'launcher_network_policy.test.cjs',
    'launcher_operation_state.test.cjs',
    'launcher_operation_result.test.cjs',
    'launcher_pair_retry.test.cjs',
    'launcher_operation_cli.test.cjs',
    'launcher_skill_update.test.cjs',
    'launcher_shared_update_routes.test.cjs',
    'launcher_shutdown.test.cjs',
    'launcher_guidance_flow.test.cjs',
    'launcher_updater_policy.test.cjs',
    'updater_task_capability.test.cjs',
    'updater_process_identity.test.cjs',
    'launcher_managed_partial_repair.test.cjs',
    'launcher_recovery_route.test.cjs',
    'launcher_retry_conditions.test.cjs',
    'launcher_runtime_transaction.test.cjs',
    'launcher_update_executor.test.cjs',
    'launcher_uninstall.test.cjs',
    'launcher_test_lifecycle.test.cjs',
    'launcher_manual_acceptance.test.cjs',
];
const python = [
    'test_first_install_transaction',
    'test_managed_partial_repair',
    'test_update_partial_repair',
    'test_update_recovery',
    'test_update_dependency_materialization',
    'test_standalone_update_entry',
    'test_standalone_update_recovery',
    'test_updater_task_backend',
    'test_updater_task_entry',
    'test_updater_skill_environment',
    'test_nora_system',
    'test_update_migration_contract',
    'test_update_space',
    'test_update_space_contract',
    'test_launcher_test_environment',
    'test_manual_acceptance',
    'test_update_target',
    'test_update_error_diagnostics',
];

const groups = Object.freeze({ javascript, python });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const validGroup = group => assert.ok(['all', ...Object.keys(groups)].includes(group), 'Unknown launcher source group');
export function launcherSourceIdentity(root = sourceRoot) {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const commit = git(['rev-parse', 'HEAD']).trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(git(['status', '--porcelain', '--untracked-files=all']).trim(), '', 'Source reports require a clean committed tree');
    const files = git(['ls-files', '-z']).split('\0').filter(Boolean).sort();
    assert.ok(files.length > 0, 'Empty source identity');
    const hash = crypto.createHash('sha256');
    for (const file of files) {
        assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), 'Invalid source identity path');
        const target = path.join(root, file), stat = fs.lstatSync(target);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Source identity requires a regular tracked file: ${file}`);
        hash.update(JSON.stringify([file, stat.size, digest(fs.readFileSync(target))]) + '\n');
    }
    return { commit, sha256: hash.digest('hex'), fileCount: files.length };
}
function workflowContext(environment, identity) {
    assert.equal(environment.GITHUB_ACTIONS, 'true', 'Source reports require a GitHub workflow context');
    assert.match(environment.GITHUB_REPOSITORY || '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(environment[key] || '', /^[1-9][0-9]*$/);
    assert.equal(environment.GITHUB_SHA, identity.commit, 'Source report checkout differs from the workflow commit');
    const workflowRef = environment.GITHUB_WORKFLOW_REF;
    assert.ok(typeof workflowRef === 'string' && workflowRef.startsWith(environment.GITHUB_REPOSITORY
        + '/.github/workflows/build-integrated-launcher.yml@'), 'Source report workflow identity differs');
    const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
    assert.ok(Number.isSafeInteger(runAttempt), 'Invalid source workflow attempt');
    return { repository: environment.GITHUB_REPOSITORY, runId: environment.GITHUB_RUN_ID, runAttempt, workflowRef };
}
function runtimeIdentity(facts) {
    assert.ok(facts?.profile === 'source' && /^24\./.test(facts.node?.node || '')
        && Array.isArray(facts.python?.version) && facts.python.version[0] === 3 && facts.python.version[1] >= 11
        && facts.python.psutil === '7.0.0' && facts.python.yaml === '6.0.2' && typeof facts.openssl?.version === 'string',
    'Source report prerequisite evidence is incomplete or differs from the pinned versions');
    assert.match(facts.npm?.version || '', /^\d+\.\d+\.\d+$/, 'Source report npm prerequisite evidence is missing');
    return { node: facts.node.node, nodeAbi: process.versions.modules, npm: facts.npm.version, python: facts.python.version,
        psutil: facts.python.psutil, yaml: facts.python.yaml, openssl: facts.openssl.version };
}
export function verifyLauncherSourceReports({ root = sourceRoot, directory, environment = process.env,
    platform = process.platform, arch = process.arch, identifySource = launcherSourceIdentity,
    checkEnvironment = checkLauncherTestEnvironment } = {}) {
    assert.ok(typeof directory === 'string' && path.isAbsolute(directory), 'An absolute source report directory is required');
    const source = identifySource(root), context = workflowContext(environment, source);
    const runtime = runtimeIdentity(checkEnvironment({ root, profile: 'source', environment }).facts);
    const reports = [];
    for (const [group, tests] of Object.entries(groups)) {
        const file = path.join(directory, group + '.json'), stat = fs.lstatSync(file);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024 * 1024, 'Invalid source report file');
        const report = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(report.schema, 'nora-launcher-source-stability/1');
        assert.equal(report.outcome, 'passed'); assert.equal(report.group, group);
        assert.equal(report.platform, platform); assert.equal(report.arch, arch);
        assert.ok(isDeepStrictEqual(report.source, source), 'Source report bytes differ from this frozen checkout');
        assert.ok(isDeepStrictEqual(report.tests, { [group]: tests }), 'Source report is missing or filtering required coverage');
        for (const key of ['repository', 'runId', 'workflowRef']) assert.equal(report.workflow?.[key], context[key], `Source report ${key} differs`);
        assert.ok(Number.isSafeInteger(report.workflow?.runAttempt) && report.workflow.runAttempt >= 1
            && report.workflow.runAttempt <= context.runAttempt, 'Source report comes from an invalid or future workflow attempt');
        assert.equal(report.job, 'source-checks', 'Source report did not come from the isolated source job');
        assert.ok(isDeepStrictEqual(report.runtime, runtime), 'Source report runtime differs from the build source environment');
        assert.equal(report.runner?.environment, 'github-hosted', 'Source groups require independent hosted runners');
        assert.ok(typeof report.runner.name === 'string' && report.runner.name.length > 0
            && typeof report.runner.hostname === 'string' && report.runner.hostname.length > 0, 'Source report runner identity is missing');
        assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.completedAt))
            && Date.parse(report.completedAt) >= Date.parse(report.startedAt), 'Source report has invalid completion times');
        reports.push(report);
    }
    assert.notEqual(reports[0].runner.hostname, reports[1].runner.hostname, 'Source groups must not share one machine process census');
    assert.ok(isDeepStrictEqual(identifySource(root), source), 'Source bytes changed during report verification');
    return reports;
}

export function verifyLauncherStability({ root = sourceRoot, run = spawnSync, checkEnvironment = checkLauncherTestEnvironment,
    platform = process.platform, arch = process.arch, group = 'all', reportPath,
    environment: workflowEnvironment = process.env, identifySource = launcherSourceIdentity } = {}) {
    validGroup(group);
    let source, context;
    if (reportPath !== undefined) {
        assert.ok(path.isAbsolute(reportPath), 'An absolute source report path is required');
        assert.ok(!fs.existsSync(reportPath), 'Source report already exists');
        source = identifySource(root); context = workflowContext(workflowEnvironment, source);
        assert.equal(workflowEnvironment.GITHUB_JOB, 'source-checks', 'Source reports must be produced by the isolated source job');
        assert.equal(workflowEnvironment.RUNNER_ENVIRONMENT, 'github-hosted', 'Source groups require independent hosted runners');
        assert.equal(platform, process.platform); assert.equal(arch, process.arch);
    }
    const { environment, facts } = checkEnvironment({ root, profile: 'source', environment: workflowEnvironment });
    const runtime = reportPath === undefined ? undefined : runtimeIdentity(facts);
    const startedAt = new Date().toISOString(), completed = {};
    // Run 38546128125 cut the still-progressing Windows JS group at its
    // 585s internal limit. The same complete groups passed on native Windows
    // in 201.542s / 63.909s; 394 matched cases were median 2.76x slower on CI.
    // Allow finite hosted-runner headroom without removing or filtering cases.
    // Intel run 38555193731 likewise cancelled the still-progressing JS group
    // at 465s: 679 passed, no failed assertions, two interrupted files. Keep
    // the complete serial group and finite deadline; hosted completion still
    // has to establish its actual elapsed time on each platform.
    const javascriptTimeout = platform === 'win32' || platform === 'darwin' && arch === 'x64' ? 900000 : 240000;
    const pythonTimeout = platform === 'win32' ? 480000 : 240000;
    for (const [selected, scope, args, timeout] of [
        ['javascript', 'launcher plans, results, recovery and uninstall', ['node', '--test', '--test-concurrency=1',
            ...javascript.map(name => path.join(root, 'tests/deployment', name))], javascriptTimeout],
        ['python', 'installation and system transaction recovery', ['python', '-B', '-m', 'unittest',
            ...python.map(name => `tests.deployment.${name}`)], pythonTimeout],
    ]) {
        if (group !== 'all' && group !== selected) continue;
        const result = run(process.execPath, [path.join(root, 'tooling/run.mjs'), '--timeout-ms', String(timeout - 15000), ...args], {
            // Windows TERM kills the wrapper itself. The earlier internal
            // deadline closes its held child without depending on OS signals.
            cwd: root, stdio: 'inherit', timeout, killSignal: 'SIGTERM',
            env: environment,
        });
        if (result.error) throw new Error(`Launcher source stability failed (${scope}): ${result.error.message}`, { cause: result.error });
        if (result.status !== 0 || result.signal) {
            throw new Error(`Launcher source stability failed (${scope}): ${result.signal || result.status}`);
        }
        completed[selected] = groups[selected];
    }
    if (reportPath !== undefined) {
        assert.ok(isDeepStrictEqual(identifySource(root), source), 'Source bytes changed during stability checks');
        const report = { schema: 'nora-launcher-source-stability/1', outcome: 'passed', group, platform, arch,
            source, tests: completed, workflow: context, job: workflowEnvironment.GITHUB_JOB,
            runner: { environment: workflowEnvironment.RUNNER_ENVIRONMENT, name: workflowEnvironment.RUNNER_NAME,
                hostname: os.hostname() }, runtime, startedAt, completedAt: new Date().toISOString() };
        assert.ok(typeof report.runner.name === 'string' && report.runner.name.length > 0, 'Source runner name is missing');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
}

export function launcherStabilityOptions(args) {
    const options = {}, seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index], value = args[index + 1];
        assert.ok(['--group', '--report', '--verify-reports'].includes(key) && !seen.has(key)
            && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'Invalid launcher source arguments');
        seen.add(key); options[key === '--group' ? 'group' : key === '--report' ? 'reportPath' : 'directory'] = value;
    }
    validGroup(options.group || 'all');
    assert.ok(!options.directory || !options.group && !options.reportPath, 'Report verification cannot run or filter source tests');
    return options;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try {
        const options = launcherStabilityOptions(process.argv.slice(2));
        if (options.directory) verifyLauncherSourceReports(options);
        else verifyLauncherStability(options);
        console.log('Launcher source stability checks passed; packaged user workflows remain separate acceptance requirements.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = error.category === 'test_environment' ? 2 : 1;
    }
}
