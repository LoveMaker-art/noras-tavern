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
    'release-manifest.json': JSON.stringify({ commit, versions: { tavern: '2.2.8' } }),
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
  const names = ['nora-system-darwin-arm64.json', ...Object.values(system.files).map(i => i.asset)];
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
test('a newer release without a complete platform package is blocked, not an available update', async t => {
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
  assert.match(result.compatibilityError, /nora-system-darwin-arm64.json/);
});
test('matching version without a valid system manifest is not reported as a current complete system', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'tavern-updates'));
  fs.writeFileSync(path.join(f.root, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.2.8' }));
  f.system.minimumLauncherVersion = '99.0.0';
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
