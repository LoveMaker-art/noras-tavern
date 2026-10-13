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
    'launcher_operation_cli.test.cjs',
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
    'test_nora_system',
    'test_update_migration_contract',
    'test_update_space',
    'test_update_space_contract',
    'test_launcher_test_environment',
    'test_manual_acceptance',
];

export function verifyLauncherStability({ root = sourceRoot, run = spawnSync, checkEnvironment = checkLauncherTestEnvironment,
    platform = process.platform, arch = process.arch } = {}) {
    const { environment } = checkEnvironment({ root, profile: 'source' });
    // The complete serial JS group spawns real Python recovery actors. Hosted
    // Windows completed in 361.49s and Intel Mac reached the old four-minute
    // deadline before TAP ended. Keep finite, separate group budgets and all
    // authored cases; ARM and Linux retain their established four-minute limit.
    const javascriptTimeout = platform === 'win32' || platform === 'darwin' && arch === 'x64' ? 480000 : 240000;
    for (const [scope, args, timeout] of [
        ['launcher plans, results, recovery and uninstall', ['node', '--test', '--test-concurrency=1',
            ...javascript.map(name => path.join(root, 'tests/deployment', name))], javascriptTimeout],
        ['installation and system transaction recovery', ['python', '-B', '-m', 'unittest',
            ...python.map(name => `tests.deployment.${name}`)], 240000],
    ]) {
        const result = run(process.execPath, [path.join(root, 'tooling/run.mjs'), ...args], {
            cwd: root, stdio: 'inherit', timeout,
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
