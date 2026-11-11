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

test('core construction cannot run before unconditional qualified backup safety', () => {
    const workflow=parse(fs.readFileSync(path.join(root,'.github/workflows/core-build.yml'),'utf8'));
    assert.equal(workflow.on.workflow_dispatch.inputs.delivery.default,'components');
    for(const [job,script] of [['components','tooling/release/build-core-components.mjs'],['platform','tooling/release/build-core.mjs']]) {
        const steps=workflow.jobs[job].steps;
        const gate=steps.findIndex(step=>invokesAuthoredNodeScript(step.run,'tooling/checks/core-source-gate.mjs'));
        const build=steps.findIndex(step=>invokesAuthoredNodeScript(step.run,script));
        assert.ok(gate>=0&&build>gate);
        assert.equal(steps[gate].if,undefined);assert.notEqual(steps[gate]['continue-on-error'],true);
        assert.ok(workflow.jobs[job]['timeout-minutes']>0);
    }
    const source=fs.readFileSync(path.join(root,'tooling/checks/core-source-gate.mjs'),'utf8');
    assert.ok(source.includes("['backup-safety',['tooling/checks/verify-backup-safety.mjs']]"));
    assert.ok(source.includes('result.status!==0||result.error||result.signal'));
    for(const file of ['tooling/release/build-core.mjs','tooling/release/build-core-components.mjs']) {
        const delivery=fs.readFileSync(path.join(root,file),'utf8');
        assert.ok(delivery.indexOf("proof.passed,true")<delivery.indexOf("tooling/release/package-release.mjs"));
        assert.ok(delivery.includes('qualification.checks.map(c=>c.name),qualificationChecks'));
    }
    const criteria=fs.readFileSync(path.join(root,'tooling/release/core-assets.mjs'),'utf8');
    assert.ok(criteria.includes("['backup-safety','repository-and-delivery','core-consumers','mcp-unit','mcp-integration','story-profile','tavern-workflows']"));
    const publisher=parse(fs.readFileSync(path.join(root,'.github/workflows/core-publish.yml'),'utf8'));
    assert.ok(!Object.values(publisher.jobs).flatMap(job=>job.steps||[]).some(step=>invokesAuthoredNodeScript(step.run,packageScript)));
});
