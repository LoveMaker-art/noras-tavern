const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '../..');
const appAssertions = ['actualElectron', 'nativeDependencyComplete',
  'allFlatResourceHashesMatchCandidate', 'jsPythonReceiptAgree', 'arbitraryCliRefusedBeforeOperation'];
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
function checkReplacement(release = selectRelease(), env = process.env) {
  const desktop = path.resolve(release, 'nora-tavern-launcher/desktop');
  const archive = only(fs.readdirSync(path.join(desktop, 'dist'))
    .filter(name => name.endsWith('-update.zip')).map(name => path.join(desktop, 'dist', name)), 'launcher update archive');
  regular(archive);
  regular(path.join(desktop, 'package.json'));
  const moved = path.join(env.RUNNER_TEMP, 'hermes-build-source'), original = path.join(env.RUNNER_TEMP, 'hermes');
  const windows = process.platform === 'win32';
  let py = path.join(moved, 'hermes-agent/venv/bin/python'), restored = false;
  try {
    if (windows) {
      assert.ok(fs.existsSync(moved), 'Missing isolated test runtime');
      assert.ok(!fs.existsSync(original) && !fs.lstatSync(original, { throwIfNoEntry: false }), 'Original runtime must remain absent before archive checks');
      fs.renameSync(moved, original);
      restored = true;
      py = path.join(original, 'hermes-agent/venv/Scripts/python.exe');
      runChecked(regular(py), ['-B', '-c', 'import json,os,sys,psutil; from pathlib import Path; home=Path(os.environ["RUNNER_TEMP"])/"hermes"; venv=(home/"hermes-agent/venv").resolve(); base=(home/"python").resolve(); assert Path(sys.prefix).resolve()==venv; assert Path(sys.base_prefix).resolve()==base; assert Path(psutil.__file__).resolve().is_relative_to(venv); print(json.dumps({"venv":str(venv),"base":str(base),"psutil":psutil.__version__}))'], { env });
    }
    runChecked(process.execPath, [path.join(repository, 'tooling/run.mjs'), regular(py), '-B', '-m',
      'unittest', 'tests.deployment.test_launcher_replacement', '-v'], { env: { ...env,
      NORA_TEST_LAUNCHER_ARCHIVE: path.resolve(archive), NORA_TEST_LAUNCHER_DESKTOP: desktop } });
  } finally {
    if (restored) fs.renameSync(original, moved);
  }
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
      checkApp({ installed: args[1], python: process.env.NORA_APP_CHECK_PYTHON || path.join(process.env.RUNNER_TEMP,
        process.platform === 'win32' ? 'hermes-build-source/python/python.exe' : 'hermes-build-source/hermes-agent/venv/bin/python') });
    } else if (command === 'replacement') checkReplacement();
    else if (command === 'images') checkImages();
    else if (command === 'release') console.log(selectRelease());
    else throw new Error('Usage: launcher-artifact-checks.cjs <release|replacement|app|images>');
  } catch (error) {
    console.error(error);
    process.exitCode = error.exitCode || 1;
  }
}
module.exports = { only, selectRelease, selectApplication, runChecked, verifyAppReport, checkApp, checkReplacement, checkImages };
