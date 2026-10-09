const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { selectRelease, selectApplication, runChecked, verifyAppReport, checkApp } =
  require('../tooling/checks/launcher-artifact-checks.cjs');
const { verifyInputs, verifySource, verifyDiff } =
  require('../tooling/checks/restore-launcher-check-package.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora 检查 fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, bytes = 'fixture') => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  return { root, write };
}
function windowsFixture(t) {
  const f = fixture(t), release = path.join(f.root, 'stable-2.4.3');
  const launcher = path.join(release, 'nora-tavern-launcher');
  const dist = path.join(launcher, 'desktop/dist');
  const prefix = path.relative(f.root, dist);
  const executable = f.write(`${prefix}/win-unpacked/Nora Tavern.exe`, 'application');
  const asar = f.write(`${prefix}/win-unpacked/resources/app.asar`, 'application archive');
  f.write(`${prefix}/win-unpacked/resources/elevate.exe`, 'helper');
  f.write(`${prefix}/win-unpacked/resources/nested/other.exe`, 'nested helper');
  return { ...f, release, launcher, dist, executable, asar };
}

test('Windows selection uses the single root EXE despite nested helper executables and Unicode/spaces', t => {
  const f = windowsFixture(t);
  assert.deepEqual(selectApplication(f.dist, 'win32'), { executable: f.executable, asar: f.asar });
  assert.match(f.executable, /检查 fixture /);
});
test('Windows selection refuses a missing root EXE even when helpers exist', t => {
  const f = windowsFixture(t);
  fs.unlinkSync(f.executable);
  assert.throws(() => selectApplication(f.dist, 'win32'), /exactly one root application executable/);
});
test('Windows selection refuses ambiguous root EXEs', t => {
  const f = windowsFixture(t);
  fs.writeFileSync(path.join(path.dirname(f.executable), 'Second.exe'), 'other app');
  assert.throws(() => selectApplication(f.dist, 'win32'), /exactly one root application executable/);
});
test('Windows selection requires the actual APP ASAR', t => {
  const f = windowsFixture(t);
  fs.unlinkSync(f.asar);
  assert.throws(() => selectApplication(f.dist, 'win32'));
});

function macFixture(t) {
  const f = fixture(t), dist = path.join(f.root, 'dist');
  const executable = f.write('dist/mac-arm64/Nora Tavern.app/Contents/MacOS/Nora Tavern', 'non-executable fixture');
  const asar = f.write('dist/mac-arm64/Nora Tavern.app/Contents/Resources/app.asar', 'Mac archive');
  f.write('dist/mac-arm64/Nora Tavern.app/Contents/Resources/helper', 'non-executable helper');
  return { ...f, dist, executable, asar };
}
test('Mac discovery selects the exact APP root without executing its non-executable fixture', t => {
  const f = macFixture(t);
  assert.deepEqual(selectApplication(f.dist, 'darwin'), { executable: f.executable, asar: f.asar });
});
for (const [label, extra] of [
  ['output directories', 'dist/mac/Nora.app/Contents/MacOS/Nora'],
  ['applications', 'dist/mac-arm64/Second.app/Contents/MacOS/Second'],
  ['root executables', 'dist/mac-arm64/Nora Tavern.app/Contents/MacOS/Second'],
]) test(`Mac discovery rejects ambiguous ${label}`, t => {
  const f = macFixture(t);
  f.write(extra);
  assert.throws(() => selectApplication(f.dist, 'darwin'), /exactly one/);
});
test('release discovery ignores unrelated directories and refuses two candidate/stable payloads', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'notes'));
  assert.throws(() => selectRelease(f.root), /exactly one release payload/);
  fs.mkdirSync(path.join(f.root, 'stable-2.4.3'));
  assert.equal(selectRelease(f.root), path.join(f.root, 'stable-2.4.3'));
  fs.mkdirSync(path.join(f.root, 'candidate-2.4.4'));
  assert.throws(() => selectRelease(f.root), /exactly one release payload/);
});

