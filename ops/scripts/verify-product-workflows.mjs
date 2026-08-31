#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineRoot = resolve(repositoryRoot, 'app/engine/sillytavern');
const requireBrowser = process.argv.includes('--require-browser');
const browserReportArgument = process.argv.indexOf('--browser-report');
const browserReportPath = browserReportArgument >= 0 ? resolve(process.argv[browserReportArgument + 1] || '') : '';

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

function validateBrowserReport(path) {
    if (!path || !existsSync(path)) throw new Error('Release verification requires --browser-report <path>.');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const commit = process.env.TAVERN_RELEASE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    if (report.commit !== commit) throw new Error('Browser evidence does not match the release commit.');
    if (process.env.TAVERN_RELEASE_SOURCE_DIGEST && report.sourceDigest !== process.env.TAVERN_RELEASE_SOURCE_DIGEST) {
        throw new Error('Browser evidence does not match the release source digest.');
    }
    const age = Date.now() - Date.parse(report.generatedAt);
    if (!Number.isFinite(age) || age < -300_000 || age > 7 * 24 * 60 * 60 * 1000 || !report.environment) {
        throw new Error('Browser evidence must identify its environment and be no more than seven days old.');
    }
    const results = new Map((report.workflows || []).map(item => [item.id, item]));
    for (const workflow of workflows) {
        if (results.get(workflow.id)?.passed !== true) throw new Error(`Browser workflow did not pass: ${workflow.id}`);
    }
    if (!Number.isFinite(report.metrics?.coldStartP95Ms) || report.metrics.coldStartP95Ms > 10_000) {
        throw new Error('Browser cold-start P95 is missing or exceeds 10 seconds.');
    }
    if (!Number.isFinite(report.metrics?.warmOpenP95Ms) || report.metrics.warmOpenP95Ms > 5_000) {
        throw new Error('Browser warm-open P95 is missing or exceeds 5 seconds.');
    }
    if (!Number.isFinite(report.metrics?.importFeedbackP95Ms) || report.metrics.importFeedbackP95Ms > 1_000) {
        throw new Error('Import feedback P95 is missing or exceeds 1 second.');
    }
    return report;
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

let browser = null;
let browserError = null;
if (requireBrowser) {
    try {
        browser = validateBrowserReport(browserReportPath);
    } catch (error) {
        browserError = String(error?.message || error);
    }
}

const report = {
    schema: 'nora-product-workflow-gate/v1',
    generatedAt: new Date().toISOString(),
    technical: {
        passed: results.length === workflows.length && results.every(item => item.passed) && contractResult.ok,
        workflows: results,
        architectureContracts: { passed: contractResult.ok, durationMs: contractResult.durationMs },
    },
    browser: requireBrowser
        ? { required: true, passed: Boolean(browser) && !browserError, report: browser, error: browserError }
        : { required: false, passed: false, report: null, error: 'Not executed; technical evidence is not user-outcome verification.' },
};

console.log(JSON.stringify(report, null, 2));
if (!report.technical.passed || (requireBrowser && !report.browser.passed)) process.exitCode = 1;
