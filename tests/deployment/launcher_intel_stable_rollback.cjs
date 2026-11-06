// Disposable qualification for one original full delivery. This never builds a package.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const repository = 'LoveMaker-art/noras-tavern';
const sourceRun = 42179756002;
const sourceCommit = '5ba3f7ee9b6f7a4a11c616721294338b430b0949';
const baselineTag = 'v2.6.4';
const targetVersion = '2.6.5';
const launcherVersion = '2.2.9';
const target = 'darwin-x64';
const workflow = '.github/workflows/build-integrated-launcher.yml';
const deliveryName = `nora-tavern-${target}`;
const acceptanceName = `nora-operation-acceptance-${target}`;
const dmgName = `Nora-Tavern-Launcher-${launcherVersion}-mac-x64.dmg`;
const systemName = `nora-system-${target}.json`;
const reportName = 'nora-packaged-app-acceptance.json';
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const command = (executable, args, options = {}) => execFileSync(executable, args, {cwd: root, encoding: 'utf8', timeout: 120000, ...options});
const api = endpoint => JSON.parse(command('gh', ['api', `repos/${repository}/${endpoint}`]));

async function sha(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function oneFile(directory, name) {
  const files = fs.readdirSync(directory, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name === name);
  assert.equal(files.length, 1, `Expected one ${name}`);
  return path.join(files[0].parentPath, files[0].name);
}

function dispatchRoot(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(`${platform}-${arch}`, target, 'The original x64 application must run on a native Intel runner');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.SOURCE_RUN, String(sourceRun));
  assert.equal(env.BASELINE_TAG, baselineTag);
  assert.ok(path.isAbsolute(env.RUNNER_TEMP || ''));
  return path.join(fs.realpathSync(env.RUNNER_TEMP), 'nora-intel-stable-rollback');
}

function extractSelected(archive, destination, names) {
  const extract = `import pathlib,shutil,stat,sys,zipfile
root=pathlib.Path(sys.argv[2]);root.mkdir(mode=0o700)
wanted=set(sys.argv[3:]);seen=set()
with zipfile.ZipFile(sys.argv[1]) as source:
    for item in source.infolist():
        name=pathlib.PurePosixPath(item.filename).name
        if name not in wanted:
            continue
        assert name not in seen and not item.is_dir()
        assert stat.S_IFMT(item.external_attr >> 16) in (0,stat.S_IFREG)
        assert 0 < item.file_size <= (8*1024**3 if name.endswith('.dmg') else 8*1024**2)
        seen.add(name)
        with source.open(item) as entry,(root/name).open('xb') as output:
            shutil.copyfileobj(entry,output,1024*1024)
    assert seen==wanted`;
  command('python3', ['-c', extract, archive, destination, ...names], {stdio: 'inherit', timeout: 600000});
}

async function prepare(directory) {
  const {downloadArchive, verifyArchive} = require('../../tooling/release/reuse-windows-build.cjs');
  const run = api(`actions/runs/${sourceRun}`);
  assert.equal(run.id, sourceRun);
  assert.equal(run.path, workflow);
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, sourceCommit);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  const jobs = api(`actions/runs/${sourceRun}/jobs?per_page=100`);
  const intel = jobs.jobs.filter(job => job.name === 'build (macos-15-intel, darwin, x64, pack:mac:x64) / acceptance (darwin-x64)');
  assert.equal(intel.length, 1, 'Missing original native Intel job');
  assert.equal(intel[0].conclusion, 'success');
  const artifacts = api(`actions/runs/${sourceRun}/artifacts?per_page=100`);
  assert.equal(artifacts.artifacts.length, artifacts.total_count);
  for (const name of ['nora-tavern-shared', deliveryName, acceptanceName,
    'nora-tavern-darwin-arm64', 'nora-tavern-win32-x64']) {
    assert.equal(artifacts.artifacts.filter(item => item.name === name && item.expired === false).length, 1, `Missing full delivery artifact: ${name}`);
  }
  fs.mkdirSync(directory, {mode: 0o700});
  const evidence = path.join(directory, 'evidence');
  fs.mkdirSync(evidence, {mode: 0o700});
  const sources = {};
  for (const name of [deliveryName, acceptanceName]) {
    const item = artifacts.artifacts.find(artifact => artifact.name === name);
    assert.equal(item.workflow_run.id, sourceRun);
    assert.equal(item.workflow_run.head_sha, sourceCommit);
    assert.equal(item.workflow_run.head_repository_id, run.repository.id);
    assert.match(item.digest, /^sha256:[a-f0-9]{64}$/);
    const archive = path.join(directory, `${name}.zip`);
    await downloadArchive(item, repository, archive);
    await verifyArchive(archive, item);
    extractSelected(archive, path.join(directory, name), name === deliveryName ? [dmgName, systemName] : [reportName]);
    fs.unlinkSync(archive);
    sources[name] = {id: item.id, size: item.size_in_bytes, digest: item.digest};
  }
  command(process.execPath, ['tooling/release/acceptance-baseline.mjs', '--tag', baselineTag,
    '--platform', target, '--repository', repository, '--output', path.join(directory, 'baseline')],
  {stdio: 'inherit', timeout: 900000});
  const baseline = read(path.join(directory, 'baseline', 'baseline-source-receipt.json'));
  assert.equal(baseline.schema, 'nora-acceptance-baseline/1');
  assert.equal(baseline.mode, 'materialized');
  assert.equal(baseline.tag, baselineTag);
  assert.equal(baseline.platform, target);
  assert.equal(baseline.repository, repository);
  write(path.join(evidence, 'source.json'), {
    sourceRun, sourceCommit, intelJobId: intel[0].id, artifacts: sources,
    baseline: {tag: baseline.tag, commit: baseline.commit},
  });
}

