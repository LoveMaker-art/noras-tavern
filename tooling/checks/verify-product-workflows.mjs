#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineRoot = resolve(repositoryRoot, 'app/engine/sillytavern');

const workflows = [
    {
        id: 'resume-world',
        name: 'Open Nora and resume the authoritative World',
        tests: [
            'tests/nora-bootstrap.test.mjs',
            'tests/nora-ui-store.test.mjs',
            'tests/nora-world-selection-transaction.test.mjs',
            'tests/nora-world-core-client.test.mjs',
        ],
    },
    {
        id: 'import-complex-card',
        name: 'Import one complex card into one recoverable World',
        tests: [
            'tests/nora-st-backend-materializer.test.mjs',
            'tests/nora-st-card-codec.test.mjs',
            'tests/nora-world-v2-endpoint.test.mjs',
        ],
    },
    {
        id: 'play-and-revise',
        name: 'Send, edit and resend, regenerate, and request smart replies',
        tests: [
            'tests/nora-chat-window.test.mjs',
            'tests/nora-story-action-dispatcher.test.mjs',
            'tests/nora-tavern-helper-action-adapter.test.mjs',
            'tests/nora-startup-readiness.test.mjs',
            'tests/nora-message-controller.test.mjs',
            'tests/nora-runtime-adapter.test.mjs',
        ],
    },
    {
        id: 'library-to-new-world',
        name: 'Browse saved cards and explicitly create a new World',
        tests: [
            'tests/nora-character-library-pagination.test.mjs',
            'tests/nora-world-core-client.test.mjs',
            'tests/nora-world-core.test.mjs',
        ],
    },
    {
        id: 'refresh-and-restart',
        name: 'Recover World, Session, resources, and operations after refresh or restart',
        tests: [
            'tests/nora-world-core.test.mjs',
            'tests/nora-world-store.test.mjs',
            'tests/nora-world-capability-integration.test.mjs',
        ],
    },
];

function run(command, args) {
    const startedAt = performance.now();
    const result = spawnSync(command, args, {
        cwd: engineRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    return {
        ok: result.status === 0,
        durationMs: Math.round(performance.now() - startedAt),
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

const results = [];
for (const workflow of workflows) {
    const missing = workflow.tests.filter(file => !existsSync(resolve(engineRoot, file)));
    if (missing.length) throw new Error(`Workflow ${workflow.id} references missing tests: ${missing.join(', ')}`);
    const result = run(process.execPath, ['--test', ...workflow.tests]);
    results.push({
        id: workflow.id,
        name: workflow.name,
        passed: result.ok,
        durationMs: result.durationMs,
        evidenceLevel: 'technical',
        tests: workflow.tests,
    });
    if (!result.ok) {
        process.stderr.write(result.stdout);
        process.stderr.write(result.stderr);
        break;
    }
}

const contractResult = results.every(item => item.passed)
    ? run(process.execPath, ['tests/run-nora-contracts.mjs'])
    : { ok: false, durationMs: 0 };

const report = {
    schema: 'nora-product-workflow-gate/v1',
    generatedAt: new Date().toISOString(),
    technical: {
        passed: results.length === workflows.length && results.every(item => item.passed) && contractResult.ok,
        workflows: results,
        architectureContracts: { passed: contractResult.ok, durationMs: contractResult.durationMs },
    },
    // Preserve the evidence distinction without making browser QA a release gate.
    browser: { required: false, passed: false, report: null, error: 'Not executed; technical evidence is not user-outcome verification.' },
};

console.log(JSON.stringify(report, null, 2));
if (!report.technical.passed) process.exitCode = 1;
