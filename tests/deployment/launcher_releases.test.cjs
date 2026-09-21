const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const releases = require('../installer/desktop/releases');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundledRoot = path.join(root, 'payload'); fs.mkdirSync(bundledRoot);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const commit = 'a'.repeat(40);
  const data = {
    'release-manifest.json': JSON.stringify({ schema: 'tavern-release/v2', commit, versions: { tavern: '2.2.8' },
      bootstrap: { sha256: sha('updater'), managedComponents: 1, minimumLauncherVersion: '0.1.0' } }),
    'SHA256SUMS': 'checksums', 'nora-tavern-app.tar.gz': 'app', 'nora-tavern-ops.tar.gz': 'ops',
    'nora-tavern-nora-mcp.tar.gz': 'mcp', 'nora-tavern-first-install-bootstrap.py': 'bootstrap', 'first-install-manifest.json': '{}',
    'hermes.tar.gz': 'hermes', 'dependencies.tar.gz': 'deps',
    'nora-hermes-runtime.json': JSON.stringify({ platform: 'darwin', arch: 'arm64', archive: 'hermes.tar.gz', sha256: sha('hermes') }),
    'nora-tavern-dependencies.json': JSON.stringify({ platform: 'darwin', arch: 'arm64', archive: 'dependencies.tar.gz', sha256: sha('deps') }),
  };
  const system = { schema: 'nora-system/v1', version: '2.2.8', commit, platform: 'darwin', arch: 'arm64',
    launcherVersion: '0.1.0', minimumLauncherVersion: '0.1.0', files: {} };
  for (const [name, bytes] of Object.entries(data)) {
    fs.writeFileSync(path.join(bundledRoot, name), bytes);
    system.files[name] = { asset: `darwin-arm64-${name}`, sha256: sha(bytes), size: Buffer.byteLength(bytes) };
  }
  const names = ['release-manifest.json', 'nora-system-darwin-arm64.json', ...Object.values(system.files).map(i => i.asset)];
  const release = { tag_name: 'v2.2.8', assets: names.map(name => ({ name, browser_download_url: `https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.2.8/${name}` })) };
  const requested = [];
  const fetcher = async url => {
    requested.push(url);
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(release));
    if (url.endsWith('/nora-system-darwin-arm64.json')) return new Response(JSON.stringify(system));
    const name = url.split('/').pop().replace(/^darwin-arm64-/, '');
    return new Response(data[name] || 'missing', { status: name in data ? 200 : 404 });
  };
  return { root, bundledRoot, system, release, requested, data, options: { bundledRoot, cacheRoot: path.join(root, 'cache'), installRoot: root,
    launcherVersion: '0.1.0', platform: 'darwin', arch: 'arm64', fetcher } };
}
test('latest is resolved once, matching packaged bytes are reused, not downloaded', async t => {
  const f = fixture(t); const target = await releases.prepare(f.options);
  assert.equal(f.requested.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'nora-system.json'))).version, '2.2.8');
});
test('bundled upgrade selects only a newer valid platform release and never downgrades', t => {
  const f = fixture(t);
  const file = path.join(f.bundledRoot, 'nora-system.json');
  fs.writeFileSync(file, JSON.stringify(f.system));
  assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion: '2.2.4' }), 'v2.2.8');
  for (const currentVersion of ['2.2.8', '2.3.2', '', null]) {
    assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion }), null);
  }
  for (const changes of [{ candidate: true }, { platform: 'win32' }, { channel: 'beta' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.system, ...changes }));
    assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion: '2.2.4' }), null);
  }
  fs.unlinkSync(file);
  assert.equal(releases.bundledUpgradeTarget({ ...f.options, currentVersion: '2.2.4' }), null);
});
test('historical receipt and legacy runtime versions select the new package on all platform descriptors', async t => {
  const f = fixture(t);
  const versions = ['2.2.4', '2.2.8', '2.2.11', '2.3.0', '2.3.1', '2.3.2', '2.3.3', '2.3.4', '2.3.5', '2.3.6', '2.3.7'];
  const record = path.join(f.root, 'tavern-updates', 'installed.json');
  const runtimeVersion = path.join(f.root, 'apps/tavern-runtime/.tavern-release-version');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.mkdirSync(path.dirname(runtimeVersion), { recursive: true });
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    fs.writeFileSync(path.join(f.bundledRoot, 'nora-system.json'), JSON.stringify({ ...f.system,
      version: '2.3.13', platform, arch }));
    for (const current of versions) {
      for (const schema of [1, 2, null]) {
        if (schema === null) fs.rmSync(record, { force: true });
        else fs.writeFileSync(record, JSON.stringify({ schema, version: current }));
        fs.writeFileSync(runtimeVersion, current);
        const checked = await releases.check(f.options);
        assert.equal(checked.current, current);
        assert.equal(checked.versionSource, schema === null ? 'legacy-runtime' : 'receipt');
        assert.equal(releases.bundledUpgradeTarget({ ...f.options, platform, arch,
          currentVersion: checked.current }), 'v2.3.13', `${platform}/${arch}/${current}/${schema}`);
      }
    }
  }
});
test('first install validates bundled release without requesting GitHub or creating download cache', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot, 'nora-system.json'), JSON.stringify(f.system));
  const root = await releases.prepareBundled({ ...f.options, fetcher: () => { throw new Error('offline'); } });
  assert.equal(root, f.bundledRoot);
  assert.deepEqual(f.requested, []);
  assert.equal(fs.existsSync(f.options.cacheRoot), false);
});
test('bundled install fails closed on missing or corrupt files without network fallback', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundledRoot, 'nora-system.json'), JSON.stringify(f.system));
  const file = path.join(f.bundledRoot, 'nora-tavern-app.tar.gz');
  fs.writeFileSync(file, 'bad');
  await assert.rejects(releases.prepareBundled(f.options), /组件校验失败/);
  fs.unlinkSync(file);
  await assert.rejects(releases.prepareBundled(f.options), /缺少组件/);
  assert.deepEqual(f.requested, []);
});
test('bundled install rejects wrong platform, candidate and incompatible launcher', async t => {
  const f = fixture(t);
  const file = path.join(f.bundledRoot, 'nora-system.json');
  for (const changes of [{ platform: 'win32' }, { candidate: true }, { minimumLauncherVersion: '99.0.0' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.system, ...changes }));
    await assert.rejects(releases.prepareBundled(f.options));
  }
  assert.deepEqual(f.requested, []);
});
test('bundled install honors cancellation and rejects inconsistent inner manifests', async t => {
  const f = fixture(t);
  const file = path.join(f.bundledRoot, 'nora-system.json');
  fs.writeFileSync(file, JSON.stringify(f.system));
  await assert.rejects(releases.prepareBundled({ ...f.options, signal: AbortSignal.abort() }), { name: 'AbortError' });
  f.system.commit = 'b'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(f.system));
  await assert.rejects(releases.prepareBundled(f.options), /内部版本/);
});
test('older packaged component is replaced from the pinned release, never latest/download', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.bundledRoot, 'nora-tavern-app.tar.gz'), 'old');
  const target = await releases.prepare(f.options);
  assert.equal(fs.readFileSync(path.join(target, 'nora-tavern-app.tar.gz'), 'utf8'), 'app');
  assert.ok(f.requested.at(-1).includes('/download/v2.2.8/'));
});
test('missing platform package stops before creating install cache', async t => {
  const f = fixture(t); f.release.assets = [];
  await assert.rejects(releases.prepare(f.options), /缺少完整组件/);
  assert.equal(fs.existsSync(f.options.cacheRoot), false);
});
test('a newer release without an updater manifest is blocked', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'tavern-updates'));
  fs.writeFileSync(path.join(f.root, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.2.4' }));
  f.release.assets = [];
  const result = await releases.check(f.options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.available, false);
  assert.equal(result.releaseAvailable, true);
  assert.equal(result.installable, false);
  assert.equal(result.latest, 'v2.2.8');
  assert.match(result.compatibilityError, /release-manifest.json/);
});
test('an incompatible component updater is blocked', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'tavern-updates'));
  fs.writeFileSync(path.join(f.root, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.2.8' }));
  const manifest = JSON.parse(f.data['release-manifest.json']);
  manifest.bootstrap.minimumLauncherVersion = '99.0.0';
  f.data['release-manifest.json'] = JSON.stringify(manifest);
  const result = await releases.check(f.options);
  assert.equal(result.state, 'blocked');
  assert.equal(result.available, false);
  assert.match(result.compatibilityError, /升级启动器/);
});
test('corrupt downloads are rejected and incomplete file is removed', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.bundledRoot, 'nora-tavern-app.tar.gz'));
  f.data['nora-tavern-app.tar.gz'] = 'bad';
  await assert.rejects(releases.prepare(f.options), /校验失败/);
  const directory = path.join(f.options.cacheRoot, fs.readdirSync(f.options.cacheRoot)[0]);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.partial')), false);
});
test('missing installed version is unknown, not an available update or latest', async t => {
  const f = fixture(t); const result = await releases.check(f.options);
  assert.equal(result.state, 'unknown'); assert.equal(result.available, false);
  assert.equal(result.latest, 'v2.2.8');
});
test('legacy installation version is read from its actual release file without mutating it', async t => {
  const f = fixture(t); const directory = path.join(f.root, 'apps/tavern-runtime');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.tavern-release-version'), '2.2.4\n');
  const result = await releases.check(f.options);
  assert.equal(result.current, '2.2.4'); assert.equal(result.state, 'available');
  assert.equal(result.versionSource, 'legacy-runtime');
  assert.equal(fs.existsSync(path.join(f.root, 'tavern-updates/installed.json')), false);
});
test('network failure and ahead build are distinct states', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'tavern-updates/installed.json'); fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: '2.2.9' }));
  assert.equal((await releases.check(f.options)).state, 'ahead');
  const failed = await releases.check({ ...f.options, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.current, '2.2.9');
});
test('unsupported launcher and candidate release are rejected', async t => {
  const f = fixture(t); f.system.minimumLauncherVersion = '0.2.0';
  await assert.rejects(releases.prepare(f.options), /升级启动器/);
  f.system.minimumLauncherVersion = '0.1.0'; f.system.candidate = true;
  await assert.rejects(releases.prepare(f.options), /清单/);
});
test('platform manifest produced by packager is consumed without modifying the payload', async t => {
  const f = fixture(t);
  const { writeSystemRelease } = await import('../scripts/system-release.mjs');
  const output = writeSystemRelease({ release: f.root, payload: f.bundledRoot, launcherVersion: '0.3.4',
    identity: { commit: f.system.commit, versions: { tavern: '2.2.8' }, hermesRuntime: { platform: 'darwin', arch: 'arm64' } } });
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'nora-system-darwin-arm64.json')));
  releases.validateSystem(manifest, f.release, 'darwin', 'arm64', '0.3.4');
  assert.throws(() => releases.validateSystem(manifest, f.release, 'darwin', 'arm64', '0.3.3'), /升级启动器/);
  for (const [name, item] of Object.entries(manifest.files)) {
    assert.equal(await releases.hash(path.join(output, item.asset)), item.sha256);
    assert.equal(await releases.hash(path.join(f.bundledRoot, name)), item.sha256);
  }
});

