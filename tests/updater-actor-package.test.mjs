import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReleaseSource, groupRuntimeModules, collectRuntimeFiles, materializeUpdaterDependencies,
    verifyUpdaterDependencies, UPDATER_DEPENDENCY_ROOT, assertSafeReleasePath, digest } from '../tooling/release/release-source.mjs';
import { buildCommand } from '../tooling/release/build-commands.mjs';
import { writeSystemRelease } from '../tooling/release/system-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capabilities = { operationSchema: 'nora-operation/1', executorProtocol: 'nora-operation-executor/1', telemetrySchema: 3, faultSchema: 2 };

test('independent updater declares its own protocol without replacing legacy launcher metadata', t => {
    const source = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(source.stage, { recursive: true, force: true }));
    assert.deepEqual(source.identity.updaterCapabilities, capabilities);
    assert.deepEqual(source.identity.launcherCapabilities, capabilities);
    const payload = path.join(source.stage, 'payload'); fs.mkdirSync(payload);
    writeSystemRelease({ release: source.stage, payload, launcherVersion: '2.2.2', minimumLauncherVersion: '2.2.2',
        identity: { ...source.identity, versions: { tavern: '2.5.2' }, hermesRuntime: { platform: process.platform, arch: process.arch } } });
    const system = JSON.parse(fs.readFileSync(path.join(payload, 'nora-system.json')));
    assert.deepEqual(system.updaterCapabilities, capabilities);
    assert.deepEqual(system.launcherCapabilities, capabilities);
});

