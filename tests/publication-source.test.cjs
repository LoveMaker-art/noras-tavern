const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const { selectAcceptanceBaseline, verifyHistoricalAcceptance, verifyDelivery, verifyState, verifyRestoredState, verifyNativeAcceptance, immutableStateHashes, flattenDelivery, downloadArchive, fullNames, componentNames } = require('../tooling/release/publication-source.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stableRelease = tag_name => ({ id: 1, tag_name, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' });
test('acceptance selects actual stable history and cannot turn existing history into a first release', () => {
  const options = { repository: 'owner/tavern', targetTag: 'v2.4.4' };
  assert.equal(selectAcceptanceBaseline([[stableRelease('v2.4.2'), stableRelease('v2.4.3')]], options).tag, 'v2.4.3');
  assert.equal(selectAcceptanceBaseline([[stableRelease('v2.4.4'), stableRelease('v2.4.3')]], { ...options, publication: true }).tag, 'v2.4.3');
  assert.equal(selectAcceptanceBaseline([[]], { ...options, requestedTag: 'EMPTY' }).initialRelease, true);
  assert.throws(() => selectAcceptanceBaseline([[stableRelease('v2.4.3')]], { ...options, requestedTag: 'EMPTY' }));
  assert.throws(() => selectAcceptanceBaseline([[stableRelease('v2.4.4')]], options));
  assert.throws(() => selectAcceptanceBaseline([[stableRelease('v2.4.3')]], { ...options, requestedTag: 'v2.4.2' }));
  assert.throws(() => selectAcceptanceBaseline([[stableRelease('v2.4.1'), stableRelease('v2.4.3')]], { ...options, requestedTag: 'v2.4.1' }));
});
function fixture(kind = 'full', conclusion = 'success') {
  const repository = { id: 42, full_name: 'owner/tavern' };
  const run = { id: 123, head_sha: 'a'.repeat(40), repository, head_repository: repository,
    path: `.github/workflows/${kind === 'state' ? 'publish-accepted-release' : kind === 'full' ? 'build-integrated-launcher' : 'publish-component-update'}.yml`,
    event: 'workflow_dispatch', status: 'completed', conclusion };
  const names = kind === 'state' ? ['nora-publication-state-before-transfer', 'nora-publication-state'] : kind === 'full' ? fullNames : componentNames;
  const artifacts = { total_count: names.length, artifacts: names.map((name, index) => ({ id: index + 1, name, expired: false,
    size_in_bytes: 100, digest: 'sha256:' + hash('zip'), workflow_run: { id: 123, head_sha: run.head_sha, repository_id: 42, head_repository_id: 42 } })) };
  return { run, artifacts, options: { repository: repository.full_name, runId: '123', commit: run.head_sha, mode: kind === 'state' ? 'full' : kind } };
}
test('accepted product bytes are bound to their tag commit while a newer publisher can operate them', () => {
  const f = fixture(); assert.equal(verifyDelivery(f.run, f.artifacts, { ...f.options, publisherCommit: 'b'.repeat(40) }).length, 7);
  f.artifacts.artifacts.push({ ...f.artifacts.artifacts[0], id: 8, name: 'nora-release-plan' }); f.artifacts.total_count++;
  assert.equal(verifyDelivery(f.run, f.artifacts, f.options).length, 8);
});
test('component delivery requires its successful source workflow, acceptance and persisted plan', () => {
  const f = fixture('components'); assert.equal(verifyDelivery(f.run, f.artifacts, f.options).length, 3);
  f.artifacts.artifacts.pop(); f.artifacts.total_count--; assert.throws(() => verifyDelivery(f.run, f.artifacts, f.options));
});
test('old failed native diagnostics remain preserved but cannot enter a later accepted delivery', () => {
  const f = fixture(); f.artifacts.artifacts.push({ ...f.artifacts.artifacts[0], id: 8, name: 'nora-windows-failed-packaging-diagnostic' }); f.artifacts.total_count++;
  assert.equal(verifyDelivery(f.run, f.artifacts, f.options).length, 7);
});
for (const [label, change] of [
  ['wrong product commit', f => f.options.commit = 'b'.repeat(40)],
  ['wrong workflow', f => f.run.path = '.github/workflows/publish-accepted-release.yml'],
  ['failed source build', f => f.run.conclusion = 'failure'], ['unfinished source', f => f.run.status = 'in_progress'],
  ['fork run', f => f.run.head_repository = { id: 43, full_name: f.options.repository }],
  ['fork artifact', f => f.artifacts.artifacts[0].workflow_run.head_repository_id = 43],
  ['incomplete listing', f => f.artifacts.total_count++], ['expired bytes', f => f.artifacts.artifacts[0].expired = true],
  ['missing digest', f => delete f.artifacts.artifacts[0].digest], ['empty bytes', f => f.artifacts.artifacts[0].size_in_bytes = 0],
  ['duplicate ID', f => f.artifacts.artifacts[1].id = 1], ['duplicate name', f => f.artifacts.artifacts[1].name = f.artifacts.artifacts[0].name],
  ['other artifact source', f => f.artifacts.artifacts[0].workflow_run.head_sha = 'b'.repeat(40)],
  ['missing native acceptance', f => { f.artifacts.artifacts.pop(); f.artifacts.total_count--; }],
  ['unknown artifact', f => { f.artifacts.artifacts.push({ ...f.artifacts.artifacts[0], id: 8, name: 'unchecked-files' }); f.artifacts.total_count++; }],
]) test(`publication refuses ${label} before product download`, () => {
  const f = fixture(); change(f); assert.throws(() => verifyDelivery(f.run, f.artifacts, f.options));
});
for (const conclusion of ['success', 'failure', 'cancelled']) test(`resume accepts the persisted checkpoint of a completed ${conclusion} publication`, () => {
  const f = fixture('state', conclusion); assert.equal(verifyState(f.run, f.artifacts, f.options).name, 'nora-publication-state');
  f.artifacts.artifacts.pop(); f.artifacts.total_count--; assert.equal(verifyState(f.run, f.artifacts, f.options).name, 'nora-publication-state-before-transfer');
});
test('resume cannot import an unfinished, unrelated or unknown state artifact', () => {
  for (const change of [f => f.run.status = 'in_progress', f => f.run.path = '.github/workflows/other.yml',
    f => f.artifacts.artifacts[0].name = 'other-state', f => f.run.conclusion = 'timed_out']) {
    const f = fixture('state'); change(f); assert.throws(() => verifyState(f.run, f.artifacts, f.options));
  }
});
function stateFixture(t) {
  const f = fixture('state'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-state-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  f.options = { ...f.options, commit: 'b'.repeat(40), tag: 'v2.4.4', deliveryRun: '122', assetMode: 'legacy' };
  const plan = { schema: 'nora-publication-plan/1', tag: 'v2.4.4', commit: f.options.commit, objects: [] };
  const planBytes = JSON.stringify(plan, null, 2) + '\n'; fs.writeFileSync(path.join(root, 'publication-plan.json'), planBytes);
  fs.mkdirSync(path.join(root, 'distribution')); fs.writeFileSync(path.join(root, 'distribution/release.json'), 'original catalogue');
  fs.writeFileSync(path.join(root, 'publication-state.json'), JSON.stringify({ status: 'sealed' }));
  const artifacts = [{ id: 7, name: 'nora-tavern-shared', size: 100, digest: 'sha256:' + hash('original') }];
  const value = { schema: 'nora-publication-workflow/1', publisherCommit: f.run.head_sha, tag: f.options.tag,
    sourceCommit: f.options.commit, sourceRun: '122', assetMode: 'legacy', planId: hash(planBytes), sealedStateHashes: immutableStateHashes(root),
    receipt: { sourceCommit: f.options.commit, sourceRun: 122, mode: 'full', artifacts } };
  f.options.deliveryReceipt = structuredClone(value.receipt);
  const file = path.join(root, 'workflow-provenance.json'), save = () => fs.writeFileSync(file, JSON.stringify(value)); save();
  return { ...f, root, file, value, save };
}
test('resume permits a new publisher but keeps the original product tag, source run and asset mode', t => {
  const f = stateFixture(t); assert.deepEqual(verifyRestoredState(f.root, f.run, f.options), f.value);
});
for (const [label, mutate] of [
  ['different tag', value => value.tag = 'v2.4.5'], ['different product', value => value.sourceCommit = 'c'.repeat(40)],
  ['different accepted build', value => value.sourceRun = '124'], ['changed asset protocol', value => value.assetMode = 'shared'],
  ['unbound publisher', value => value.publisherCommit = 'c'.repeat(40)], ['different receipt', value => value.receipt.sourceRun = 124],
]) test(`resume rejects ${label}`, t => { const f = stateFixture(t); mutate(f.value); f.save(); assert.throws(() => verifyRestoredState(f.root, f.run, f.options)); });
test('mutable checkpoints may advance, but fixed catalogues and plan hashes cannot change', t => {
  const f = stateFixture(t); fs.writeFileSync(path.join(f.root, 'publication-state.json'), JSON.stringify({ status: 'prepared' }));
  verifyRestoredState(f.root, f.run, f.options);
  fs.writeFileSync(path.join(f.root, 'distribution/release.json'), 'different catalogue');
  assert.throws(() => verifyRestoredState(f.root, f.run, f.options), /Immutable checkpoint bytes/);
});
test('resume refuses a different accepted artifact ID or API digest even at the same commit', t => {
  const f = stateFixture(t); f.options.deliveryReceipt.artifacts[0].id++;
  assert.throws(() => verifyRestoredState(f.root, f.run, f.options), /artifact identities changed/);
  f.options.deliveryReceipt.artifacts[0].id--; f.options.deliveryReceipt.artifacts[0].digest = 'sha256:' + hash('different');
  assert.throws(() => verifyRestoredState(f.root, f.run, f.options), /artifact identities changed/);
});
test('flattening keeps old nested ZIP layouts compatible and refuses duplicate names without overwriting', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-flat-source-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'original'), output = path.join(root, 'delivery'); fs.mkdirSync(path.join(source, 'stable/a'), { recursive: true });
  fs.writeFileSync(path.join(source, 'stable/a/release-manifest.json'), 'original'); flattenDelivery(source, output);
  assert.equal(fs.readFileSync(path.join(output, 'release-manifest.json'), 'utf8'), 'original');
  fs.writeFileSync(path.join(source, 'stable/a/release-manifest.json'), 'different');
  assert.throws(() => flattenDelivery(source, output), /Duplicate delivery basename/);
  assert.equal(fs.readFileSync(path.join(output, 'release-manifest.json'), 'utf8'), 'original');
});
test('actual source CLI hashes artifact ZIP bytes before extracting them', t => {
  const f = fixture('components'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payloads = [ ['owned.json', 'sealed fixture'], ['component-acceptance.json', JSON.stringify({schema:'nora-component-acceptance/1',commit:f.options.commit,tag:'v2.4.4',outcome:'passed',files:{'owned.json':{size:14,sha256:hash('sealed fixture')}}})],
    ['release-plan.json', JSON.stringify({schema:'nora-release-plan/v1',source:{commit:f.options.commit},mode:'components',requiresReview:false})] ];
  for (const [index, payload] of payloads.entries()) {
    const zip = path.join(root, `${index + 1}.zip`);
    execFileSync('python3', ['-c', 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr(sys.argv[2],sys.argv[3])', zip, ...payload]);
    const bytes = fs.readFileSync(zip); f.artifacts.artifacts[index].size_in_bytes = bytes.length; f.artifacts.artifacts[index].digest = 'sha256:' + hash(bytes);
  }
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst id=process.argv.at(-1).split('/').at(-2);process.stdout.write(require('node:fs').readFileSync(process.env.FIXTURE_ZIP_ROOT+'/'+id+'.zip'));\n`, { mode: 0o755 });
  const runFile = path.join(root, 'run.json'), artifactsFile = path.join(root, 'artifacts.json'); fs.writeFileSync(runFile, JSON.stringify(f.run));
  const execute = output => spawnSync(process.execPath, [path.resolve(__dirname, '../tooling/release/publication-source.cjs'),
    'delivery', runFile, artifactsFile, f.options.commit, f.options.repository, '123', 'components', output],
  { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_ZIP_ROOT: root }, encoding: 'utf8' });
  fs.writeFileSync(artifactsFile, JSON.stringify(f.artifacts)); const accepted = path.join(root, 'accepted');
  const good = execute(accepted); assert.equal(good.status, 0, good.stderr);
  assert.equal(fs.readFileSync(path.join(accepted, 'delivery/owned.json'), 'utf8'), 'sealed fixture');
  f.artifacts.artifacts[0].digest = 'sha256:' + hash('wrong bytes'); fs.writeFileSync(artifactsFile, JSON.stringify(f.artifacts));
  const bad = path.join(root, 'rejected'), failure = execute(bad); assert.notEqual(failure.status, 0); assert.match(failure.stderr, /digest differs/);
  assert.equal(fs.existsSync(path.join(bad, 'delivery')), false, 'Unverified ZIP bytes must not be extracted');
});
function fullCliFixture(t) {
  const native = nativeFixture(t), f = fixture(), root = native.root;
  const payloadBytes = fs.readFileSync(path.join(native.delivery, 'payload.json'), 'utf8');
  const system = JSON.parse(fs.readFileSync(path.join(native.delivery, 'nora-system-darwin-arm64.json')));
  const installerName = 'Nora-Tavern-2.1.1-win-x64-setup.exe', installerBytes = 'fixture installed setup';
  const members = { 'nora-tavern-shared': [['release-manifest.json', payloadBytes]] };
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const [platform, arch] = target.split('-'), payloadName = `${target}-release-manifest.json`;
    const systemBytes = JSON.stringify({ ...system, platform, arch, files: { 'release-manifest.json': { asset: payloadName } } });
    const app = { ...native.app, platform, arch, payloadManifestSha256: hash(systemBytes) };
    members[`nora-tavern-${target}`] = [[`nora-system-${target}.json`, systemBytes], [payloadName, payloadBytes]];
    members[`nora-operation-acceptance-${target}`] = [
      ['nora-packaged-app-acceptance.json', JSON.stringify(app)],
      ['runtime/harness-result.json', JSON.stringify({ ...native.runtime, platform, arch })],
      ['fresh/harness-result.json', JSON.stringify({ ...native.fresh, platform, arch })],
    ];
    if (platform === 'win32') {
      members[`nora-tavern-${target}`].push([installerName, installerBytes]);
      members[`nora-operation-acceptance-${target}`].push(
        ['nora-installed-app-acceptance.json', JSON.stringify(app)],
        ['nora-installed-setup-acceptance.json', JSON.stringify({ schema: 'nora-installed-setup/1', exitCode: 0, autoLaunch: false,
          verifiedUnpackedFiles: 2, installer: installerName, installerSha256: hash(installerBytes) })]);
    }
  }
  const selection = selectAcceptanceBaseline([[]], { repository: f.options.repository, targetTag: 'v2.4.4', requestedTag: 'EMPTY' });
  members['nora-release-plan'] = [
    ['nora-acceptance-baseline-selection.json', JSON.stringify(selection)],
    ['nora-acceptance-published-releases.json', JSON.stringify([[]])],
  ];
  f.artifacts.artifacts.push({ ...f.artifacts.artifacts[0], id: 8, name: 'nora-release-plan' }); f.artifacts.total_count++;
  const zipInput = path.join(root, 'zip-members.json');
  fs.writeFileSync(zipInput, JSON.stringify(f.artifacts.artifacts.map(item => members[item.name])));
  execFileSync('python3', ['-c', 'import json,sys,zipfile,os\nwith open(sys.argv[1]) as f: artifacts=json.load(f)\nfor index,members in enumerate(artifacts,1):\n with zipfile.ZipFile(os.path.join(sys.argv[2],str(index)+".zip"),"w") as z:\n  for name,content in members: z.writestr(name,content)', zipInput, root]);
  for (const item of f.artifacts.artifacts) {
    const bytes = fs.readFileSync(path.join(root, `${item.id}.zip`)); item.size_in_bytes = bytes.length; item.digest = 'sha256:' + hash(bytes);
  }
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst resource=process.argv.at(-1);if(!/^repos\\/owner\\/tavern\\/actions\\/artifacts\\/\\d+\\/zip$/.test(resource))throw Error('Unexpected remote read: '+resource);const id=resource.split('/').at(-2);process.stdout.write(require('node:fs').readFileSync(process.env.FIXTURE_ZIP_ROOT+'/'+id+'.zip'));\n`, { mode: 0o755 });
  const runFile = path.join(root, 'run.json'), artifactsFile = path.join(root, 'artifacts.json'), factsFile = path.join(root, 'published-releases.json');
  fs.writeFileSync(runFile, JSON.stringify(f.run)); fs.writeFileSync(artifactsFile, JSON.stringify(f.artifacts));
  const execute = (output, pages = [[]]) => {
    fs.writeFileSync(factsFile, JSON.stringify(pages));
    return spawnSync(process.execPath, [path.resolve(__dirname, '../tooling/release/publication-source.cjs'),
      'delivery', runFile, artifactsFile, f.options.commit, f.options.repository, '123', 'full', output, 'v2.4.4', factsFile],
    { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_ZIP_ROOT: root }, encoding: 'utf8', timeout: 15000 });
  };
  return { root, execute };
}
test('actual full source CLI forwards the release tag and preserves the independent historical gate', t => {
  const f = fullCliFixture(t), accepted = path.join(f.root, 'accepted-full');
  const good = f.execute(accepted); assert.equal(good.status, 0, good.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(accepted, 'source-receipt.json')));
  assert.equal(receipt.artifacts.length, 8); assert.equal(receipt.historicalAcceptance.initialRelease, true);
  assert.deepEqual(Object.keys(receipt.acceptance).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
  const rejected = path.join(f.root, 'rejected-full'), bad = f.execute(rejected, [[stableRelease('v2.4.3')]]);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /historical stable release now disproves/);
  assert.equal(fs.existsSync(path.join(rejected, 'source-receipt.json')), false, 'A new published baseline must prevent accepting obsolete first-release evidence');
});
for (const [name, timeout, idleTimeout] of [['total', 150, 5000], ['idle', 5000, 150]]) test(`artifact ${name} deadline closes an actual child that ignores graceful termination`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-timeout-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let child;
  const spawnProcess = (_, __, options) => (child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'], options));
  await assert.rejects(downloadArchive({ id: 1, name: 'fixture', size_in_bytes: 5, digest: 'sha256:' + hash('ready') },
    'owner/tavern', path.join(root, 'partial.zip'), { timeout, idleTimeout, killGrace: 25, spawnProcess }), error => error.code === 'ETIMEDOUT');
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Downloader must wait for actual child closure');
});
function nativeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-native-report-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delivery = path.join(root, 'delivery'), acceptance = path.join(root, 'acceptance'), reports = path.join(acceptance, 'nora-operation-acceptance-darwin-arm64');
  fs.mkdirSync(delivery); fs.mkdirSync(reports, { recursive: true });
  const actorNames = ['operation_control.py', 'operation_cli.py', 'operation_evidence.py', 'desktop/operation-delegate.js'];
  const actors = Object.fromEntries(actorNames.map(name => [name, hash(name)]));
  const payload = { commit: 'a'.repeat(40), candidate: false, dirty: false, hermesRuntime: { sha256: hash('runtime') },
    artifacts: { ...Object.fromEntries(Object.entries(actors).map(([name, hash]) => ['ops/installer/' + name, hash])), 'ops/installer/desktop/main.js': hash('main') } };
  const payloadBytes = JSON.stringify(payload), payloadHash = hash(payloadBytes); fs.writeFileSync(path.join(delivery, 'payload.json'), payloadBytes);
  const system = { commit: payload.commit, candidate: false, platform: 'darwin', arch: 'arm64', version: '2.4.4', files: { 'release-manifest.json': { asset: 'payload.json' } } };
  const systemBytes = JSON.stringify(system); fs.writeFileSync(path.join(delivery, 'nora-system-darwin-arm64.json'), systemBytes);
  const app = { schema: 'nora-app-candidate-gate/1', platform: 'darwin', arch: 'arm64', versions: { electron: 'fixture' }, payloadManifestSha256: hash(systemBytes),
    moduleHashes: { 'main.js': hash('main'), 'operation-delegate.js': actors['desktop/operation-delegate.js'] },
    assertions: Object.fromEntries(['actualElectron', 'nativeDependencyComplete', 'allFlatResourceHashesMatchCandidate', 'jsPythonReceiptAgree', 'arbitraryCliRefusedBeforeOperation'].map(name => [name, true])) };
  const runtime = { schema: 'nora-launcher-products-smoke/1', outcome: 'passed', platform: 'darwin', arch: 'arm64', executorHandles: 'verified-closed', operation: 'verified', runtime: 'verified', runtimeSha256: payload.hermesRuntime.sha256, actorSourceFiles: actors, releaseManifestSha256: null };
  const fresh = { ...runtime, releaseManifestSha256: payloadHash, actorSourceBinding: 'verified-selected-candidate-manifest', firstInstall: 'verified', http: 'verified', hermesSkills: 'verified', mcp: 'verified', stop: 'verified', userData: 'retained', modelConfiguration: 'verified-local-A-to-B-model-requests', committedFirstInstall: 'verified-real-resume-without-reinstall', missingSystemReceipt: 'verified-bound-repair-and-preserved-user-data', userConfigurationDigest: hash('user-config') };
  const save = () => { fs.writeFileSync(path.join(reports, 'nora-packaged-app-acceptance.json'), JSON.stringify(app));
    for (const [name, value] of [['runtime', runtime], ['fresh', fresh]]) { fs.mkdirSync(path.join(reports, name), { recursive: true }); fs.writeFileSync(path.join(reports, name, 'harness-result.json'), JSON.stringify(value)); } };
  save(); return { root, delivery, acceptance, app, runtime, fresh, save, commit: payload.commit };
}
test('native source acceptance parses the actual APP and process workflow evidence', async t => {
  const f = nativeFixture(t); const report = await verifyNativeAcceptance(f.delivery, f.acceptance, f.commit, ['darwin-arm64']); assert.equal(report['darwin-arm64'].harnessReports, 2);
});
for (const [name, mutate] of [['false APP assertion', f => f.app.assertions.actualElectron = false], ['missing production module proof', f => delete f.app.moduleHashes['main.js']], ['wrong APP payload', f => f.app.payloadManifestSha256 = hash('other')],
  ['failed native workflow', f => f.fresh.outcome = 'failed'], ['unclosed process', f => f.runtime.executorHandles = 'unverified'],
  ['changed actor', f => f.fresh.actorSourceFiles = { ...f.fresh.actorSourceFiles, 'operation_cli.py': hash('other') }], ['missing user preservation', f => f.fresh.userData = 'unknown'], ['missing preserved configuration digest', f => delete f.fresh.userConfigurationDigest]]) test(`accepted source refuses ${name}`, async t => {
  const f = nativeFixture(t); mutate(f); f.save(); await assert.rejects(verifyNativeAcceptance(f.delivery, f.acceptance, f.commit, ['darwin-arm64']));
});
function historicalFixture(t) {
  const f = nativeFixture(t), reports = path.join(f.acceptance, 'nora-operation-acceptance-darwin-arm64');
  const proof = { schema: 'nora-upgrade-baseline/1', sourceRun: '100', platform: 'darwin-arm64', baselineVersion: '2.4.3', baselineCommit: 'b'.repeat(40),
    baselineManifestSha256: hash('baseline payload'), systemManifestSha256: hash('baseline system'), targetVersion: '2.4.4', targetCommit: f.commit,
    targetManifestSha256: f.fresh.releaseManifestSha256, verifiedFiles: 12, acceptance: 'version-transition-required' };
  const historical = ['running', 'stopped'].map(startState => ({ ...f.fresh, versionTransition: { ...proof, startState }, releaseAcceptance: 'isolated-version-transition',
    updateInitialService: startState, update: 'verified-content-transition', changedSourceArtifacts: 1 }));
  const identity = { schema: 'nora-acceptance-baseline/1', repository: 'owner/tavern', tag: 'v2.4.3', platform: 'darwin-arm64', version: '2.4.3', commit: proof.baselineCommit,
    systemManifestSha256: proof.systemManifestSha256, payloadManifestSha256: proof.baselineManifestSha256, declaredFiles: 12, verifiedFiles: 3 };
  const save = () => { fs.writeFileSync(path.join(reports, 'nora-upgrade-baseline-acceptance.json'), JSON.stringify(proof));
    for (const [index, report] of historical.entries()) { const directory = path.join(reports, 'historical-' + index); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'harness-result.json'), JSON.stringify(report)); } };
  save(); const options = { repository: 'owner/tavern', targetTag: 'v2.4.4', commit: f.commit, selected: ['darwin-arm64'], readIdentity: async () => identity };
  const execute = pages => verifyHistoricalAcceptance(f.acceptance, path.join(f.root, 'plan'), pages || [[stableRelease('v2.4.3')]], options);
  return { ...f, reports, proof, historical, identity, options, execute, save };
}
test('old frozen full sources remain acceptable only with real running and stopped upgrades matching the published baseline', async t => {
  const f = historicalFixture(t); const value = await f.execute(); assert.equal(value.initialRelease, false); assert.deepEqual(value.baselines['darwin-arm64'].states, ['running', 'stopped']);
});
test('an ancient published baseline cannot substitute for the most recent older stable release', async t => {
  const f = historicalFixture(t); f.proof.baselineVersion = '2.4.1'; f.save();
  await assert.rejects(f.execute([[stableRelease('v2.4.1'), stableRelease('v2.4.3'), stableRelease('v2.4.4')]]), /most recent published older/);
});
for (const [name, mutate] of [
  ['missing baseline proof', f => fs.unlinkSync(path.join(f.reports, 'nora-upgrade-baseline-acceptance.json'))],
  ['missing stopped upgrade', f => fs.rmSync(path.join(f.reports, 'historical-1'), { recursive: true })],
  ['changed official baseline commit', f => f.identity.commit = 'c'.repeat(40)],
  ['changed official baseline payload', f => f.identity.payloadManifestSha256 = hash('other')],
  ['changed baseline transition proof', f => { f.historical[1].versionTransition.baselineVersion = '2.4.2'; f.save(); }],
  ['same version as target', f => { f.proof.baselineVersion = '2.4.4'; f.save(); }],
  ['wrong service start state', f => { f.historical[1].updateInitialService = 'running'; f.save(); }],
]) test(`formal source refuses ${name}`, async t => { const f = historicalFixture(t); mutate(f); await assert.rejects(f.execute()); });
test('fresh installation evidence cannot substitute for historical evidence or declare its own first-release exception', async t => {
  const f = nativeFixture(t), options = { repository: 'owner/tavern', targetTag: 'v2.4.4', commit: f.commit, selected: ['darwin-arm64'], readIdentity: async () => { throw Error('unexpected'); } };
  const planRoot = path.join(f.root, 'plan'); fs.mkdirSync(planRoot);
  const execute = pages => verifyHistoricalAcceptance(f.acceptance, planRoot, pages, options);
  await assert.rejects(execute([[]]));
  fs.writeFileSync(path.join(planRoot, 'release-plan.json'), JSON.stringify({ initialRelease: true })); await assert.rejects(execute([[]]));
  const selection = selectAcceptanceBaseline([[]], { repository: options.repository, targetTag: options.targetTag, requestedTag: 'EMPTY' });
  fs.writeFileSync(path.join(planRoot, 'nora-acceptance-baseline-selection.json'), JSON.stringify(selection));
  await assert.rejects(execute([[]]), /Missing or duplicate native report/);
  fs.writeFileSync(path.join(planRoot, 'nora-acceptance-published-releases.json'), JSON.stringify([[]]));
  assert.equal((await execute([[]])).initialRelease, true);
  fs.writeFileSync(path.join(planRoot, 'nora-acceptance-baseline-selection.json'), JSON.stringify({ ...selection, apiSnapshotSha256: 'f'.repeat(64) }));
  await assert.rejects(execute([[]]), /snapshot differs/);
  fs.writeFileSync(path.join(planRoot, 'nora-acceptance-baseline-selection.json'), JSON.stringify(selection));
  await assert.rejects(execute([[stableRelease('v2.4.3')]]));
  fs.writeFileSync(path.join(planRoot, 'nora-acceptance-published-releases.json'), JSON.stringify([[stableRelease('v2.4.3')]]));
  await assert.rejects(execute([[]]), /snapshot differs/);
});