async function openExactPackage(directory) {
  const delivery = path.join(directory, deliveryName);
  const native = read(path.join(directory, acceptanceName, reportName));
  assert.equal(native.schema, 'nora-app-candidate-gate/1');
  assert.equal(`${native.platform}-${native.arch}`, target);
  assert.equal(native.assertions.actualElectron, true);
  const dmg = path.join(delivery, dmgName);
  const mount = path.join(directory, 'mount');
  fs.mkdirSync(mount, {mode: 0o700});
  command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], {stdio: 'inherit'});
  const app = path.join(directory, 'accepted.app');
  try {
    const applications = fs.readdirSync(mount, {withFileTypes: true}).filter(item => item.isDirectory() && item.name.endsWith('.app'));
    assert.equal(applications.length, 1, 'The original DMG must contain one APP');
    command('/usr/bin/ditto', [path.join(mount, applications[0].name), app]);
  } finally {
    command('/usr/bin/hdiutil', ['detach', mount], {stdio: 'inherit'});
  }
  const contents = path.join(app, 'Contents');
  const info = field => command('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, path.join(contents, 'Info.plist')]).trim();
  assert.equal(info('CFBundleShortVersionString'), launcherVersion);
  const executable = path.join(contents, 'MacOS', info('CFBundleExecutable'));
  assert.equal(command('/usr/bin/lipo', ['-archs', executable]).trim(), 'x86_64');
  const resources = path.join(contents, 'Resources');
  const payload = path.join(resources, 'payload');
  const executableSha256 = await sha(executable);
  const asarSha256 = await sha(path.join(resources, 'app.asar'));
  assert.equal(executableSha256, native.executable.sha256);
  assert.equal(asarSha256, native.asar.sha256);
  const systemFile = path.join(payload, 'nora-system.json');
  const systemSha256 = await sha(systemFile);
  assert.equal(systemSha256, native.payloadManifestSha256);
  assert.equal(systemSha256, await sha(path.join(delivery, systemName)));
  const system = read(systemFile);
  assert.equal(system.schema, 'nora-system/v1');
  assert.equal(system.commit, sourceCommit);
  assert.equal(system.version, targetVersion);
  assert.equal(system.launcherVersion, launcherVersion);
  assert.equal(system.channel, 'stable');
  assert.equal(system.candidate, false);
  assert.equal(`${system.platform}-${system.arch}`, target);
  for (const [name, item] of Object.entries(system.files)) {
    assert.equal(path.basename(name), name);
    const file = path.join(payload, name);
    assert.equal(fs.statSync(file).size, item.size);
    assert.equal(await sha(file), item.sha256, `The DMG payload differs: ${name}`);
  }
  const manifest = read(path.join(payload, 'release-manifest.json'));
  assert.equal(manifest.commit, sourceCommit);
  assert.equal(manifest.candidate, false);
  assert.equal(manifest.dirty, false);
  const identity = {dmg: path.basename(dmg), dmgSha256: await sha(dmg), executableSha256, asarSha256,
    systemSha256, releaseManifestSha256: system.files['release-manifest.json'].sha256};
  return {executable, payload, identity};
}

