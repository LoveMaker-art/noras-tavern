import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemblePlatform, assertReusable, PLATFORMS } from '../tooling/release/package-component-update.mjs';
import { fileDigest } from '../tooling/release/system-release.mjs';
import { NORA_SYSTEM_REQUIRED_FILES } from '../tooling/release/release-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceNames = ['launcher/desktop/main.js', 'launcher/ui/index.html',
    'deployment/update/releases.js', 'deployment/update/system-update.js',
    'tooling/release/package-hermes-runtime.mjs', 'tooling/source-layout.json',
    'app/engine/sillytavern/package.json', 'app/engine/sillytavern/package-lock.json',
    'nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json'];

function fixture(t, platform = 'darwin-arm64') {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const release = path.join(temporary, 'release'), baselineRoot = path.join(temporary, 'baseline');
    fs.mkdirSync(release); fs.mkdirSync(baselineRoot);
    const [systemPlatform, arch] = platform.split('-');
    const baseline = { schema: 'tavern-release/v2', candidate: false, commit: 'a'.repeat(40),
        versions: { tavern: '2.3.0' }, sourceFiles: Object.fromEntries(sourceNames.map(name => [name, 'a'.repeat(64)])) };
    const current = { ...baseline, commit: 'b'.repeat(40), versions: { tavern: '2.3.1' },
        sourceFiles: { ...baseline.sourceFiles, 'deployment/update/update.py': 'c'.repeat(64), 'nora/greeting.md': 'd'.repeat(64) },
        artifacts: Object.fromEntries(NORA_SYSTEM_REQUIRED_FILES.map(name => [name, 'e'.repeat(64)])) };
    const write = (directory, name, value) => {
        fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    };
    const system = { schema: 'nora-system/v1', candidate: false, channel: 'stable', platform: systemPlatform, arch,
        version: '2.3.0', commit: baseline.commit, launcherVersion: '0.3.3', minimumLauncherVersion: '0.3.2', files: {} };
    for (const [manifestName, archive, bytes, identityKey] of [
        ['nora-hermes-runtime.json', 'hermes.tar.gz', 'hermes-python-node', 'hermesRuntime'],
        ['nora-tavern-dependencies.json', 'deps.tar.gz', 'native-dependencies', 'dependencies'],
    ]) {
        write(baselineRoot, archive, bytes);
        const descriptor = { schema: 1, platform: systemPlatform, arch, archive, sha256: fileDigest(path.join(baselineRoot, archive)) };
        write(baselineRoot, manifestName, descriptor); baseline[identityKey] = descriptor;
    }
    for (const name of fs.readdirSync(baselineRoot)) system.files[name] = {
        asset: `${platform}-${name}`, size: fs.statSync(path.join(baselineRoot, name)).size,
        sha256: fileDigest(path.join(baselineRoot, name)),
    };
    current.archives = {};
    for (const name of ['nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz',
        'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json']) {
        write(release, name, 'new-'+name);
        if (name.endsWith('.tar.gz')) current.archives[name] = { name, sha256: fileDigest(path.join(release, name)) };
    }
    current.modules = {};
    write(release, 'release-manifest.json', current);
    write(release, 'SHA256SUMS', fs.readdirSync(release).map(name => `${fileDigest(path.join(release, name))}  ${name}\n`).join(''));
    return { temporary, release, baselineRoot, baseline, system, current, output: path.join(temporary, 'output'), write };
}

test('only mutable system content can reuse environments; shell and lock changes fail closed', t => {
    const f = fixture(t);
    assert.doesNotThrow(() => assertReusable(f.current, f.baseline));
    for (const name of sourceNames) assert.throws(() => assertReusable({ ...f.current,
        sourceFiles: { ...f.current.sourceFiles, [name]: 'changed' } }, f.baseline), /Full launcher build required/);
    assert.throws(() => assertReusable({ ...f.current, sourceFiles: {} }, f.baseline), /Full launcher/);
    assert.throws(() => assertReusable(f.current, { ...f.baseline, candidate: true }), /stable release/);
    assert.throws(() => assertReusable({ ...f.current, artifacts: {} }, f.baseline), /Incomplete Nora/);
});

