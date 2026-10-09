import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const tests = [
    'nora-chat-file-write.test.mjs',
    'nora-backup-retention-safety.test.mjs',
    'nora-chat-backup-store.test.mjs',
    'nora-chat-backup-runtime.test.mjs',
    'nora-backup-config.test.mjs',
    'nora-backup-inventory.test.mjs',
    'nora-backup-inventory-http.test.mjs',
    'nora-backup-ui.test.mjs',
    'nora-message-controller.test.mjs',
    'nora-dialog-controller.test.mjs',
    'nora-chat-activity-client.test.mjs',
    'nora-story-ledger-client.test.mjs',
    'nora-story-ledger.test.mjs',
    'nora-startup-asset-budget-contract.mjs',
];

export function verifyBackupSafety({ root = sourceRoot, run = spawnSync } = {}) {
    const engine = path.join(root, 'app/engine/sillytavern');
    for (const invocation of [
        // Serial files share one process budget. Individual latency assertions
        // and test timeouts remain enforced inside each file.
        { cwd: engine, timeout: 480000, args: ['--test', '--test-concurrency=1', ...tests.map(name => `tests/${name}`)] },
        { cwd: path.join(root, 'nora-mcp'), args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'] },
        { cwd: path.join(root, 'nora-mcp'), args: ['--test', 'tests/backups.test.mjs', 'tests/integration/backups.test.mjs'] },
    ]) {
        const result = run(process.execPath, invocation.args, { cwd: invocation.cwd, stdio: 'inherit', timeout: invocation.timeout ?? 240000,
            env: { ...process.env, NORA_TAVERN_SOURCE: engine } });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Backup safety gate failed: ${result.signal || result.status}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { verifyBackupSafety(); } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
