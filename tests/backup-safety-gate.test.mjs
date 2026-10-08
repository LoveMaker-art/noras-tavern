import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { verifyBackupSafety } from '../tooling/checks/verify-backup-safety.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireEngine = createRequire(path.join(root, 'app/engine/sillytavern/package.json'));
const { parse } = requireEngine('yaml');

test('the backup gate blocks failing tests, killed workers and timeouts', () => {
    for (const result of [{ status: 1 }, { status: null, signal: 'SIGKILL' },
        { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }]) {
        assert.throws(() => verifyBackupSafety({ run: () => result }));
    }
    const commands = [];
    verifyBackupSafety({ run: (...args) => { commands.push(args); return { status: 0 }; } });
    const command = commands[0];
    assert.equal(command[0], process.execPath);
    assert.equal(command[1][0], '--test');
    for (const name of ['nora-backup-retention-safety', 'nora-chat-backup-store', 'nora-backup-inventory-http', 'nora-backup-ui']) {
        assert.ok(command[1].includes(`tests/${name}.test.mjs`), name);
    }
    assert.equal(command[2].cwd, path.join(root, 'app/engine/sillytavern'));
    assert.ok(command[1].includes('tests/nora-startup-asset-budget-contract.mjs'));
    assert.equal(command[2].timeout, 240000);
    assert.equal(commands.length, 3);
    assert.ok(commands[1][1].includes('node_modules/typescript/bin/tsc'));
    assert.ok(commands[2][1].includes('tests/integration/backups.test.mjs'));
    assert.equal(commands[2][2].env.NORA_TAVERN_SOURCE, command[2].cwd);
    let called = 0;
    assert.throws(() => verifyBackupSafety({ run: () => ({ status: ++called === 2 ? 1 : 0 }) }));
    assert.equal(called, 2, 'MCP build failure stops before tool acceptance tests');
});

for (const workflow of ['build-integrated-launcher.yml', 'publish-component-update.yml']) {
    test(`${workflow} cannot build release components before the mandatory backup gate`, () => {
        const content = parse(fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8'));
        const buildJobs = Object.values(content.jobs).filter(job => (job.steps || [])
            .some(step => /node tooling\/release\/package-release\.mjs/.test(step.run || '')));
        assert.equal(buildJobs.length, 1);
        const steps = buildJobs[0].steps;
        const buildIndex = steps.findIndex(step => /node tooling\/release\/package-release\.mjs/.test(step.run || ''));
        const gateIndex = steps.findIndex(step => /node tooling\/checks\/verify-backup-safety\.mjs/.test(step.run || ''));
        assert.ok(buildIndex >= 0 && gateIndex >= 0 && gateIndex < buildIndex);
        const gate = steps[gateIndex];
        assert.equal(gate.if, undefined, 'gate is not conditionally skipped');
        assert.notEqual(gate['continue-on-error'], true);
        assert.equal(gate.shell, 'bash');
        assert.match(gate.run, /set -euo pipefail/);
        assert.match(gate.run, /npm ci --prefix app\/engine\/sillytavern/);
        assert.match(gate.run, /npm ci --prefix nora-mcp/);
        assert.ok(!/\|\|\s*true/.test(gate.run));
    });
}