for (const platform of PLATFORMS) test(`${platform}: new system identity keeps byte-identical environments and old-client compatibility`, async t => {
    const f = fixture(t, platform);
    assemblePlatform(f);
    const assetsRoot = path.join(f.output, 'system-assets');
    const system = JSON.parse(fs.readFileSync(path.join(assetsRoot, `nora-system-${platform}.json`)));
    assert.equal(system.version, '2.3.1'); assert.equal(system.commit, f.current.commit);
    assert.equal(system.minimumLauncherVersion, '0.3.2'); assert.equal(system.launcherVersion, '0.3.3');
    assert.equal(system.files['hermes.tar.gz'].sha256, f.system.files['hermes.tar.gz'].sha256);
    assert.equal(system.files['deps.tar.gz'].sha256, f.system.files['deps.tar.gz'].sha256);
    assert.ok(!fs.readdirSync(assetsRoot).some(name => /\.(?:dmg|exe|zip)$/.test(name)));
    const desktopRequire = createRequire(path.join(root, 'launcher/desktop/package.json'));
    fs.cpSync(path.dirname(desktopRequire.resolve('semver/package.json')), path.join(f.temporary, 'node_modules/semver'), { recursive: true });
    fs.copyFileSync(path.join(root, 'deployment/update/releases.js'), path.join(f.temporary, 'releases.cjs'));
    const client = createRequire(import.meta.url)(path.join(f.temporary, 'releases.cjs'));
    const tag = 'v2.3.1', base = `https://github.com/LoveMaker-art/noras-tavern/releases/download/${tag}/`;
    const release = { tag_name: tag, draft: false, prerelease: false, assets: fs.readdirSync(assetsRoot)
        .map(name => ({ name, browser_download_url: base+name })) };
    const fetched = [];
    const fetcher = async url => {
        fetched.push(url);
        return new Response(url.endsWith('/releases/latest') ? JSON.stringify(release) : fs.readFileSync(path.join(assetsRoot, url.split('/').pop())));
    };
    const prepared = await client.prepare({ cacheRoot: path.join(f.temporary, 'cache'), bundledRoot: f.baselineRoot,
        launcherVersion: '0.3.3', platform: system.platform, arch: system.arch, fetcher });
    assert.equal(JSON.parse(fs.readFileSync(path.join(prepared, 'nora-system.json'))).version, '2.3.1');
    assert.ok(!fetched.some(url => url.endsWith('-hermes.tar.gz') || url.endsWith('-deps.tar.gz')), 'Matching bundled environments should not download again');
    release.assets = release.assets.filter(a => a.name !== system.files['hermes.tar.gz'].asset);
    await assert.rejects(client.prepare({ cacheRoot: path.join(f.temporary, 'empty-cache'), bundledRoot: f.baselineRoot,
        launcherVersion: '0.3.3', platform: system.platform, arch: system.arch, fetcher }), /缺少完整组件/);
});

test('corrupt or wrong-platform baseline is refused', t => {
    const f = fixture(t);
    f.system.platform = 'win32';
    assert.throws(() => assemblePlatform(f));
    f.system.platform = 'darwin';
    fs.writeFileSync(path.join(f.baselineRoot, 'hermes.tar.gz'), 'damaged');
    assert.throws(() => assemblePlatform(f), /mismatch/);
});

test('component verifier requires complete system assets without requiring new installers', t => {
    const f = fixture(t);
    const reused = [];
    for (const platform of PLATFORMS) {
        const item = fixture(t, platform); reused.push(assemblePlatform({ ...item, output: f.output }));
    }
    fs.cpSync(f.release, path.join(f.output, 'shared'), { recursive: true });
    f.write(f.output, 'component-release.json', { schema: 'nora-component-release/v1', version: '2.3.1', commit: f.current.commit,
        baselineTag: 'v2.3.0', installerTag: 'v2.3.0', reused });
    const args = ['tooling/release/verify-launcher-release.cjs', f.output, 'v2.3.1', f.current.commit];
    assert.doesNotThrow(() => execFileSync(process.execPath, [...args, 'components'], { cwd: root, stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, [...args, 'full'], { cwd: root, stdio: 'pipe' }));
    fs.unlinkSync(path.join(f.output, 'system-assets/nora-system-win32-x64.json'));
    assert.throws(() => execFileSync(process.execPath, [...args, 'components'], { cwd: root, stdio: 'pipe' }));
});
