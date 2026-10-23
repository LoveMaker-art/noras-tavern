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
const packageScript = 'tooling/release/package-release.mjs';
const backupScript = 'tooling/checks/verify-backup-safety.mjs';
function invokesAuthoredNodeScript(run, script) {
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Both forms execute the same authored entry. Anchor the command so a
    // comment, echo or similarly named file cannot stand in for the gate.
    return new RegExp(`^[ \\t]*node[ \\t]+(?:${escaped}|"\\$PWD/${escaped}")(?=[ \\t\\r]|$)`, 'm').test(run || '');
}

test('backup workflow admission recognizes relative and quoted absolute authored commands only', () => {
    for (const script of [packageScript, backupScript]) {
        for (const run of [`node ${script}`, `  node ${script} --candidate`, `node "$PWD/${script}"`, `  node "$PWD/${script}" --candidate`]) {
            assert.equal(invokesAuthoredNodeScript(run, script), true, run);
        }
        for (const run of [`# node ${script}`, `echo node ${script}`, `node ${script}.bak`, `node "$PWD/${script}".bak`, `node /other/${script}`]) {
            assert.equal(invokesAuthoredNodeScript(run, script), false, run);
        }
    }
});

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
    assert.ok(command[1].includes('--test-concurrency=1'), 'isolated scan budgets must not contend with other test files');
    for (const name of ['nora-backup-retention-safety', 'nora-chat-backup-store', 'nora-backup-inventory-http', 'nora-backup-ui']) {
        assert.ok(command[1].includes(`tests/${name}.test.mjs`), name);
    }
    assert.equal(command[2].cwd, path.join(root, 'app/engine/sillytavern'));
    assert.ok(command[1].includes('tests/nora-startup-asset-budget-contract.mjs'));
    assert.equal(command[2].timeout, 480000, 'the complete serial suite must fit without changing individual scan budgets');
    assert.equal(commands.length, 3);
    assert.ok(commands[1][1].includes('node_modules/typescript/bin/tsc'));
    assert.ok(commands[2][1].includes('tests/integration/backups.test.mjs'));
    assert.equal(commands[1][2].timeout, 240000);
    assert.equal(commands[2][2].timeout, 240000);
    assert.ok(commands.every(command => command[2].killSignal === 'SIGKILL'));
    assert.equal(commands[2][2].env.NORA_TAVERN_SOURCE, command[2].cwd);
    let called = 0;
    assert.throws(() => verifyBackupSafety({ run: () => ({ status: ++called === 2 ? 1 : 0 }) }));
    assert.equal(called, 2, 'MCP build failure stops before tool acceptance tests');
});

for (const workflow of ['build-integrated-launcher.yml', 'publish-component-update.yml']) {
    test(`${workflow} cannot build release components before the mandatory backup gate`, () => {
        let content = parse(fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8'));
        if (workflow === 'build-integrated-launcher.yml') {
            assert.equal(content.jobs.build.uses, './.github/workflows/launcher-platform-stages.yml');
            content = parse(fs.readFileSync(path.join(root, '.github/workflows/launcher-platform-stages.yml'), 'utf8'));
            const { source, runtime, package: packaging } = content.jobs;
            assert.equal(source.if, undefined, 'The source backup gate cannot be conditionally skipped');
            assert.ok(runtime.needs.includes('source') && runtime.if.includes("needs.source.result == 'success'"));
            assert.ok(packaging.needs.includes('source') && packaging.if.includes("needs.source.result == 'success'"));
            assert.ok(packaging.needs.includes('runtime') && packaging.if.includes("needs.runtime.result == 'success'"));
            const restores = packaging.steps.filter(step => step.run?.includes('build-stage.cjs restore source'));
            assert.equal(restores.length, 1, 'Packaging must restore the successful source checkpoint');
            const restoreIndex = packaging.steps.indexOf(restores[0]);
            assert.ok(restoreIndex < packaging.steps.findIndex(step => invokesAuthoredNodeScript(step.run, packageScript)));
            // Preserve the gate's command assertions below across the actual DAG.
            content.jobs = { build: { steps: [...source.steps, ...packaging.steps] } };
        }
        const buildJobs = Object.values(content.jobs).filter(job => (job.steps || [])
            .some(step => invokesAuthoredNodeScript(step.run, packageScript)));
        assert.equal(buildJobs.length, 1);
        const steps = buildJobs[0].steps;
        const buildIndex = steps.findIndex(step => invokesAuthoredNodeScript(step.run, packageScript));
        const gateIndices = steps.flatMap((step, index) => invokesAuthoredNodeScript(step.run, backupScript) ? [index] : []);
        assert.equal(gateIndices.length, 1, 'Exactly one mandatory backup gate must protect this build job');
        const [gateIndex] = gateIndices;
        assert.ok(buildIndex >= 0 && gateIndex >= 0 && gateIndex < buildIndex);
        const gate = steps[gateIndex];
        assert.equal(gate.if, undefined, 'gate is not conditionally skipped');
        assert.notEqual(gate['continue-on-error'], true);
        assert.equal(gate.shell, 'bash');
        assert.equal(gate['timeout-minutes'], 10, 'The mandatory backup step retains its finite outer budget');
        assert.match(gate.run, /set -euo pipefail/);
        assert.match(gate.run, /npm ci --prefix app\/engine\/sillytavern/);
        assert.match(gate.run, /npm ci --prefix nora-mcp/);
        assert.ok(!/\|\|\s*true/.test(gate.run));
    });
}
