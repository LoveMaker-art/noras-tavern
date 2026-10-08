import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertLauncherReuse, assertLauncherVersion, readBaseline, restoreBuiltPayload, reuseArchive } from '../tooling/release/launcher-build-baseline.mjs';
import { buildCommand } from '../tooling/release/build-commands.mjs';
import { digest } from '../tooling/release/release-source.mjs';

const fingerprints = Object.fromEntries(['app/engine/sillytavern/package-lock.json', 'nora-mcp/npm-shrinkwrap.json',
    'tooling/source-layout.json', 'tooling/release/package-hermes-runtime.mjs'].map(name => [name, 'a'.repeat(64)]));
const identity = () => ({ schema: 'tavern-release/v2', candidate: false, dirty: false, commit: 'a'.repeat(40),
    versions: { tavern: '2.3.17' }, sourceFiles: { ...fingerprints } });

test('stable launcher update requires a higher launcher version', () => {
    for (const version of ['1.1.3', '1.2.0', '2.0.0']) assert.doesNotThrow(() => assertLauncherVersion(version, '1.1.2'));
    for (const version of ['1.1.2', '1.0.9', '1.1.3-beta.1', '']) assert.throws(() => assertLauncherVersion(version, '1.1.2'));
});

test('launcher changes are allowed but changed, added and deleted runtime inputs require full build', () => {
    const baseline = identity();
    for (const name of ['launcher/desktop/main.js', 'deployment/shared/services.py', 'deployment/install/bootstrap.py',
        'app/.tavern-release-version', 'tooling/release/package-launcher-update.cjs',
        'tooling/release/package-local-launcher.mjs', 'tooling/release/verify-launcher-release.cjs',
        'tooling/release/launcher-release-notes.cjs']) {
        assert.deepEqual(assertLauncherReuse({ ...baseline, sourceFiles: { ...fingerprints, [name]: 'b'.repeat(64) } }, baseline), [name]);
    }
    for (const name of ['app/engine/sillytavern/src/server.js', 'nora-mcp/src/index.ts', 'nora/SOUL.md',
        'deployment/update/clawchat-greeting-order.patch', 'tooling/runtime/runtime-lock.json', 'unknown-build-input.json',
        '.github/workflows/build-integrated-launcher.yml',
        'tooling/release/package-hermes-runtime.mjs', 'tooling/source-layout.json']) {
        const changed = { ...baseline, sourceFiles: { ...fingerprints, [name]: 'b'.repeat(64) } };
        assert.throws(() => assertLauncherReuse(changed, baseline), /Full build/);
        assert.throws(() => assertLauncherReuse(baseline, changed), /Full build/);
    }
    assert.throws(() => assertLauncherReuse(baseline, { ...baseline, sourceFiles: {} }), /Missing fingerprint/);
    assert.throws(() => assertLauncherReuse(baseline, { ...baseline, candidate: true }), /stable/);
    assert.throws(() => assertLauncherReuse(baseline, { ...baseline, dirty: true }), /clean/);
});

test('shared build tools and unknown release scripts cannot reuse compiled payloads', () => {
    for (const name of ['release-source.mjs', 'build-commands.mjs', 'package-release.mjs', 'package-release.sh',
        'system-release.mjs', 'package-component-update.mjs', 'package-hermes-runtime.mjs',
        'launcher-build-baseline.mjs', 'restore-launcher-runtime.cjs', 'future-build-step.mjs']) {
        const file = `tooling/release/${name}`;
        const before = identity();
        before.sourceFiles[file] = 'a'.repeat(64);
        const changed = structuredClone(before);
        changed.sourceFiles[file] = 'b'.repeat(64);
        assert.throws(() => assertLauncherReuse(changed, before), /Full build/, `modified: ${file}`);
        if (file === 'tooling/release/package-hermes-runtime.mjs') continue;
        const absent = structuredClone(before);
        delete absent.sourceFiles[file];
        assert.throws(() => assertLauncherReuse(before, absent), /Full build/, `added: ${file}`);
        assert.throws(() => assertLauncherReuse(absent, before), /Full build/, `deleted: ${file}`);
    }
});