test('runChecked waits for a native Node child to write evidence and exit zero', t => {
  const f = fixture(t), marker = path.join(f.root, 'delayed result.json');
  const script = f.write('delayed.js', 'setTimeout(() => { require("node:fs").writeFileSync(process.argv[2], "done"); process.exit(0); }, 75);');
  const result = runChecked(process.execPath, [script, marker], { cwd: f.root, stdio: 'pipe', timeout: 3000 });
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
});
test('runChecked propagates a delayed native exit code even when the child wrote a report', t => {
  const f = fixture(t), marker = path.join(f.root, 'failed result.json');
  const script = f.write('delayed.js', 'setTimeout(() => { require("node:fs").writeFileSync(process.argv[2], "done"); process.exit(7); }, 75);');
  assert.throws(() => runChecked(process.execPath, [script, marker], { stdio: 'pipe', timeout: 3000 }),
    error => error.exitCode === 7);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
});
test('runChecked rejects timeout before late evidence can be created', t => {
  const f = fixture(t), marker = path.join(f.root, 'too late.json');
  const script = f.write('timeout.js', 'setTimeout(() => { require("node:fs").writeFileSync(process.argv[2], "late"); process.exit(0); }, 1000);');
  assert.throws(() => runChecked(process.execPath, [script, marker], { stdio: 'pipe', timeout: 100 }),
    error => error.code === 'ETIMEDOUT');
  assert.equal(fs.existsSync(marker), false);
});
test('runChecked rejects a missing native binary instead of accepting an absent exit status', t => {
  const f = fixture(t);
  assert.throws(() => runChecked(path.join(f.root, 'missing.exe'), [], { stdio: 'pipe' }),
    error => error.code === 'ENOENT');
});

function appReportFixture(t) {
  const f = windowsFixture(t), files = ['main.js', 'operation-delegate.js'];
  const relative = path.relative(f.root, f.launcher);
  f.write(`${relative}/desktop/package.json`, JSON.stringify({ build: { files } }));
  const lock = f.write(`${relative}/desktop/package-lock.json`, 'frozen lock');
  const modules = Object.fromEntries(files.map(name => {
    const file = f.write(`${relative}/desktop/${name}`, `source ${name}`);
    return [name, hash(fs.readFileSync(file))];
  }));
  const payload = f.write(`${path.relative(f.root, path.dirname(f.asar))}/payload/nora-system.json`, '{"commit":"frozen"}');
  const report = path.join(f.root, 'app report.json');
  const value = { schema: 'nora-app-candidate-gate/1', platform: 'win32', arch: 'x64',
    versions: { electron: '38.8.6' }, executable: { path: f.executable, sha256: hash(fs.readFileSync(f.executable)) },
    asar: { path: f.asar, sha256: hash(fs.readFileSync(f.asar)) },
    payloadManifestSha256: hash(fs.readFileSync(payload)), packageLockSha256: hash(fs.readFileSync(lock)),
    moduleHashes: modules, assertions: Object.fromEntries(['actualElectron', 'nativeDependencyComplete',
      'allFlatResourceHashesMatchCandidate', 'jsPythonReceiptAgree', 'arbitraryCliRefusedBeforeOperation']
      .map(name => [name, true])) };
  const save = () => fs.writeFileSync(report, JSON.stringify(value));
  save();
  return { ...f, report, value, save, options: { executable: f.executable, asar: f.asar,
    launcher: f.launcher, platform: 'win32', arch: 'x64' } };
}
test('APP evidence binds the selected executable, payload, lock and authored module bytes', t => {
  const f = appReportFixture(t);
  assert.deepEqual(verifyAppReport(f.report, f.options), f.value);
});
test('APP evidence rejects a different ASAR path even with identical bytes', t => {
  const f = appReportFixture(t);
  const other = f.write('other APP/app.asar', fs.readFileSync(f.asar));
  f.value.asar.path = other; f.save();
  assert.throws(() => verifyAppReport(f.report, f.options));
});
for (const [label, mutate] of [
  ['missing real Electron', value => delete value.versions.electron],
  ['missing receipt proof', value => delete value.assertions.jsPythonReceiptAgree],
  ['false native proof', value => value.assertions.nativeDependencyComplete = false],
  ['wrong platform', value => value.platform = 'darwin'],
  ['wrong architecture', value => value.arch = 'arm64'],
  ['changed executable', value => value.executable.sha256 = '0'.repeat(64)],
  ['changed ASAR', value => value.asar.sha256 = '0'.repeat(64)],
  ['changed payload', value => value.payloadManifestSha256 = '0'.repeat(64)],
  ['changed lock', value => value.packageLockSha256 = '0'.repeat(64)],
  ['missing authored module', value => delete value.moduleHashes['main.js']],
  ['extra unverified module', value => value.moduleHashes['other.js'] = '0'.repeat(64)],
  ['changed authored module', value => value.moduleHashes['main.js'] = '0'.repeat(64)],
]) test(`APP evidence rejects ${label}`, t => {
  const f = appReportFixture(t);
  mutate(f.value); f.save();
  assert.throws(() => verifyAppReport(f.report, f.options));
});
test('APP check refuses stale evidence before launching an application', t => {
  const f = appReportFixture(t);
  assert.throws(() => checkApp({ release: f.release, python: process.execPath,
    report: f.report, platform: 'win32' }), /stale APP report/);
});
test('APP check refuses a missing receipt interpreter before launching an application', t => {
  const f = windowsFixture(t);
  assert.throws(() => checkApp({ release: f.release, python: path.join(f.root, 'missing python.exe'),
    report: path.join(f.root, 'fresh report.json'), platform: 'win32' }));
  assert.equal(fs.existsSync(path.join(f.root, 'fresh report.json')), false);
});