test('sealed module-only actor loads on real Node with a complete native dependency closure, reuses safely, and rejects tampering',
    { timeout: 90000 }, t => {
    const source = createReleaseSource(root, { candidate: true });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-updater-actor-package-'));
    t.after(() => fs.rmSync(source.stage, { recursive: true, force: true }));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const receipt = materializeUpdaterDependencies(source.stage, { install: directory => {
        const npm = buildCommand('npm', ['ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund']);
        execFileSync(npm.command, npm.args, { cwd: directory, stdio: 'pipe', timeout: 60000 });
    } });
    const dependencyRoot = path.join(source.stage, UPDATER_DEPENDENCY_ROOT);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dependencyRoot, 'node_modules/semver/package.json'))).version, '7.8.5');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dependencyRoot, 'node_modules/fs-native-extensions/package.json'))).version, '1.5.1');
    assert.deepEqual(fs.readdirSync(path.join(dependencyRoot, 'node_modules')).sort(),
        ['bare-addon-resolve', 'bare-module-resolve', 'bare-semver', 'fs-native-extensions', 'require-addon', 'semver', 'which-runtime']);
    for (const name of ['electron', 'electron-builder', 'acorn']) assert.equal(fs.existsSync(path.join(dependencyRoot, 'node_modules', name)), false);
    assert.throws(() => assertSafeReleasePath(`${UPDATER_DEPENDENCY_ROOT}/node_modules/semver/index.js`), /forbidden/,
        'authored node_modules must stay forbidden in source exports');
    for (const directory of ['app/engine/sillytavern/public/dist/nora', 'app/engine/sillytavern/dist/_webpack/output', 'nora-mcp/dist']) {
        fs.mkdirSync(path.join(source.stage, directory), { recursive: true });
        fs.writeFileSync(path.join(source.stage, directory, 'fixture.js'), '// compiled fixture\n');
    }
    const runtimeFiles = collectRuntimeFiles(source.stage, source.files);
    const members = groupRuntimeModules(runtimeFiles).get('updater');
    assert.ok(Object.keys(receipt.files).every(file => members.includes(`${UPDATER_DEPENDENCY_ROOT}/${file}`)));
    const name = 'nora-tavern-module-updater.tar.gz', list = path.join(temporary, 'members.txt');
    fs.writeFileSync(list, members.join('\n') + '\n');
    const tar = buildCommand('tar', ['--no-xattrs', '-czf', path.join(temporary, name), '-C', source.stage, '-T', list]);
    execFileSync(tar.command, tar.args, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const artifacts = Object.fromEntries(members.map(file => [file, digest(fs.readFileSync(path.join(source.stage, file)))]));
    const manifest = { artifacts, modules: { updater: { name,
        sha256: digest(fs.readFileSync(path.join(temporary, name))), artifacts: members } } };
    fs.writeFileSync(path.join(temporary, 'release-manifest.json'), JSON.stringify(manifest));
    const python = process.env.NORA_TEST_PYTHON || process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const probe = `import importlib.util,json,pathlib,sys
bundle, entry = map(pathlib.Path,sys.argv[1:])
spec=importlib.util.spec_from_file_location('cold_actor',entry); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.extract_runner(bundle,bundle/'runner',json.loads((bundle/'release-manifest.json').read_text()))
`;
    execFileSync(python, ['-B', '-c', probe, temporary, path.join(source.stage, 'ops/updater/bootstrap.py')],
        { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20000 });
    const actor = path.join(temporary, 'runner/ops/installer/desktop');
    const nodeProbe = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
require(path.join(process.argv[1],'operation-cli.js'));
assert.equal(require('semver/package.json').version,'7.8.5');
assert.equal(require('fs-native-extensions/package.json').version,'1.5.1');
assert.equal(process.versions.electron,undefined);
(async()=>{const lock=require(path.join(process.argv[1],'operation-lock.js'));const directory=path.join(process.argv[2],'native-owner');
const lease=await lock.acquire({directory,operationId:'module-only-probe',ownerEpoch:1});
assert.equal((await lock.probe({directory})).busy,true);await lease.release();assert.equal((await lock.probe({directory})).busy,false);
process.stdout.write('cold native actor ready');})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const env = { ...process.env, NODE_PATH: path.join(temporary, 'runner', UPDATER_DEPENDENCY_ROOT, 'node_modules') };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    assert.equal(execFileSync(process.execPath, ['-e', nodeProbe, actor, temporary], { env, encoding: 'utf8', timeout: 20000 }), 'cold native actor ready');
    const reusedStage = path.join(temporary, 'reused');
    fs.mkdirSync(path.join(reusedStage, 'ops/installer/desktop'), { recursive: true });
    fs.copyFileSync(path.join(source.stage, 'ops/installer/desktop/package-lock.json'), path.join(reusedStage, 'ops/installer/desktop/package-lock.json'));
    const reused = materializeUpdaterDependencies(reusedStage, { baseline: { directory: temporary, identity: { artifacts,
        archives: { ops: { name, sha256: manifest.modules.updater.sha256 } } } },
        install: () => assert.fail('unchanged sealed dependency closure must not reinstall') });
    assert.deepEqual(reused, receipt);
    const file = path.join(reusedStage, UPDATER_DEPENDENCY_ROOT, 'node_modules/which-runtime/index.js');
    fs.appendFileSync(file, '\n// changed\n');
    assert.throws(() => verifyUpdaterDependencies(reusedStage), /sealed lock or receipt/);
});

test('the cold updater module includes the existing actor and Python maintenance resources without the GUI', t => {
    const source = createReleaseSource(root, { candidate: true });
    t.after(() => fs.rmSync(source.stage, { recursive: true, force: true }));
    const files = groupRuntimeModules(source.files.filter(file => file.startsWith('ops/'))).get('updater');
    for (const name of ['desktop/operation-cli.js', 'desktop/operation-lock.js', 'desktop/operation-lock-worker.js',
        'desktop/os-lock.js', 'desktop/release-sources.json', 'launcher_bridge.py', 'launcher_services.py',
        'nora_system.py', 'nora_profile.py', 'first_install.py']) {
        assert.ok(files.includes(`ops/installer/${name}`), `Missing cold actor dependency: ${name}`);
    }
    for (const name of ['desktop/main.js', 'desktop/preload.js', 'desktop/native-crash.js',
        'assets/nora-launcher-portrait.png', 'launcher-conversation-prototype.html']) {
        assert.ok(!files.includes(`ops/installer/${name}`), `GUI resource is not an updater dependency: ${name}`);
    }
});