async function packagedRecovery(fixtureRoot) {
  assert.equal(`${process.platform}-${process.arch}`, target);
  assert.ok(process.versions.electron, 'Recovery must execute inside the exact native packaged Electron');
  const resources = path.resolve(process.execPath, '../../Resources');
  assert.equal(path.dirname(fixtureRoot), path.join(path.resolve(resources, '../../..'), 'fixture'));
  assert.match(path.basename(fixtureRoot), /^products-smoke-[A-Za-z0-9]+$/);
  const asar = path.join(resources, 'app.asar');
  const capability = require(path.join(asar, 'launcher-capability.js'));
  const {execute} = require(path.join(asar, 'operation-cli.js'));
  const lock = require(path.join(asar, 'operation-lock.js'));
  const hermes = path.join(fixtureRoot, 'hermes');
  const install = path.join(fixtureRoot, 'tavern');
  const {port, rollbackBaseline} = read(path.join(fixtureRoot, 'harness-result.json'));
  const original = read(path.join(fixtureRoot, 'original-operation-snapshot.json'));
  assert.equal(original.state, 'failed');
  assert.equal(original.effectState, 'changed');
  assert.ok(original.primaryFailure);
  assert.equal(rollbackBaseline.service, 'running');
  assert.ok(Object.keys(rollbackBaseline.files).some(name => name.endsWith('.jsonl')));
  const options = {noraHome: fixtureRoot, hermesHome: hermes, installRoot: install, executable: process.execPath,
    resourcesRoot: resources, isPackaged: true, launcherVersion, port, channel: 'stable'};
  // Interrupted core files can be mixed. Authorize the unchanged, verified APP actors first.
  const registered = await capability.register({...options, includeCore: false});
  const receiptPath = capability.receiptPath(fixtureRoot);
  const bridge = [path.join(resources, 'launcher_bridge.py'), '--nora-home', fixtureRoot, '--hermes-home', hermes,
    '--install-root', install, '--port', String(port)];
  const request = (kind, action, flags = [], admission = {}) => execute({receiptPath,
    request: {schema: 'nora-cli-request/1', kind, argv: [...bridge, action, ...flags], stdin: '', ...admission}}, {telemetry: false});
  const restored = await request('recover', 'recover-update', ['--operation-id', original.operationId],
    {operationId: original.operationId, snapshotSequence: original.snapshotSequence});
  assert.equal(restored.operationId, original.operationId);
  assert.equal(restored.planDigest, original.planDigest);
  assert.deepEqual(restored.primaryFailure, original.primaryFailure);
  assert.equal(restored.state, 'rolled-back');
  assert.equal(restored.verification, 'confirmed');
  assert.equal(restored.effectState, 'restored');
  assert.equal(restored.recoveryOutcome, 'restored-and-verified');
  assert.equal((await lock.probe({directory: registered.installerDirectory})).busy, false);
  const journalPath = path.join(install, 'tavern-updates/transaction.json');
  const journal = read(journalPath);
  assert.equal(journal.operationId, original.operationId);
  assert.equal(journal.status, 'restored');
  assert.equal(journal.recoveryPlan.phase, 'restored');
  const restoredJournalSha256 = await sha(journalPath);
  for (const [relative, hash] of Object.entries(rollbackBaseline.files)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
    assert.equal(await sha(path.join(fixtureRoot, relative)), hash, `Recovery changed ${relative}`);
  }
  const runtime = read(path.join(resources, 'payload/nora-hermes-runtime.json'));
  const python = path.join(hermes, runtime.venvPython);
  const env = {...process.env, HERMES_INSTALL_DIR: path.join(hermes, 'hermes-agent'),
    PYTHONPATH: path.join(hermes, 'hermes-agent'), PYTHONNOUSERSITE: '1',
    TAVERN_NODE_EXECUTABLE: path.join(hermes, runtime.nodeBin, 'node')};
  const preferences = command(python, ['-B', '-c', [
    'import hashlib,json,sys,yaml', 'from pathlib import Path',
    'home=Path(sys.argv[1]); config=yaml.safe_load((home/"hermes/config.yaml").read_text())',
    'settings=json.loads((home/"tavern/tavern-state/native/default-user/settings.json").read_text())',
    'data={"hermes":config["fixture_user_preferences"],"tavern":{"username":settings["username"],"avatar_style":settings["power_user"]["avatar_style"]}}',
    'print(hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest())',
  ].join('\n'), fixtureRoot], {env}).trim();
  assert.equal(preferences, rollbackBaseline.configurationDigest);
  const status = JSON.parse(command(python, ['-B', ...bridge, 'status'], {env, cwd: resources}).trim());
  assert.equal(status.version, baselineTag.slice(1));
  assert.equal(status.systemReady, true);
  assert.equal(status.running, true);
  const old = read(path.join(install, 'tavern-updates/installed.json'));
  assert.equal(old.version, baselineTag.slice(1));
  assert.equal(status.commit, old.commit);
  const http = `http://127.0.0.1:${port}`;
  for (const route of ['/', '/api/nora-boot/bootstrap']) {
    const response = await fetch(http + route, {signal: AbortSignal.timeout(15000)});
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
  const stopped = await request('stop', 'stop');
  assert.equal(stopped.state, 'succeeded');
  assert.equal(stopped.verification, 'confirmed');
  assert.equal((await lock.probe({directory: registered.installerDirectory})).busy, false);
  const offline = JSON.parse(command(python, ['-B', ...bridge, 'status'], {env, cwd: resources}).trim());
  assert.equal(offline.running, false);
  assert.equal(offline.gatewayRunning, false);
  await assert.rejects(fetch(http + '/', {signal: AbortSignal.timeout(10000)}), error => error.cause?.code === 'ECONNREFUSED');
  return {operationId: restored.operationId, planDigest: restored.planDigest, state: restored.state,
    verification: restored.verification, effectState: restored.effectState, recoveryOutcome: restored.recoveryOutcome,
    old: {version: old.version, commit: old.commit}, preferencesSha256: preferences,
    protectedFiles: rollbackBaseline.files, restoredJournalSha256, services: 'old-version-healthy-then-closed', electron: process.versions.electron};
}

async function qualify(directory) {
  const evidence = path.join(directory, 'evidence');
  const source = read(path.join(evidence, 'source.json'));
  assert.equal(source.sourceRun, sourceRun);
  assert.equal(source.sourceCommit, sourceCommit);
  const {executable, payload, identity} = await openExactPackage(directory);
  write(path.join(evidence, 'package.json'), identity);
  const scratch = path.join(directory, 'fixture');
  const baseline = path.join(directory, 'baseline');
  command(process.execPath, ['tooling/run.mjs', 'node', 'tests/deployment/launcher_product_refactor_smoke.cjs',
    '--payload', payload, '--baseline-release', baseline, '--update-release', payload, '--start-state', 'running',
    '--interrupt-update', '--scratch-base', scratch, '--keep'], {stdio: 'inherit', timeout: 1200000});
  const fixtureRoot = path.dirname(oneFile(scratch, 'harness-result.json'));
  const report = read(path.join(fixtureRoot, 'harness-result.json'));
  assert.equal(report.outcome, 'interrupted-for-recovery');
  assert.equal(report.releaseManifestSha256, identity.releaseManifestSha256);
  assert.equal(report.actorSourceBinding, 'verified-selected-candidate-manifest');
  assert.equal(report.executorHandles, 'verified-closed');
  assert.equal(report.interruption.effects.effectState, 'changed');
  assert.equal(report.interruption.effects.canRecover, true);
  assert.match(report.interruption.checkpoint, /:applied$/);
  const {checkpoint, journalSha256, jobId} = report.interruption;
  write(path.join(evidence, 'interruption.json'), {checkpoint, journalSha256, jobId, baseline: report.rollbackBaseline});
  const hermes = path.join(fixtureRoot, 'hermes');
  const env = {ELECTRON_RUN_AS_NODE: '1', HOME: hermes, USERPROFILE: hermes,
    HERMES_HOME: hermes, NORA_HERMES_HOME: hermes, NORA_TAVERN_HOME: fixtureRoot, NORA_RELEASE_CHANNEL: 'stable',
    TAVERN_DATA_ROOT: path.join(fixtureRoot, 'tavern'), NORA_INSTALLER_DIRECTORY: path.join(fixtureRoot, 'installer'),
    XDG_CACHE_HOME: path.join(fixtureRoot, 'cache'), XDG_DATA_HOME: path.join(fixtureRoot, 'data'),
    TMPDIR: path.join(fixtureRoot, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'};
  const recovery = JSON.parse(command(executable, [__filename, 'packaged-recovery', fixtureRoot], {env, timeout: 600000}).trim());
  assert.equal(recovery.old.commit, source.baseline.commit);
  write(path.join(evidence, 'qualification.json'), {schema: 'nora-intel-stable-rollback/1', source, identity,
    interruption: {checkpoint, journalSha256, jobId}, recovery});
}

async function main() {
  const [mode, fixtureRoot] = process.argv.slice(2);
  if (mode === 'packaged-recovery') {
    assert.equal(fs.realpathSync(fixtureRoot), fixtureRoot);
    console.log(JSON.stringify(await packagedRecovery(fixtureRoot)));
    return;
  }
  assert.ok(['prepare', 'qualify'].includes(mode), 'Use prepare or qualify');
  const directory = dispatchRoot();
  await (mode === 'prepare' ? prepare(directory) : qualify(directory));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {dispatchRoot, extractSelected};
