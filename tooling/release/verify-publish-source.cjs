const assert = require('node:assert/strict');
const fs = require('node:fs');

const names = ['nora-tavern-darwin-arm64', 'nora-tavern-darwin-x64', 'nora-tavern-shared', 'nora-tavern-win32-x64'];

function verifyPublishSource(run, artifacts, { commit, repository, runId }) {
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.match(String(runId), /^[1-9][0-9]*$/);
    assert.ok(Number.isSafeInteger(Number(runId)));
    assert.equal(run.id, Number(runId), 'Source build run differs');
    assert.equal(run.repository.full_name, repository, 'Source repository differs');
    assert.ok(Number.isSafeInteger(run.repository.id) && run.repository.id > 0, 'Source repository ID is missing');
    assert.equal(run.head_sha, commit, 'Source build commit differs from release tag');
    assert.equal(run.path, '.github/workflows/build-integrated-launcher.yml', 'Source build workflow differs');
    assert.equal(run.event, 'workflow_dispatch', 'Source build was not explicitly dispatched');
    assert.equal(run.status, 'completed', 'Source build is not complete');
    assert.equal(run.conclusion, 'success', 'Source build did not pass');
    assert.equal(artifacts.total_count, names.length, 'Source build must contain exactly four artifacts');
    assert.deepEqual(artifacts.artifacts.map(item => item.name).sort(), names, 'Source build lacks a supported platform');
    for (const item of artifacts.artifacts) {
        assert.equal(item.expired, false, 'Source artifact expired');
        assert.ok(Number.isSafeInteger(item.size_in_bytes) && item.size_in_bytes > 0, 'Source artifact is empty');
        assert.equal(item.workflow_run.id, run.id, 'Artifact source run differs');
        assert.equal(item.workflow_run.head_sha, commit, 'Artifact source commit differs');
        assert.equal(item.workflow_run.repository_id, run.repository.id, 'Artifact repository differs');
        assert.equal(item.workflow_run.head_repository_id, run.repository.id, 'Artifact came from a fork');
    }
}

module.exports = { verifyPublishSource };
if (require.main === module) {
    const [runFile, artifactsFile, commit, repository, runId] = process.argv.slice(2);
    verifyPublishSource(JSON.parse(fs.readFileSync(runFile)), JSON.parse(fs.readFileSync(artifactsFile)),
        { commit, repository, runId });
    console.log(`Verified completed three-platform build ${runId} at ${commit}.`);
}
