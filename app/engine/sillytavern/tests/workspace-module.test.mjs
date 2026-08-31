import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-workspace-test-'));
globalThis.DATA_ROOT = dataRoot;
globalThis.COMMAND_LINE_ARGS = {
    listen: false,
    basicAuthMode: false,
    whitelistMode: false,
};

const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(path.resolve('config.yaml'));

const { DEFAULT_USER, USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
const workspace = await import('../src/workspace.js');

const directories = workspace.getUserDirectories();
assert.deepEqual(Object.keys(directories).sort(), Object.keys(USER_DIRECTORY_TEMPLATE).sort());
for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
    assert.equal(directories[key], path.join(dataRoot, DEFAULT_USER.handle, relative));
}

assert.equal(workspace.getUserDirectories(), directories, 'directory map should be stable for the process lifetime');
assert.deepEqual(await workspace.getUserDirectoriesList(), [directories]);
assert.deepEqual(workspace.getSingleUserContext(), {
    profile: DEFAULT_USER,
    directories,
});

await workspace.ensurePublicDirectoriesExist();
for (const directory of Object.values(directories)) {
    assert.equal(fs.existsSync(directory), true, `directory must exist: ${directory}`);
}

const cookieSecret = workspace.getCookieSecret(dataRoot);
assert.ok(cookieSecret.length >= 64);
assert.equal(workspace.getCookieSecret(dataRoot), cookieSecret);

const request = {};
let continued = false;
workspace.setUserDataMiddleware(request, null, () => {
    continued = true;
});
assert.equal(continued, true);
assert.equal(request.user.profile.handle, DEFAULT_USER.handle);
assert.equal(request.user.directories, directories);

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log('workspace-module=PASS');