function fixture(t, platform = `${process.platform}-${process.arch}`) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-baseline-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const baseline = identity();
    const [systemPlatform, arch] = platform.split('-');
    const system = { schema: 'nora-system/v1', platform: systemPlatform, arch, candidate: false, channel: 'stable',
        commit: baseline.commit, version: baseline.versions.tavern, files: {} };
    const write = (name, bytes) => {
        if (typeof bytes !== 'string') bytes = JSON.stringify(bytes);
        fs.writeFileSync(path.join(directory, name), bytes);
        system.files[name] = { size: Buffer.byteLength(bytes), sha256: digest(bytes) };
    };
    for (const [name, key] of [['nora-hermes-runtime.json', 'hermesRuntime'], ['nora-tavern-dependencies.json', 'dependencies']]) {
        const archive = `${key}.tar.gz`;
        write(archive, 'unchanged environment');
        baseline[key] = { schema: 1, platform: systemPlatform, arch, archive, ...system.files[archive] };
        write(name, baseline[key]);
    }
    const seal = () => { write('release-manifest.json', baseline); fs.writeFileSync(path.join(directory, `nora-system-${platform}.json`), JSON.stringify(system)); };
    seal();
    return { directory, baseline, system, write, seal };
}

for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    test(`${platform}: baseline validates platform, metadata and archive hashes`, t => {
        const f = fixture(t, platform);
        assert.equal(readBaseline(f.directory, identity(), platform).runtime.sha256, f.baseline.hermesRuntime.sha256);
        f.system.platform = 'wrong'; f.seal();
        assert.throws(() => readBaseline(f.directory, identity(), platform));
        f.system.platform = platform.split('-')[0]; f.seal();
        fs.writeFileSync(path.join(f.directory, f.baseline.dependencies.archive), 'broken');
        assert.throws(() => readBaseline(f.directory, identity(), platform), /mismatch/);
    });
}

function tar(args) {
    const command = buildCommand('tar', args);
    return execFileSync(command.command, command.args, { stdio: 'pipe' });
}

for (const newline of ['\n', '\r\n']) test(`restored compiled files preserve version and validate archives with ${newline === '\n' ? 'LF' : 'CRLF'} listing output`, t => {
    const f = fixture(t);
    const source = path.join(f.directory, 'source'), stage = path.join(f.directory, 'stage');
    fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'app/.tavern-release-version'), '2.3.18');
    f.baseline.artifacts = {}; f.baseline.artifactModes = {}; f.baseline.archives = {};
    for (const [part, names] of [['app', ['app/.tavern-release-version', 'app/built.js']], ['nora-mcp', ['nora-mcp/dist/index.js']]]) {
        for (const name of names) {
            fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
            fs.writeFileSync(path.join(source, name), 'old bytes', { mode: 0o644 });
            f.baseline.artifacts[name] = digest('old bytes'); f.baseline.artifactModes[name] = 0o644;
        }
        const name = `${part}.tar.gz`;
        tar(['-czf', path.join(f.directory, name), '-C', source, ...names]);
        f.baseline.archives[part] = { name, sha256: digest(fs.readFileSync(path.join(f.directory, name))) };
    }
    f.seal();
    const execute = childProcess.execFileSync;
    t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        const output = execute(command, args, options);
        return typeof output === 'string' && (args.includes('-tzf') || args.includes('-tvzf'))
            ? output.replace(/\r?\n/g, newline) : output;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const baseline = readBaseline(f.directory, identity());
    restoreBuiltPayload(baseline, stage);
    assert.equal(fs.readFileSync(path.join(stage, 'app/.tavern-release-version'), 'utf8'), '2.3.18');
    assert.equal(fs.readFileSync(path.join(stage, 'app/built.js'), 'utf8'), 'old bytes');
    const entry = { ...f.baseline.archives['nora-mcp'], part: 'nora-mcp' };
    const target = path.join(f.directory, 'copy.tar.gz');
    assert.equal(reuseArchive(baseline, entry, ['nora-mcp/dist/index.js'], stage, target), true);
    assert.equal(digest(fs.readFileSync(target)), entry.sha256);
    assert.equal(reuseArchive(baseline, { ...f.baseline.archives.app, part: 'app' }, ['app/.tavern-release-version', 'app/built.js'], stage, target), false);
    assert.equal(reuseArchive(baseline, entry, [], stage, target), false);
    fs.writeFileSync(path.join(f.directory, entry.name), 'corrupt');
    assert.throws(() => reuseArchive(baseline, entry, ['nora-mcp/dist/index.js'], stage, target), /checksum/);
});

test('archive with unlisted files is rejected before extraction', t => {
    const f = fixture(t);
    const source = path.join(f.directory, 'source'), stage = path.join(f.directory, 'stage');
    fs.mkdirSync(source); fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'app/.tavern-release-version'), '2.3.18');
    fs.writeFileSync(path.join(source, 'unexpected'), 'bad');
    tar(['-czf', path.join(f.directory, 'app.tar.gz'), '-C', source, 'unexpected']);
    f.baseline.archives = { app: { name: 'app.tar.gz', sha256: digest(fs.readFileSync(path.join(f.directory, 'app.tar.gz'))) } };
    f.baseline.artifacts = {}; f.seal();
    assert.throws(() => restoreBuiltPayload(readBaseline(f.directory, identity()), stage), /Unexpected app/);
    assert.ok(!fs.existsSync(path.join(stage, 'unexpected')));
});

