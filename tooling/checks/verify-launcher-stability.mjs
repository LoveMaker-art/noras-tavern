import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
    'test_first_install',
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

export function verifyLauncherStability({ root = sourceRoot, run = spawnSync, checkEnvironment = checkLauncherTestEnvironment,
    platform = process.platform, arch = process.arch } = {}) {
    const { environment } = checkEnvironment({ root, profile: 'source' });
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
    for (const [scope, args, timeout] of [
        ['launcher plans, results, recovery and uninstall', ['node', '--test', '--test-concurrency=1',
            ...javascript.map(name => path.join(root, 'tests/deployment', name))], javascriptTimeout],
        ['installation and system transaction recovery', ['python', '-B', '-m', 'unittest',
            ...python.map(name => `tests.deployment.${name}`)], pythonTimeout],
    ]) {
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
        verifyLauncherStability();
        console.log('Launcher source stability checks passed; packaged user workflows remain separate acceptance requirements.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = error.category === 'test_environment' ? 2 : 1;
    }
}
