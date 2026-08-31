import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(engineRoot, '..', '..');
const repositoryRoot = path.resolve(appRoot, '..');
const opsRoot = path.join(repositoryRoot, 'ops');
const lifecycle = fs.readFileSync(path.join(appRoot, 'native_lifecycle.py'), 'utf8');
const runtime = fs.readFileSync(path.join(opsRoot, 'scripts', 'runtime.sh'), 'utf8');
const bringup = fs.readFileSync(path.join(opsRoot, 'scripts', 'bringup-native.sh'), 'utf8');
const provision = fs.readFileSync(path.join(opsRoot, 'scripts', 'provision.sh'), 'utf8');

assert.doesNotMatch(lifecycle, /sidecar/i, 'native lifecycle must remain a single-process Node runtime');
assert.equal(fs.existsSync(path.join(appRoot, 'sidecar_service.py')), false, 'Python sidecar service must be removed');
assert.equal(fs.existsSync(path.join(appRoot, 'native_runtime_contract.py')), false, 'obsolete sidecar contract store must be removed');
assert.equal(fs.existsSync(path.join(engineRoot, 'plugins', 'nora-sidecar')), false, 'Node sidecar proxy plugin must be removed');

assert.deepEqual(
    fs.readdirSync(appRoot).filter(name => name.endsWith('.py')).sort(),
    [
        'native_lifecycle.py',
        'native_model_config.py',
        'personality_service.py',
    ],
    'the application root may contain offline Story Profile modules but no Python web runtime',
);
assert.doesNotMatch(
    fs.readFileSync(path.join(appRoot, 'story_profile_runtime/adapters/nora/cli.py'), 'utf8'),
    /HTTPServer|BaseHTTPRequestHandler|Flask|FastAPI|listen\s*\(/,
    'the Story Profile adapter must remain a one-shot command adapter, not a second web process',
);
assert.equal(fs.existsSync(path.join(appRoot, 'web')), false, 'the legacy Python web application must be removed');
assert.equal(fs.existsSync(path.join(appRoot, 'story_profile_adapter.py')), false, 'the unused profile launcher must stay retired');
assert.equal(fs.existsSync(path.join(engineRoot, 'src/nora-story-profile-checkpoint.js')), false, 'the unused checkpoint re-export must stay retired');
assert.equal(fs.existsSync(path.join(appRoot, 'assets', 'fixtures', 'starter')), false, 'legacy Python starter fixtures must be removed');

for (const removedPath of [
    'scripts/bringup.sh',
    'scripts/cutover.sh',
    'plugins/tavern-soul-reload',
]) {
    assert.equal(fs.existsSync(path.join(opsRoot, removedPath)), false, `${removedPath} must be removed with the legacy runtime`);
}

assert.doesNotMatch(runtime, /legacy|server\.py|runtime-mode|MODE=/i, 'runtime.sh must delegate only to the Node lifecycle');
assert.match(runtime, /native_lifecycle\.py/, 'runtime.sh must preserve the Node lifecycle entry point');
assert.doesNotMatch(bringup, /server\.py/i, 'bringup must not restore the legacy Python server');
assert.match(bringup, /runtime\.sh" start --run-id production/, 'bringup must start exactly the Nora Node lifecycle');
assert.match(bringup, /ACTOR_APP_ID/, 'the Story Profile entry must share the Nora Node process');
assert.doesNotMatch(provision, /server\.py/i, 'provisioning must not restore the legacy Python server');
assert.match(provision, /ensure\("actor"/, 'provisioning must preserve the Story Profile app identity');
for (const retired of ['tavern_cli.py', 'native_tavern.py']) {
    assert.equal(fs.existsSync(path.join(opsRoot, 'scripts', retired)), false, 'retired direct-operation CLIs must not return');
}
assert.equal(fs.existsSync(path.join(appRoot, 'story_profile_runtime/adapters/nora/cli.py')), true, 'the canonical one-shot Story Profile adapter must be installed');
assert.equal(fs.existsSync(path.join(appRoot, 'native_model_config.py')), true, 'Hermes model configuration must be preserved');
assert.equal(
    fs.existsSync(path.join(appRoot, 'story_profile_runtime', 'manifest.json')),
    true,
    'the application archive must contain the generated Story Profile runtime',
);
assert.equal(fs.existsSync(path.join(appRoot, 'story_profile.py')), false, 'the obsolete duplicate profile core must be removed');
assert.equal(fs.existsSync(path.join(appRoot, 'story_profile_reflection.py')), false, 'the obsolete duplicate reflection core must be removed');

console.log('nora-single-process-contract=PASS');