test('shared module provenance is checked separately from platform archive metadata', t => {
    const f = fixture(t);
    f.baseline.artifacts = { 'app/built.js': 'a'.repeat(64) };
    f.baseline.artifactModes = { 'app/built.js': 0o644 };
    f.baseline.modules = { app: { name: 'platform.tar.gz', sha256: 'b'.repeat(64), artifacts: ['app/built.js'] } };
    f.seal();
    const shared = { ...f.baseline, modules: { app: { ...f.baseline.modules.app, name: 'shared.tar.gz', sha256: 'c'.repeat(64) } } };
    const bytes = JSON.stringify(shared);
    fs.writeFileSync(path.join(f.directory, 'shared-release-manifest.json'), bytes);
    fs.writeFileSync(path.join(f.directory, 'shared-SHA256SUMS'), `${digest(bytes)}  release-manifest.json\n`);
    assert.equal(readBaseline(f.directory, identity()).identity.modules.app.name, 'shared.tar.gz');
    fs.appendFileSync(path.join(f.directory, 'shared-release-manifest.json'), ' ');
    assert.throws(() => readBaseline(f.directory, identity()));
});

test('release verifier requires installers, new launcher identity and unchanged environment provenance', t => {
    const f = fixture(t);
    const output = path.join(f.directory, 'public'); fs.mkdirSync(output);
    const write = (name, value) => fs.writeFileSync(path.join(output, name), typeof value === 'string' ? value : JSON.stringify(value));
    const seal = name => ({ asset: name, sha256: digest(fs.readFileSync(path.join(output, name))), size: fs.statSync(path.join(output, name)).size });
    const current = { ...identity(), launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2}, commit: 'b'.repeat(40), versions: { tavern: '2.3.18' }, launcherVersion: '2.1.1',
        bootstrap: { minimumLauncherVersion: '2.1.0' }, archives: {}, modules: {},
        launcherBuildReuse: { schema: 1, baselineCommit: 'a'.repeat(40), baselineVersion: '2.3.17', archives: {}, modules: {} } };
    let last;
    for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
        const [os, arch] = platform.split('-');
        const payload = structuredClone(current);
        const system = { version: '2.3.18', commit: current.commit, candidate: false, channel: 'stable', platform: os, arch,
            launcherVersion: '2.1.1', minimumLauncherVersion: '2.1.0', launcherCapabilities:current.launcherCapabilities, files: {} };
        for (const [manifest, key] of [['nora-hermes-runtime.json', 'runtimeSha256'], ['nora-tavern-dependencies.json', 'dependenciesSha256']]) {
            const archive = `${key}.tar.gz`;
            write(`${platform}-${archive}`, 'old environment'); system.files[archive] = seal(`${platform}-${archive}`);
            write(`${platform}-${manifest}`, { platform: os, arch, archive, sha256: system.files[archive].sha256 });
            system.files[manifest] = seal(`${platform}-${manifest}`);
            payload.launcherBuildReuse[key] = system.files[archive].sha256;
        }
        write(`${platform}-release-manifest.json`, payload);
        system.files['release-manifest.json'] = seal(`${platform}-release-manifest.json`);
        write(`nora-system-${platform}.json`, system);
        write(`Nora-Tavern-package-verification-${platform}.json`, { commit: current.commit, version: '2.3.18', nativeIcon: true,
            instructions: { 'ops/installer/templates/greeting.md': 'hash' } });
        write(`Nora-Tavern-Launcher-2.1.1-${platform.replace('darwin', 'mac').replace('win32', 'win')}${os === 'darwin' ? '.dmg' : '-setup.exe'}`, 'installer');
        const asset = `Nora-${platform}-update.zip`; write(asset, 'launcher');
        write(`nora-launcher-${platform}.json`, { schema: 'nora-launcher/v1', candidate: false, version: '2.1.1', commit: current.commit,
            platform: os, arch, ...seal(asset) });
        last = { platform, payload, system };
    }
    write('release-manifest.json', current);
    const command = () => execFileSync(process.execPath, [fileURLToPath(new URL('../tooling/release/verify-launcher-release.cjs', import.meta.url)),
        output, 'v2.3.18', current.commit, 'full'], { stdio: 'pipe' });
    assert.doesNotThrow(command);
    last.payload.launcherBuildReuse.runtimeSha256 = '0'.repeat(64);
    write(`${last.platform}-release-manifest.json`, last.payload);
    last.system.files['release-manifest.json'] = seal(`${last.platform}-release-manifest.json`);
    write(`nora-system-${last.platform}.json`, last.system);
    assert.throws(command);
});
