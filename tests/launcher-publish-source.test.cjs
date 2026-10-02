const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyPublishSource } = require('../tooling/release/verify-publish-source.cjs');

function fixture() {
    const expected = { commit: 'a'.repeat(40), repository: 'owner/tavern', runId: '123' };
    const run = { id: 123, head_sha: expected.commit, repository: { id: 42, full_name: expected.repository },
        path: '.github/workflows/build-integrated-launcher.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
    const artifacts = { total_count: 4, artifacts: ['darwin-arm64', 'darwin-x64', 'shared', 'win32-x64'].map(target => ({
        name: 'nora-tavern-' + target, expired: false, size_in_bytes: 1024,
        workflow_run: { id: run.id, head_sha: run.head_sha, repository_id: 42, head_repository_id: 42 },
    })) };
    return { run, artifacts, expected };
}

test('publishing an already verified build requires the exact tag commit and all platforms', () => {
    const f = fixture();
    verifyPublishSource(f.run, f.artifacts, f.expected);
});

for (const [label, mutate] of [
    ['failed native build', f => { f.run.conclusion = 'failure'; }],
    ['running build', f => { f.run.status = 'in_progress'; }],
    ['other commit', f => { f.run.head_sha = 'b'.repeat(40); }],
    ['other workflow', f => { f.run.path = '.github/workflows/publish-component-update.yml'; }],
    ['other repository', f => { f.run.repository.full_name = 'other/tavern'; }],
    ['missing repository ID', f => { delete f.run.repository.id; }],
    ['unrequested build event', f => { f.run.event = 'pull_request'; }],
    ['other run', f => { f.run.id = 124; }],
    ['missing Windows package', f => { f.artifacts.artifacts.pop(); f.artifacts.total_count--; }],
    ['duplicate platform', f => { f.artifacts.artifacts[3] = f.artifacts.artifacts[0]; }],
    ['expired artifact', f => { f.artifacts.artifacts[0].expired = true; }],
    ['empty artifact', f => { f.artifacts.artifacts[0].size_in_bytes = 0; }],
    ['artifact from other run', f => { f.artifacts.artifacts[0].workflow_run.id = 124; }],
    ['artifact from other commit', f => { f.artifacts.artifacts[0].workflow_run.head_sha = 'b'.repeat(40); }],
    ['artifact from a fork', f => { f.artifacts.artifacts[0].workflow_run.head_repository_id = 43; }],
]) test(`rejects ${label} before downloading or publishing`, () => {
    const f = fixture(); mutate(f);
    assert.throws(() => verifyPublishSource(f.run, f.artifacts, f.expected));
});
