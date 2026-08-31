import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = relative => fs.readFileSync(path.join(engineRoot, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(engineRoot, relative));

const workspace = source('src/workspace.js');
const serverMain = source('src/server-main.js');
const startup = source('src/server-startup.js');
const settings = source('src/endpoints/settings.js');
const browserUser = source('public/scripts/workspace-user.js');
const browserUserCompatibility = source('public/scripts/user.js');
const packageJson = JSON.parse(source('package.json'));

assert.match(workspace, /request\.user\s*=\s*getSingleUserContext\(\)/);
assert.doesNotMatch(workspace, /ENABLE_ACCOUNTS|tryAutoLogin|requireAdminMiddleware|headerUserLogin|basicUserLogin/);
assert.doesNotMatch(serverMain, /usersPublicRouter|loginPageMiddleware|shouldRedirectToLogin|requireLoginMiddleware/);
assert.doesNotMatch(startup, /usersPrivateRouter|usersAdminRouter/);
assert.doesNotMatch(settings, /getAllUserHandles|ENABLE_ACCOUNTS/);
assert.match(settings, /enable_accounts:\s*false/);
assert.doesNotMatch(browserUser, /\/api\/users\//);
assert.match(browserUserCompatibility, /export\s*\{\s*isAdmin\s*\}\s*from\s*['"]\.\/workspace-user\.js['"]/);
assert.doesNotMatch(browserUserCompatibility, /\/api\/users\/|login|password|account/i);

for (const removed of [
    'src/endpoints/users-public.js',
    'src/endpoints/users-private.js',
    'src/endpoints/users-admin.js',
    'src/recover-password.js',
    'public/login.html',
    'public/scripts/login.js',
    'public/css/login.css',
    'public/scripts/templates/admin.html',
    'public/scripts/templates/userProfile.html',
    'public/css/accounts.css',
    'src/users.js',
]) {
    assert.equal(exists(removed), false, `${removed} must be removed from the single-workspace runtime`);
}

assert.equal(packageJson.dependencies.archiver, undefined);
assert.equal(packageJson.devDependencies['@types/archiver'], undefined);

for (const activeSource of [
    'src/server-main.js',
    'src/server-startup.js',
    'src/endpoints/settings.js',
    'src/endpoints/characters.js',
]) {
    assert.doesNotMatch(source(activeSource), /from ['"].*users\.js['"]/, `${activeSource} must use the workspace interface`);
}

console.log('nora-single-workspace-contract=PASS');
