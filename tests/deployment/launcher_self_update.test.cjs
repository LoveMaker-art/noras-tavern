const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const releases = require('../installer/desktop/releases');
const update = require('../installer/desktop/launcher-update');
const { createLocalRelease } = require('../installer/desktop/local-release');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-self-update-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const manifest = { schema: 'tavern-release/v2', commit: 'a'.repeat(40), versions: { tavern: '2.4.0' }, launcherVersion: '1.1.0',
    bootstrap: { sha256: sha('bootstrap'), managedComponents: 1, minimumLauncherVersion: '1.1.0' } };
  const item = { schema: 'nora-launcher/v1', version: '1.1.0', platform: 'win32', arch: 'x64',
    asset: 'Nora-Tavern-Launcher-1.1.0-win32-x64-update.zip', sha256: sha('archive'), size: 7 };
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'nora-launcher-win32-x64.json'), JSON.stringify(item));
  fs.writeFileSync(path.join(root, item.asset), 'archive');
  const installRoot = path.join(root, 'tavern');
  fs.mkdirSync(path.join(installRoot, 'tavern-updates'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.4.0' }));
  return { root, item, installRoot, options: { platform: 'win32', arch: 'x64', launcherVersion: '1.0.0',
    fetcher: createLocalRelease(root), cacheRoot: path.join(root, 'cache'), channel: 'stable' } };
}
test('one update remains available when only the launcher is outdated; minimum version is satisfied after replacement', async t => {
  const f = fixture(t);
  const checked = await releases.check({ ...f.options, installRoot: f.installRoot });
  assert.equal(checked.available, true);
  assert.equal(checked.state, 'available');
  const prepared = await update.prepare(f.options);
  assert.equal(prepared.tag, 'v2.4.0');
  assert.equal(fs.readFileSync(prepared.launcher.archive, 'utf8'), 'archive');
  assert.equal((await update.prepare({ ...f.options, launcherVersion: '1.1.0' })).launcher, null);
});

test('desktop replacement status routes legacy 2.3.2 to the bundled 2.3.13 release', async t => {
  const f = fixture(t);
  const manifestFile = path.join(f.root, 'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.versions.tavern = '2.3.13';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const required = ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz',
    'nora-tavern-nora-mcp.tar.gz', 'nora-tavern-first-install-bootstrap.py', 'first-install-manifest.json',
    'nora-hermes-runtime.json', 'nora-tavern-dependencies.json'];
  fs.writeFileSync(path.join(f.root, 'nora-system.json'), JSON.stringify({ schema: 'nora-system/v1',
    version: '2.3.13', commit: manifest.commit, platform: process.platform, arch: process.arch,
    minimumLauncherVersion: '1.1.0', files: Object.fromEntries(required.map(name => [name,
      { asset: name, sha256: 'a'.repeat(64), size: 1 }])) }));
  const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
  let status;
  const context = vm.createContext({ handle: (_name, fn) => { status = fn; },
    quitting: false, uninstalling: false, selectingLocation: false, modelBusy: false,
    statusRequest: null, activeRun: false, LOCAL_TEST: null, CHANNEL: 'stable',
    systemUpdate: { pending: () => false }, noraHome: () => f.root,
    readInstallerState: () => ({ phase: 'ready' }), findPython: () => true,
    runBridge: async () => ({ installed: true, hermesInstalled: true, version: '2.3.2', systemReady: true }),
    releases, payloadDirectory: () => f.root, app: { getVersion: () => '1.1.0' }, locationStatus: () => ({}),
    nodeStatus: warning => { throw new Error(warning || 'unexpected fallback'); },
  });
  vm.runInContext(source.slice(source.indexOf("  handle('nora:status'"), source.indexOf("  handle('nora:choose-directory'")), context);
  const snapshot = await status();
  assert.equal(snapshot.bundledUpgradeTarget, 'v2.3.13');
  const ui = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
  let request;
  vm.runInNewContext(ui.slice(ui.indexOf('  function route()'), ui.indexOf('  function taskView(')) + '\nroute();', {
    snapshot, bundledUpgradeAttempted: false, run: (action, options) => { request = { action, ...options }; },
  });
  assert.equal(request.action, 'update');
  const urls = [];
  const fetcher = createLocalRelease(f.root);
  const prepared = await update.prepare({ ...f.options, launcherVersion: '1.1.0', tag: request.tag,
    fetcher: (url, options) => { urls.push(url); return fetcher(url, options); } });
  assert.equal(prepared.tag, 'v2.3.13');
  assert.equal(prepared.launcher, null);
  assert.ok(urls.some(url => url.endsWith('/releases/tags/v2.3.13')));
  assert.equal(urls.some(url => url.includes('v2.3.2')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'cache')), false);
});
test('corrupt download and mismatched platform never reach replacement', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, f.item.asset), 'changed');
  await assert.rejects(update.prepare(f.options), /校验失败/);
  fs.writeFileSync(path.join(f.root, 'nora-launcher-win32-x64.json'), JSON.stringify({ ...f.item, arch: 'arm64' }));
  await assert.rejects(update.prepare(f.options), /清单无效/);
});
test('resume acknowledges the matching executable once and never repeats automatically', t => {
  const { root } = fixture(t);
  const job = path.join(root, 'installer/launcher-update/job-test');
  fs.mkdirSync(job, { recursive: true });
  const executable = path.join(root, 'application/launcher.exe');
  fs.writeFileSync(path.join(job, 'plan.json'), JSON.stringify({ schema: 1, home: root, appRoot: path.dirname(executable),
    executable: 'launcher.exe', version: '1.1.0', target: 'v2.4.0', token: 'test-token' }));
  assert.equal(update.resume(job, { home: root, executable, version: '1.1.0' }).target, 'v2.4.0');
  assert.equal(update.resume(job, { home: root, executable, version: '1.1.0' }), null);
  assert.throws(() => update.resume(job, { home: root, executable, version: '1.0.0' }), /不匹配/);
  assert.equal(update.resume('/untrusted/job-test', { home: root, executable, version: '1.1.0' }), null);
});

test('Windows portable refuses replacing its temporary extraction directory before writing anything', async () => {
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = 'D:\\Nora-portable.exe';
  try {
    await assert.rejects(update.handoff({}), /便携版/);
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = previous;
  }
});

test('replacement helper does not inherit the occupied Windows application working directory', async t => {
  const { root } = fixture(t);
  const application = path.join(root, 'application');
  const home = path.join(root, 'data');
  fs.mkdirSync(application);
  const helper = path.join(root, 'replace.py');
  fs.writeFileSync(helper, '# fixture');
  const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/launcher-update.js'), 'utf8');
  let workingDirectory;
  const context = vm.createContext({ module: { exports: {} }, process: { env: {}, platform: 'win32', arch: 'x64', pid: 42 },
    setTimeout, require: name => name === 'node:child_process' ? { spawn(_python, args, options) {
      workingDirectory = options.cwd;
      fs.writeFileSync(path.join(args[2], 'status.json'), JSON.stringify({ status: 'prepared' }));
      const child = new EventEmitter(); child.unref = () => {}; return child;
    } } : require(name) });
  vm.runInContext(source, context);
  const job = await context.module.exports.handoff({ home, executable: path.join(application, 'launcher.exe'), python: 'python', helper,
    prepared: { tag: 'v2.4.0', launcher: { version: '1.1.0', sha256: 'a'.repeat(64), archive: '/fixture.zip' } } });
  assert.equal(workingDirectory, job);
  assert.ok(!workingDirectory.startsWith(application + path.sep));
});
