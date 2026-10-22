const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

test('Windows terminal provisioning refuses a same-size altered executable before executing it', async () => {
    const { windowsGit, installWindowsGit, windowsGitArchive } = await import(pathToFileURL(
        path.resolve(__dirname, '../../tooling/runtime/windows-git.mjs')));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-git-input-'));
    try {
        const archive = path.join(root, 'altered.exe');
        fs.writeFileSync(archive, 'altered');
        fs.truncateSync(archive, windowsGit.size);
        let executions = 0;
        assert.throws(() => installWindowsGit(archive, path.join(root, 'runtime'), {
            platform: 'win32', execute() { executions++; },
        }), /SHA-256 differs/);
        await assert.rejects(windowsGitArchive(path.join(root, 'unused'), archive), /SHA-256 differs/);
        assert.equal(executions, 0);
        assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows terminal provisioning refuses another platform and incomplete input', async () => {
    const { installWindowsGit, verifyWindowsGitArchive } = await import(pathToFileURL(
        path.resolve(__dirname, '../../tooling/runtime/windows-git.mjs')));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-git-input-'));
    try {
        const archive = path.join(root, 'partial.exe');
        fs.writeFileSync(archive, 'incomplete');
        assert.throws(() => verifyWindowsGitArchive(archive), /size\/type differs/);
        assert.throws(() => installWindowsGit(archive, root, { platform: 'darwin' }), /only bundled on Windows/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
