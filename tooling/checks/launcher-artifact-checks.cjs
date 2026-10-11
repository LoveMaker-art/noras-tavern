const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const appAssertions = ['actualElectron', 'nativeDependencyComplete',
  'allFlatResourceHashesMatchCandidate', 'jsPythonReceiptAgree', 'arbitraryCliRefusedBeforeOperation'];
const networkModules = ['release-network.js', 'release-sources.js', 'launcher-errors.js', 'release-sources.json'];
const networkAssertions = ['manualRedirect', 'sourceFallback', 'untrustedRedirectRefused', 'abort', 'sessionProxy', 'streaming', 'deadline'];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function only(items, label) {
  assert.equal(items.length, 1, `Expected exactly one ${label}, found ${items.length}`);
  return items[0];
}
function regular(file) {
  assert.ok(typeof file === 'string' && file.length > 0, 'An explicit file path is required');
  assert.ok(fs.statSync(file).isFile(), `Missing file: ${file}`);
  return path.resolve(file);
}
function selectRelease(directory = path.join(repository, 'release')) {
  return only(fs.readdirSync(directory, { withFileTypes: true })
    .filter(item => item.isDirectory() && /^(candidate|stable)-/.test(item.name))
    .map(item => path.join(directory, item.name)), 'release payload');
}
function selectApplication(dist, platform = process.platform) {
  dist = path.resolve(dist);
  let directory, resources;
  if (platform === 'win32') {
    directory = path.join(dist, 'win-unpacked');
    resources = path.join(directory, 'resources');
  } else {
    assert.equal(platform, 'darwin', 'Unsupported APP verification platform');
    const output = only(fs.readdirSync(dist, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^mac(?:-|$)/.test(item.name))
      .map(item => path.join(dist, item.name)), 'Mac output directory');
    const app = only(fs.readdirSync(output, { withFileTypes: true })
      .filter(item => item.isDirectory() && item.name.endsWith('.app'))
      .map(item => path.join(output, item.name)), 'Mac application');
    directory = path.join(app, 'Contents/MacOS');
    resources = path.join(app, 'Contents/Resources');
  }
  // Helpers under resources (including elevate.exe) are never application candidates.
  const executable = only(fs.readdirSync(directory, { withFileTypes: true })
    .filter(item => item.isFile() && (platform !== 'win32' || /\.exe$/i.test(item.name)))
    .map(item => path.join(directory, item.name)), 'root application executable');
  return { executable: regular(executable), asar: regular(path.join(resources, 'app.asar')) };
}
function runChecked(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: repository, stdio: 'inherit',
    timeout: 600000, windowsHide: true, ...options, shell: false });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Process ended with signal ${result.signal}`);
  if (result.status !== 0) {
    const error = new Error(`Process exited ${result.status}: ${executable}`);
    error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw error;
  }
  return result;
}
function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function resolveWindowsCheckRuntime(env = process.env, { moved = false } = {}) {
  assert.ok(typeof env.RUNNER_TEMP === 'string' && path.isAbsolute(env.RUNNER_TEMP), 'An absolute runner temporary directory is required');
  const original = path.join(env.RUNNER_TEMP, 'hermes');
  const captured = Object.hasOwn(env, 'NORA_TEST_MANAGED_PYTHON_ROOT');
  const expected = captured ? env.NORA_TEST_MANAGED_PYTHON_ROOT : path.join(original, 'python');
  assert.ok(typeof expected === 'string' && path.isAbsolute(expected), 'The captured Python root must be absolute');
  assert.ok(within(original, expected), 'The captured Python root escapes the original Hermes tree');
  // Cold bootstraps and restored archives have different layouts. Preserve the
  // captured relative base-prefix binding; package-check restores the fixed
  // archive layout and has no cold-bootstrap environment to inherit.
  const home = fs.realpathSync(path.join(env.RUNNER_TEMP, moved ? 'hermes-build-source' : 'hermes'));
  const base = fs.realpathSync(path.join(home, path.relative(original, expected)));
  assert.ok(fs.statSync(base).isDirectory() && within(home, base), 'The actual Python root escapes the isolated Hermes tree');
  const python = fs.realpathSync(regular(path.join(base, 'python.exe')));
  assert.ok(within(base, python), 'The base interpreter escapes its verified Python root');
  return { home, base, python, venv: path.join(home, 'hermes-agent/venv') };
}
function verifyCheckPythonIdentity(value, runtime, { venv = false } = {}) {
  assert.ok(value && typeof value === 'object', 'Missing actual Python identity');
  const expectedPrefix = fs.realpathSync(venv ? runtime.venv : runtime.base);
  assert.ok(within(runtime.home, expectedPrefix), 'The actual interpreter prefix escapes the isolated Hermes tree');
  assert.equal(fs.realpathSync(value.prefix), expectedPrefix, 'Actual sys.prefix differs from the selected runtime');
  assert.equal(fs.realpathSync(value.basePrefix), runtime.base, 'Actual sys.base_prefix differs from the captured runtime');
  const executable = venv ? path.join(runtime.venv, 'Scripts/python.exe') : runtime.python;
  assert.equal(fs.realpathSync(regular(value.executable)), fs.realpathSync(regular(executable)), 'Actual Python executable differs from the selected runtime');
  if (venv) assert.ok(within(expectedPrefix, fs.realpathSync(regular(value.psutil))), 'psutil must originate inside the selected venv');
  return true;
}
function checkWindowsPython(env = process.env, { moved = false, venv = false } = {}) {
  const runtime = resolveWindowsCheckRuntime(env, { moved });
  const python = venv ? regular(path.join(runtime.venv, 'Scripts/python.exe')) : runtime.python;
  const source = 'import json,sys' + (venv ? ',psutil' : '') + '; print(json.dumps({'
    + '"prefix":sys.prefix,"basePrefix":sys.base_prefix,"executable":sys.executable'
    + (venv ? ',"psutil":psutil.__file__' : '') + '}))';
  const result = runChecked(python, ['-B', '-I', '-c', source], { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  verifyCheckPythonIdentity(JSON.parse(result.stdout), runtime, { venv });
  return python;
}
function withRestoredWindowsCheckRuntime(env, check) {
  assert.ok(typeof env.RUNNER_TEMP === 'string' && path.isAbsolute(env.RUNNER_TEMP), 'An absolute runner temporary directory is required');
  const moved = path.join(env.RUNNER_TEMP, 'hermes-build-source'), original = path.join(env.RUNNER_TEMP, 'hermes');
  assert.ok(fs.existsSync(moved), 'Missing isolated test runtime');
  assert.ok(!fs.existsSync(original) && !fs.lstatSync(original, { throwIfNoEntry: false }), 'Original runtime must remain absent before archive or APP checks');
  // Managed Python minor-version junctions and the cold venv refer to the
  // original absolute path. Keep it restored for the whole synchronous gate.
  fs.renameSync(moved, original);
  try {
    return check();
  } finally {
    fs.renameSync(original, moved);
  }
}
function verifyAppReport(file, { executable, asar, launcher, platform = process.platform, arch = process.arch }) {
  regular(file);
  const value = read(file);
  assert.equal(value.schema, 'nora-app-candidate-gate/1');
  assert.equal(value.platform, platform);
  assert.equal(value.arch, arch);
  assert.ok(value.versions?.electron, 'The APP check must run in real Electron');
  for (const name of appAssertions) assert.equal(value.assertions?.[name], true, `Missing APP proof: ${name}`);
  assert.equal(fs.realpathSync(value.executable.path), fs.realpathSync(executable));
  assert.equal(value.executable.sha256, sha(executable));
  assert.equal(fs.realpathSync(value.asar.path), fs.realpathSync(asar));
  assert.equal(value.asar.sha256, sha(asar));
  assert.equal(value.payloadManifestSha256, sha(path.join(path.dirname(asar), 'payload/nora-system.json')));
  assert.equal(value.packageLockSha256, sha(path.join(launcher, 'desktop/package-lock.json')));
  const pkg = read(path.join(launcher, 'desktop/package.json'));
  assert.deepEqual(Object.keys(value.moduleHashes).sort(), [...pkg.build.files].sort());
  for (const name of pkg.build.files) assert.equal(value.moduleHashes[name], sha(path.join(launcher, 'desktop', name)));
  return value;
}
function checkApp({ release = selectRelease(), installed, python = process.env.NORA_TEST_PYTHON,
  report, platform = process.platform }) {
  const launcher = path.resolve(release, 'nora-tavern-launcher');
  const selected = selectApplication(path.join(launcher, 'desktop/dist'), platform);
  if (installed) {
    assert.equal(platform, 'win32');
    selected.executable = regular(path.join(installed, path.basename(selected.executable)));
    selected.asar = regular(path.join(installed, 'resources/app.asar'));
  }
  regular(python);
  report = path.resolve(report || path.join(process.env.RUNNER_TEMP,
    installed ? 'nora-installed-app-acceptance.json' : 'nora-packaged-app-acceptance.json'));
  assert.ok(!fs.existsSync(report), `Refusing a stale APP report: ${report}`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NORA_CANDIDATE_LAUNCHER: launcher,
    NORA_PACKED_DESKTOP: selected.asar, NORA_TEST_PYTHON: path.resolve(python), NORA_GATE_REPORT: report };
  console.log(`APP executable: ${selected.executable}\nAPP ASAR: ${selected.asar}\nReceipt Python: ${env.NORA_TEST_PYTHON}`);
  runChecked(selected.executable, ['--test', path.join(repository, 'tests/deployment/launcher_packaged_app.test.cjs')], { env });
  verifyAppReport(report, { ...selected, launcher, platform });
  console.log(`PASS: completed actual ${installed ? 'installed' : 'unpacked'} APP check with fresh complete evidence`);
}
function verifyNetworkReport(file, {executable, asar, launcher, platform = process.platform, arch = process.arch}) {
  const value = read(regular(file));
  assert.equal(value.schema, 'nora-electron-network/1');
  assert.equal(value.scope, 'packaged-network-modules-in-native-chromium');
  assert.equal(value.platform, platform);
  assert.equal(value.arch, arch);
  assert.ok(value.versions?.electron, 'Network verification must run Chromium');
  assert.equal(value.actualChromiumNet, true);
  assert.equal(value.windowCount, 0);
  for (const name of networkAssertions) assert.equal(value.assertions?.[name], true, `Missing real network proof: ${name}`);
  assert.equal(fs.realpathSync(value.executable.path), fs.realpathSync(executable));
  assert.equal(value.executable.sha256, sha(executable));
  assert.equal(value.runtimeExecutable.sha256, value.executable.sha256, 'The isolated native runtime must have identical executable bytes');
  assert.equal(fs.realpathSync(value.asar.path), fs.realpathSync(asar));
  assert.equal(value.asar.sha256, sha(asar));
  assert.deepEqual(Object.keys(value.moduleHashes).sort(), [...networkModules].sort());
  for (const name of networkModules) assert.equal(value.moduleHashes[name], sha(path.join(launcher, 'desktop', name)));
  return value;
}
function copyNetworkRuntime(source, runtime, resources) {
  // Framework links must remain relative to this copy for Chromium helpers.
  fs.cpSync(source, runtime, {recursive: true, dereference: false, verbatimSymlinks: true,
    filter: file => file === resources || !file.startsWith(resources + path.sep)});
}
function checkNetwork({release = selectRelease(), installed, report, platform = process.platform}) {
  const launcher = path.resolve(release, 'nora-tavern-launcher');
  const selected = selectApplication(path.join(launcher, 'desktop/dist'), platform);
  if (installed) {
    assert.equal(platform, 'win32');
    selected.executable = regular(path.join(installed, path.basename(selected.executable)));
    selected.asar = regular(path.join(installed, 'resources/app.asar'));
  }
  report = path.resolve(report || path.join(process.env.RUNNER_TEMP || os.tmpdir(),
    installed ? 'nora-installed-network-acceptance.json' : 'nora-electron-network-acceptance.json'));
  assert.ok(!fs.existsSync(report), `Refusing a stale network report: ${report}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-candidate-network-'));
  try {
    const source = platform === 'darwin' ? path.dirname(path.dirname(path.dirname(selected.executable))) : path.dirname(selected.executable);
    const resources = path.dirname(selected.asar);
    const runtime = path.join(directory, path.basename(source));
    // The copied runtime has the candidate's exact executable/framework bytes.
    // Its isolated app entry runs only the fixture; product code is required
    // directly from the original immutable ASAR, never rewritten or extracted.
    copyNetworkRuntime(source, runtime, resources);
    const runtimeResources = path.join(runtime, path.relative(source, resources));
    const fixtureApp = path.join(runtimeResources, 'app');
    fs.mkdirSync(fixtureApp, {recursive: true});
    fs.writeFileSync(path.join(fixtureApp, 'package.json'), JSON.stringify({name: 'nora-candidate-network-gate', version: '1.0.0', main: 'main.cjs'}));
    fs.writeFileSync(path.join(fixtureApp, 'main.cjs'), `require(${JSON.stringify(path.join(repository, 'tests/deployment/launcher_electron_network.test.cjs'))});\n`);
    const executable = path.join(runtime, path.relative(source, selected.executable));
    assert.equal(sha(executable), sha(selected.executable));
    const env = {...process.env, NORA_ELECTRON_NETWORK_HOME: directory,
      NORA_ELECTRON_NETWORK_DESKTOP: selected.asar, NORA_ELECTRON_NETWORK_ASAR: selected.asar,
      NORA_ELECTRON_NETWORK_ORIGINAL_EXECUTABLE: selected.executable};
    delete env.ELECTRON_RUN_AS_NODE;
    runChecked(executable, [], {env, timeout: 40000});
    const candidateReport = path.join(directory, 'report.json');
    verifyNetworkReport(candidateReport, {...selected, launcher, platform});
    fs.copyFileSync(candidateReport, report, fs.constants.COPYFILE_EXCL);
    console.log(`PASS: actual candidate Chromium network modules; evidence ${report}`);
  } finally {
    const candidateReport = path.join(directory, 'report.json');
    if (fs.existsSync(candidateReport) && !fs.existsSync(report)) fs.copyFileSync(candidateReport, report, fs.constants.COPYFILE_EXCL);
    fs.rmSync(directory, {recursive: true, force: true});
  }
}
function checkReplacement(release = selectRelease(), env = process.env) {
  const desktop = path.resolve(release, 'nora-tavern-launcher/desktop');
  const archive = only(fs.readdirSync(path.join(desktop, 'dist'))
    .filter(name => name.endsWith('-update.zip')).map(name => path.join(desktop, 'dist', name)), 'launcher update archive');
  regular(archive);
  regular(path.join(desktop, 'package.json'));
  const verify = py => {
    runChecked(process.execPath, [path.join(repository, 'tooling/run.mjs'), regular(py), '-B', '-m',
      'unittest', 'tests.deployment.test_launcher_replacement', '-v'], { env: { ...env,
      NORA_TEST_LAUNCHER_ARCHIVE: path.resolve(archive), NORA_TEST_LAUNCHER_DESKTOP: desktop } });
  };
  if (process.platform === 'win32') withRestoredWindowsCheckRuntime(env, () => verify(checkWindowsPython(env, { venv: true })));
  else verify(path.join(env.RUNNER_TEMP, 'hermes-build-source/hermes-agent/venv/bin/python'));
}
function checkImages(release = selectRelease()) {
  const dist = path.resolve(release, 'nora-tavern-launcher/desktop/dist');
  const report = path.join(dist, `Nora-Tavern-package-verification-${process.platform}-${process.arch}.json`);
  assert.ok(!fs.existsSync(report), 'Refusing a stale packaged image report');
  runChecked(process.execPath, [path.join(repository, 'tooling/run.mjs'), 'node',
    'tests/deployment/verify_launcher_package.cjs', dist]);
  const value = read(regular(report));
  const system = read(path.join(release, 'nora-tavern-launcher/payload/nora-system.json'));
  assert.equal(value.nativeIcon, true);
  assert.equal(value.platform, process.platform);
  assert.equal(value.arch, process.arch);
  assert.equal(value.commit, system.commit);
  assert.equal(value.version, system.version);
}
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'app') {
      assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--installed'), 'Usage: app [--installed <directory>]');
      if (process.platform === 'win32') withRestoredWindowsCheckRuntime(process.env, () => {
        const python = checkWindowsPython(process.env);
        if (Object.hasOwn(process.env, 'NORA_APP_CHECK_PYTHON')) {
          assert.equal(fs.realpathSync(regular(process.env.NORA_APP_CHECK_PYTHON)), fs.realpathSync(python), 'APP interpreter override differs from the verified runtime');
        }
        checkApp({ installed: args[1], python });
      });
      else checkApp({ installed: args[1], python: process.env.NORA_APP_CHECK_PYTHON
        || path.join(process.env.RUNNER_TEMP, 'hermes-build-source/hermes-agent/venv/bin/python') });
    } else if (command === 'network') {
      assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--installed'), 'Usage: network [--installed <directory>]');
      checkNetwork({installed: args[1]});
    } else if (command === 'replacement') checkReplacement();
    else if (command === 'images') checkImages();
    else if (command === 'release') console.log(selectRelease());
    else throw new Error('Usage: launcher-artifact-checks.cjs <release|replacement|app|network|images>');
  } catch (error) {
    console.error(error);
    process.exitCode = error.exitCode || 1;
  }
}
module.exports = { only, selectRelease, selectApplication, runChecked, resolveWindowsCheckRuntime, verifyCheckPythonIdentity,
  checkWindowsPython, withRestoredWindowsCheckRuntime, verifyAppReport, checkApp, verifyNetworkReport, copyNetworkRuntime, checkNetwork, checkReplacement, checkImages };