function diagnosticInputs() {
  return { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    GITHUB_REF_NAME: 'codex/launcher-packaging-fixes', GITHUB_REF: 'refs/heads/codex/launcher-packaging-fixes',
    GITHUB_REPOSITORY: 'owner/tavern', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '124',
    NORA_BUILD_TARGET: 'win32-package-check', NORA_PACKAGE_SOURCE_RUN: '123', NORA_PRODUCTION_MODE: 'true',
    NORA_RUNTIME_SOURCE_RUN: '', NORA_PUBLISH_SOURCE_RUN: '', NORA_VERIFIED_WINDOWS_RUN: '', NORA_LAUNCHER_BASELINE_TAG: '' };
}
test('retained package mode is an independent branch diagnostic with no release or runtime inputs', () => {
  assert.equal(verifyInputs(diagnosticInputs()), 123);
});
test('mode-only CLI validates inputs before Python, package downloads or native platform checks', () => {
  const env = { ...diagnosticInputs(), SystemRoot: process.env.SystemRoot || '' };
  const cli = path.resolve(__dirname, '../tooling/checks/restore-launcher-check-package.cjs');
  assert.equal(runChecked(process.execPath, [cli, 'modes'], { env, stdio: 'pipe' }).status, 0);
  assert.throws(() => runChecked(process.execPath, [cli, 'unknown'], { env, stdio: 'pipe' }),
    error => error.exitCode === 1);
});
for (const [label, field, value] of [
  ['push event', 'GITHUB_EVENT_NAME', 'push'], ['tag invocation', 'GITHUB_REF_TYPE', 'tag'],
  ['wrong branch ref', 'GITHUB_REF', 'refs/heads/main'], ['missing branch', 'GITHUB_REF_NAME', ''],
  ['full build target', 'NORA_BUILD_TARGET', 'win32-x64'], ['all target', 'NORA_BUILD_TARGET', 'all'],
  ['candidate mode', 'NORA_PRODUCTION_MODE', 'false'], ['runtime reuse', 'NORA_RUNTIME_SOURCE_RUN', '125'],
  ['publishing', 'NORA_PUBLISH_SOURCE_RUN', '125'], ['formal Windows reuse', 'NORA_VERIFIED_WINDOWS_RUN', '125'],
  ['launcher baseline', 'NORA_LAUNCHER_BASELINE_TAG', 'v2.4.2'], ['self source', 'NORA_PACKAGE_SOURCE_RUN', '124'],
  ['missing source', 'NORA_PACKAGE_SOURCE_RUN', ''], ['malformed source', 'NORA_PACKAGE_SOURCE_RUN', '123;other'],
  ['unsafe numeric source', 'NORA_PACKAGE_SOURCE_RUN', '9007199254740993'],
  ['malformed repository', 'GITHUB_REPOSITORY', 'owner/tavern/extra'], ['missing checker commit', 'GITHUB_SHA', ''],
]) test(`retained package mode refuses ${label}`, () => {
  const env = diagnosticInputs(); env[field] = value;
  assert.throws(() => verifyInputs(env));
});
function retainedSourceFixture() {
  const env = diagnosticInputs(), commit = 'a'.repeat(40);
  const run = { id: 123, path: '.github/workflows/build-integrated-launcher.yml', event: 'workflow_dispatch',
    status: 'completed', conclusion: 'failure', head_sha: commit, head_branch: env.GITHUB_REF_NAME,
    repository: { id: 42, full_name: env.GITHUB_REPOSITORY }, head_repository: { id: 42, full_name: env.GITHUB_REPOSITORY } };
  const artifact = { id: 11, name: 'nora-windows-failed-packaging-diagnostic', expired: false,
    size_in_bytes: 1, digest: 'sha256:' + hash('x'), workflow_run: { id: run.id, head_sha: commit,
      head_branch: run.head_branch, repository_id: 42, head_repository_id: 42 } };
  const artifacts = { total_count: 2, artifacts: [artifact, { id: 12, name: 'nora-windows-replacement-diagnostic' }] };
  const job = { name: 'replacement-contract (windows-latest, win32, x64, pack:win:x64)',
    run_id: run.id, head_sha: commit, status: 'completed', conclusion: 'failure', steps:
      ['Assemble full installers from the same verified payload', 'Preserve built Windows packages when later acceptance fails']
        .map(name => ({ name, status: 'completed', conclusion: 'success' })) };
  const jobs = { total_count: 2, jobs: [job, { name: 'publish-release', status: 'completed', conclusion: 'skipped', steps: [] }] };
  return { env, run, artifact, artifacts, job, jobs };
}
test('failed source bytes may be diagnosed at a later check-only commit with original native job evidence', () => {
  const f = retainedSourceFixture();
  assert.notEqual(f.run.head_sha, f.env.GITHUB_SHA);
  assert.equal(verifySource(f.run, f.artifacts, f.env, f.jobs), f.artifact);
  f.job.name = 'build (windows-latest, win32, x64, pack:win:x64)';
  assert.equal(verifySource(f.run, f.artifacts, f.env, f.jobs), f.artifact);
});
for (const [label, mutate] of [
  ['wrong run', f => f.run.id++], ['wrong workflow', f => f.run.path = 'other.yml'],
  ['wrong event', f => f.run.event = 'push'], ['unfinished run', f => f.run.status = 'in_progress'],
  ['successful run presented as failure', f => f.run.conclusion = 'success'],
  ['malformed source commit', f => f.run.head_sha = 'bad'], ['another branch', f => f.run.head_branch = 'main'],
  ['another repository', f => f.run.repository.full_name = 'other/tavern'],
  ['forked run', f => f.run.head_repository.id = 43], ['forked repository name', f => f.run.head_repository.full_name = 'other/tavern'],
  ['incomplete artifact listing', f => f.artifacts.total_count++],
  ['duplicate package artifacts', f => { f.artifacts.artifacts.push({ ...f.artifact }); f.artifacts.total_count++; }],
  ['missing package artifact', f => f.artifact.name = 'nora-windows-package-check-diagnostic'],
  ['expired package', f => f.artifact.expired = true], ['empty package', f => f.artifact.size_in_bytes = 0],
  ['missing API digest', f => delete f.artifact.digest], ['wrong artifact run', f => f.artifact.workflow_run.id++],
  ['wrong artifact commit', f => f.artifact.workflow_run.head_sha = f.env.GITHUB_SHA],
  ['wrong artifact branch', f => f.artifact.workflow_run.head_branch = 'main'],
  ['forked artifact', f => f.artifact.workflow_run.head_repository_id = 43],
  ['incomplete job listing', f => f.jobs.total_count++],
  ['duplicate native jobs', f => { f.jobs.jobs.push({ ...f.job }); f.jobs.total_count++; }],
  ['diagnostic-only source job', f => f.job.name = 'package-check'], ['wrong native job commit', f => f.job.head_sha = f.env.GITHUB_SHA],
  ['unfinished native job', f => f.job.status = 'in_progress'], ['skipped native job', f => f.job.conclusion = 'skipped'],
  ['failed package build', f => f.job.steps[0].conclusion = 'failure'],
  ['skipped artifact preservation', f => f.job.steps[1].conclusion = 'skipped'],
  ['missing build evidence', f => f.job.steps.shift()], ['duplicate build evidence', f => f.job.steps.push({ ...f.job.steps[0] })],
]) test(`retained source rejects ${label}`, () => {
  const f = retainedSourceFixture(); mutate(f);
  assert.throws(() => verifySource(f.run, f.artifacts, f.env, f.jobs));
});
function rawChange(file, status = 'M', oldMode = '100644', newMode = '100644') {
  const oldBlob = (status === 'A' ? '0' : 'a').repeat(40), newBlob = (status === 'D' ? '0' : 'b').repeat(40);
  return `:${oldMode} ${newMode} ${oldBlob} ${newBlob} ${status}\0${file}\0`;
}
test('sealed product source guard permits only checker changes, including deletion of the obsolete wrapper', () => {
  const raw = rawChange('.github/workflows/build-integrated-launcher.yml')
    + rawChange('tooling/checks/launcher-artifact-checks.cjs', 'A', '000000')
    + rawChange('tooling/checks/verify-launcher-replacement.sh', 'D', '100644', '000000');
  assert.equal(verifyDiff(raw).length, 3);
  assert.deepEqual(verifyDiff(''), []);
});
for (const file of ['launcher/desktop/main.js', 'launcher/desktop/package-lock.json',
  'launcher/ui/assets/nora-launcher-portrait.png', 'tooling/release/package-release.mjs',
  'tests/deployment/launcher_packaged_app.test.cjs']) test(`sealed source guard rejects changed ${file}`, () => {
  assert.throws(() => verifyDiff(rawChange(file)));
});
test('sealed source guard rejects product deletion and renamed product paths', () => {
  assert.throws(() => verifyDiff(rawChange('launcher/desktop/main.js', 'D', '100644', '000000')));
  assert.throws(() => verifyDiff(rawChange('launcher/desktop/main.js', 'R100') + 'launcher/desktop/new.js\0'));
});
test('sealed source guard rejects executable/symlink checker modes and modification of the obsolete wrapper', () => {
  for (const mode of ['100755', '120000']) {
    assert.throws(() => verifyDiff(rawChange('tooling/checks/launcher-artifact-checks.cjs', 'M', '100644', mode)));
  }
  assert.throws(() => verifyDiff(rawChange('tooling/checks/verify-launcher-replacement.sh')));
});
test('sealed source guard rejects malformed or unterminated Git records', () => {
  assert.throws(() => verifyDiff(rawChange('.github/workflows/build-integrated-launcher.yml').slice(0, -1)));
  assert.throws(() => verifyDiff('malformed\0.github/workflows/build-integrated-launcher.yml\0'));
});