test('beta discovery selects semantic latest beta, excluding stable, drafts and other channels', async () => {
  const rows = [
    { tag_name: 'v9.0.0', prerelease: false },
    { tag_name: 'v2.2.9-beta.20', prerelease: true, draft: true },
    { tag_name: 'v2.2.9-rc.1', prerelease: true },
    { tag_name: 'v2.2.9-beta.2', prerelease: true },
    { tag_name: 'v2.2.9-beta.10', prerelease: true },
  ];
  const fetched = [];
  const value = await releases.latest(async url => { fetched.push(url); return new Response(JSON.stringify(rows)); }, undefined, 'beta');
  assert.equal(value.tag_name, 'v2.2.9-beta.10');
  assert.ok(fetched[0].includes('/releases?'));
  assert.equal(releases.accepts(value, 'stable'), false);
  assert.equal(releases.compare('2.2.9-beta.10', '2.2.9-beta.2'), 1);
});
test('beta download keeps release verification and rejects stable or candidate substitution', async t => {
  const f = fixture(t);
  const beta = { ...f.release, tag_name: 'v2.2.9-beta.1', prerelease: true };
  await assert.rejects(releases.latest(async () => new Response(JSON.stringify(beta)), undefined, 'stable', beta.tag_name), /正式/);
  assert.throws(() => releases.validateSystem(f.system, f.release, 'darwin', 'arm64', '0.3.0', 'beta'), /清单/);
  assert.equal(releases.compare('bad', beta.tag_name), null);
});
