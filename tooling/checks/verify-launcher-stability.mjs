import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkLauncherTestEnvironment } from './launcher-test-environment.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

// Source fixtures exercise real plans, operation records and isolated file trees.
// They do not accept a packaged APP, an installer or the production network.
const sourceGroups = {
    setup: {
        javascript: [
            'launcher_install_source.test.cjs',
            'launcher_pair_retry.test.cjs',
            'launcher_guidance_flow.test.cjs',
            'launcher_managed_partial_repair.test.cjs',
        ],
        python: [
            'test_first_install',
            'test_first_install_transaction',
            'test_managed_partial_repair',
            'test_nora_system',
            'test_model_candidate_commit',
        ],
    },
    'app-update': {
        javascript: [
            'launcher_release_plan.test.cjs',
            'launcher_app_plan.test.cjs',
            'launcher_app_helper_runtime.test.cjs',
            'launcher_app_helper_guard.test.cjs',
            'launcher_app_update_module.test.cjs',
            'launcher_app_only_update.test.cjs',
            'launcher_self_update.test.cjs',
            'launcher_handoff_diagnostics.test.cjs',
            'launcher_network_policy.test.cjs',
            'launcher_shared_update_routes.test.cjs',
            'launcher_recovery_route.test.cjs',
            'launcher_update_executor.test.cjs',
        ],
        python: [],
    },
    lifecycle: {
        javascript: [
            'launcher_process_output.test.cjs',
            'launcher_diagnostics.test.cjs',
            'launcher_lifecycle_diagnostics.test.cjs',
            'launcher_operation_state.test.cjs',
            'launcher_operation_result.test.cjs',
            'launcher_windows_terminal.test.cjs',
            'launcher_shutdown.test.cjs',
            'launcher_retry_conditions.test.cjs',
            'launcher_runtime_transaction.test.cjs',
            'launcher_uninstall.test.cjs',
            'launcher_test_lifecycle.test.cjs',
            'launcher_manual_acceptance.test.cjs',
        ],
        python: [
            'test_operation_control',
            'test_launcher_test_environment',
            'test_manual_acceptance',
        ],
    },
    'core-maintenance': {
        javascript: [
            'launcher_operation_cli.test.cjs',
            'launcher_skill_update.test.cjs',
            'cloud_core_release.test.cjs',
            'launcher_updater_policy.test.cjs',
            'updater_task_capability.test.cjs',
            'updater_process_identity.test.cjs',
        ],
        python: [
            'test_update_partial_repair',
            'test_update_recovery',
            'test_update_dependency_materialization',
            'test_standalone_update_entry',
            'test_standalone_update_recovery',
            'test_updater_task_backend',
            'test_updater_task_entry',
            'test_updater_skill_environment',
            'test_cloud_instance_paths',
            'test_cloud_lifecycle_cli',
            'test_cloud_volume_recovery',
            'test_update_migration_contract',
            'test_update_space',
            'test_update_space_contract',
            'test_update_target',
            'test_update_error_diagnostics',
        ],
    },
};

function selectSourceTests(group) {
    if (Object.hasOwn(sourceGroups, group)) return sourceGroups[group];
    if (group !== undefined && group !== 'javascript' && group !== 'python')
        throw new Error(`Unknown launcher source test group: ${group}`);
    const groups = Object.values(sourceGroups);
    return {
        javascript: group === 'python' ? [] : groups.flatMap(tests => tests.javascript),
        python: group === 'javascript' ? [] : groups.flatMap(tests => tests.python),
    };
}

export function verifyLauncherStability({ root = sourceRoot, run = spawnSync, checkEnvironment = checkLauncherTestEnvironment, group,
    platform = process.platform, arch = process.arch } = {}) {
    const { javascript, python } = selectSourceTests(group);
    const { environment } = checkEnvironment({
        root, profile: 'source', requireEngineFixture: python.includes('test_update_recovery'),
    });
    // Run 38546128125 cut the still-progressing Windows JS group at its
    // 585s internal limit. The same complete groups passed on native Windows
    // in 201.542s / 63.909s; 394 matched cases were median 2.76x slower on CI.
    // Allow finite hosted-runner headroom without removing or filtering cases.
    // Intel run 38555193731 likewise cancelled the still-progressing JS group
    // at 465s: 679 passed, no failed assertions, two interrupted files. Keep
    // the complete serial group and finite deadline; hosted completion still
    // has to establish its actual elapsed time on each platform.
    // ARM run 41385600207 also reached its 225s internal cutoff while
    // progressing: 992 passed, no failed assertions. Bound the full group
    // at 345s internally; keep per-case limits and child-close checks intact.
    const javascriptTimeout = platform === 'win32' || platform === 'darwin' && arch === 'x64' ? 900000
        : platform === 'darwin' ? 360000 : 240000;
    const pythonTimeout = platform === 'win32' ? 480000 : 240000;
    for (const [scope, files, args, timeout] of [
        ['launcher plans, results, recovery and uninstall', javascript, ['node', '--test', '--test-concurrency=1',
            ...javascript.map(name => path.join(root, 'tests/deployment', name))], javascriptTimeout],
        ['installation and system transaction recovery', python, ['python', '-B', '-m', 'unittest',
            ...python.map(name => `tests.deployment.${name}`)], pythonTimeout],
    ]) {
        if (!files.length) continue;
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
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    try {
        const args = process.argv.slice(2);
        if (args.length && (args.length !== 2 || args[0] !== '--group' || !args[1]))
            throw new Error(`Usage: verify-launcher-stability.mjs [--group ${[...Object.keys(sourceGroups), 'javascript', 'python'].join('|')}]`);
        const group = args[1];
        verifyLauncherStability({ group });
        console.log(group ? `Launcher source test group passed (${group}).` : 'Launcher source stability checks passed.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = error.category === 'test_environment' ? 2 : 1;
    }
}
