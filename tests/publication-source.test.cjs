const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { captureChild, stopChild } = require('./deployment/launcher_test_lifecycle.cjs');
const { selectAcceptanceBaseline, verifyHistoricalAcceptance, verifyDelivery, componentQualification, requalifyComponentAcceptance, verifyComponentAcceptance, verifyState, verifyRestoredState, verifyNativeAcceptance, immutableStateHashes, snapshotBeforeTransfer, flattenDelivery, downloadArchive, fullNames, componentNames } = require('../tooling/release/publication-source.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stableRelease = tag_name => ({ id: 1, tag_name, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' });
function writeFixtureArchives(archives) {
  // Keep archive construction independent of the production ZIP reader. Use
  // the selected test interpreter rather than a different ambient Python.
  execFileSync(process.env.NORA_TEST_PYTHON || 'python3', ['-I', '-B', '-c', `
import json,pathlib,sys,zipfile
for archive in json.load(sys.stdin):
 with zipfile.ZipFile(archive['output'],'w') as zipped:
  if 'directory' in archive:
   root=pathlib.Path(archive['directory'])
   for file in sorted(root.rglob('*')):
    if file.is_file() and ('only' not in archive or file.name==archive['only']):
     zipped.write(file,file.relative_to(root))
  else:
   for name,content in archive['members']:zipped.writestr(name,content)
`], { input: JSON.stringify(archives) });
}
function writeGhFixture(bin, source) {
  // A kernel shebang cannot quote a Node path containing spaces. Keep the
  // executable fixture offline even when the repository lives in such a path.
  const script=path.join(bin,'gh.cjs');fs.writeFileSync(script,source);
  const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  fs.writeFileSync(path.join(bin,'gh'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,{mode:0o755});
}
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
  const f = fixture('components'); assert.equal(verifyDelivery(f.run, f.artifacts, f.options).length, 6);
  f.artifacts.artifacts.pop(); f.artifacts.total_count--; assert.throws(() => verifyDelivery(f.run, f.artifacts, f.options));
});
function qualificationFixture(){
  const f=fixture('components','failure');f.run.run_attempt=1;
  f.artifacts.artifacts=f.artifacts.artifacts.filter(item=>item.name!=='nora-component-acceptance');f.artifacts.total_count--;
  const gates={
    'build-components':['Verify release contracts and update preservation','Require chat backup safety tests','Require the selected component source regression',
      'Build only shared application and updater components','Reuse verified environments and seal three system manifests','Verify the frozen component delivery before native acceptance','Preserve accepted component delivery'],
    'accept-components':['Accept only complete three-platform native evidence for these bytes'],
  };
  for(const [runner,platform]of [['macos-15','darwin-arm64'],['macos-15-intel','darwin-x64'],['windows-latest','win32-x64']])
    gates[`native-components (${runner}, ${platform})`]=['Qualify native maintenance changes before actual component acceptance',
      'Test fresh target installation and both native upgrade states with retained user data','Preserve raw native component evidence'];
  f.options.qualificationJobs={total_count:5,jobs:Object.entries(gates).map(([name,steps],index)=>({id:index+1,run_id:f.run.id,head_sha:f.run.head_sha,
    run_attempt:1,name,status:'completed',conclusion:name==='accept-components'?'failure':'success',
    steps:steps.map(step=>({name:step,status:'completed',conclusion:name==='accept-components'?'failure':'success'}))}))};return f;
}
test('only an explicitly API-proven failed component summary can reuse successful producers',()=>{
  const f=qualificationFixture();assert.equal(verifyDelivery(f.run,f.artifacts,f.options).length,5);
  assert.equal(componentQualification(f.run,f.options).sourceRunConclusion,'failure');
  const ordinary={...f.options};delete ordinary.qualificationJobs;assert.throws(()=>verifyDelivery(f.run,f.artifacts,ordinary));
});
for(const [label,mutate]of [
  ['failed build',f=>f.options.qualificationJobs.jobs[0].conclusion='failure'],
  ['failed native',f=>f.options.qualificationJobs.jobs[2].conclusion='failure'],
  ['skipped native gate',f=>f.options.qualificationJobs.jobs[2].steps[0].conclusion='skipped'],
  ['missing data acceptance',f=>f.options.qualificationJobs.jobs[2].steps.pop()],
  ['wrong summary failure',f=>f.options.qualificationJobs.jobs[1].steps[0].name='Run actions/download-artifact@v4'],
  ['cancelled summary',f=>f.options.qualificationJobs.jobs[1].conclusion='cancelled'],
  ['foreign job source',f=>f.options.qualificationJobs.jobs[2].head_sha='b'.repeat(40)],
  ['foreign job run',f=>f.options.qualificationJobs.jobs[2].run_id++],
  ['incomplete job list',f=>f.options.qualificationJobs.total_count++],
  ['duplicate job',f=>f.options.qualificationJobs.jobs[2]=f.options.qualificationJobs.jobs[3]],
  ['future attempt',f=>f.options.qualificationJobs.jobs[2].run_attempt++],
  ['missing raw evidence',f=>{f.artifacts.artifacts.pop();f.artifacts.total_count--;}],
  ['wrong workflow',f=>f.run.path='.github/workflows/build-integrated-launcher.yml'],
  ['full product source',f=>f.options.mode='full'],
])test(`component requalification refuses ${label} before downloading bytes`,()=>{
  const f=qualificationFixture();mutate(f);assert.throws(()=>verifyDelivery(f.run,f.artifacts,f.options));
});
test('requalification reseals all raw evidence and cannot replace an existing receipt or bless changed data',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-requalify-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {componentAcceptanceFixture}=await import('./helpers/component-acceptance-fixture.mjs');
  const f=componentAcceptanceFixture(root);
  await assert.rejects(requalifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit,f.tag),/existing component receipt/);
  fs.unlinkSync(f.output);const file=path.join(f.reports,'nora-component-native-win32-x64/stopped/harness-result.json');
  const original=fs.readFileSync(file),value=JSON.parse(original);value.userData='changed';fs.writeFileSync(file,JSON.stringify(value));
  await assert.rejects(requalifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit,f.tag));
  assert.equal(fs.existsSync(path.join(f.reports,'requalified-component-acceptance/component-acceptance.json')),false);
  fs.rmSync(path.join(f.reports,'requalified-component-acceptance'),{recursive:true});fs.writeFileSync(file,original);
  await requalifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit,f.tag);
  assert.equal((await verifyComponentAcceptance(f.delivery,f.reports,f.planRoot,f.commit)).outcome,'passed');
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
for(const conclusion of ['failure','cancelled'])test(`Jihu resume refuses a pre-transfer-only artifact from a ${conclusion} run`,t=>{
  const f=stateFixture(t);f.run.conclusion=conclusion;
  const file=path.join(f.root,'publication-plan.json'),plan=JSON.parse(fs.readFileSync(file));
  plan.destinations=['github','jihulab'];const bytes=JSON.stringify(plan,null,2)+'\n';fs.writeFileSync(file,bytes);
  f.value.planId=hash(bytes);f.value.sealedStateHashes=immutableStateHashes(f.root);f.save();
  f.artifacts.artifacts.pop();f.artifacts.total_count--;
  const stateArtifact=verifyState(f.run,f.artifacts,f.options);
  assert.equal(stateArtifact.name,'nora-publication-state-before-transfer');
  assert.throws(()=>verifyRestoredState(f.root,f.run,{...f.options,stateArtifact}),/Jihu.*final checkpoint|pre-transfer.*PUT/i);
});
test('a pre-transfer snapshot shares immutable bytes but cannot change live mutable state',t=>{
  const f=stateFixture(t),file=path.join(f.root,'publication-plan.json'),plan=JSON.parse(fs.readFileSync(file));
  plan.destinations=['github','jihulab'];fs.writeFileSync(file,JSON.stringify(plan));
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nora-before-transfer-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const target=path.join(parent,'checkpoint'),checkpoint=path.join(f.root,'publication-state.json'),original=fs.readFileSync(checkpoint);
  snapshotBeforeTransfer(f.root,target);
  assert.deepEqual(fs.readFileSync(checkpoint),original,'snapshot cannot mark the state used by the live publisher');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'publication-state.json'))).checkpointKind,'before-transfer');
  for(const name of ['publication-state.json','workflow-provenance.json'])
    assert.notEqual(fs.statSync(path.join(f.root,name)).ino,fs.statSync(path.join(target,name)).ino,'mutable members need independent copies');
  assert.equal(fs.statSync(path.join(f.root,'distribution/release.json')).ino,
    fs.statSync(path.join(target,'distribution/release.json')).ino,'immutable members must not duplicate large payload bytes');
  fs.writeFileSync(checkpoint,JSON.stringify({status:'preparing'}));
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'publication-state.json'))).status,'sealed');
  const legacy=stateFixture(t),legacyTarget=path.join(parent,'legacy');snapshotBeforeTransfer(legacy.root,legacyTarget);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyTarget,'publication-state.json'))).checkpointKind,undefined);
});
for(const conclusion of ['failure','cancelled'])test(`state CLI requires the API-identified final Jihu checkpoint after ${conclusion}`,t=>{
  const f=stateFixture(t);f.run.conclusion=conclusion;
  const planFile=path.join(f.root,'publication-plan.json'),plan=JSON.parse(fs.readFileSync(planFile));
  plan.destinations=['github','jihulab'];const planBytes=JSON.stringify(plan,null,2)+'\n';fs.writeFileSync(planFile,planBytes);
  f.value.planId=hash(planBytes);f.value.sealedStateHashes=immutableStateHashes(f.root);f.save();
  const runner=fs.mkdtempSync(path.join(os.tmpdir(),'nora-state-cli-'));t.after(()=>fs.rmSync(runner,{recursive:true,force:true}));
  const zip=path.join(runner,'state.zip');writeFixtureArchives([{output:zip,directory:f.root}]);
  const bytes=fs.readFileSync(zip);for(const item of f.artifacts.artifacts){item.size_in_bytes=bytes.length;item.digest='sha256:'+hash(bytes);}
  const bin=path.join(runner,'bin');fs.mkdirSync(bin);
  writeGhFixture(bin, `process.stdout.write(require('node:fs').readFileSync(process.env.FIXTURE_STATE_ZIP));\n`);
  const runFile=path.join(runner,'run.json'),artifactsFile=path.join(runner,'artifacts.json'),receiptFile=path.join(runner,'delivery-receipt.json');
  fs.writeFileSync(runFile,JSON.stringify(f.run));fs.writeFileSync(receiptFile,JSON.stringify(f.options.deliveryReceipt));
  const command=output=>spawnSync(process.execPath,[path.resolve(__dirname,'../tooling/release/publication-source.cjs'),
    'state',runFile,artifactsFile,f.options.commit,f.options.repository,'123','full',output,f.options.tag,'122','legacy',receiptFile],
    {env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,FIXTURE_STATE_ZIP:zip},encoding:'utf8'});
  const all=structuredClone(f.artifacts);f.artifacts.artifacts.pop();f.artifacts.total_count--;fs.writeFileSync(artifactsFile,JSON.stringify(f.artifacts));
  const rejected=path.join(runner,'before-only'),failure=command(rejected);
  assert.notEqual(failure.status,0);assert.match(failure.stderr,/Jihu.*final checkpoint/);
  assert.equal(fs.existsSync(path.join(rejected,'source-receipt.json')),false,'a pre-transfer snapshot must not acquire an accepted restoration receipt');
  fs.writeFileSync(artifactsFile,JSON.stringify(all));const accepted=path.join(runner,'final'),success=command(accepted);
  assert.equal(success.status,0,success.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(accepted,'source-receipt.json'))).artifacts[0].name,'nora-publication-state');
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
for(const requalify of [false,true])test(`actual source CLI hashes ZIPs and verifies complete component evidence (requalify=${requalify})`, async t => {
  const f = requalify?qualificationFixture():fixture('components'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const {componentAcceptanceFixture}=await import('./helpers/component-acceptance-fixture.mjs');
  const evidence=componentAcceptanceFixture(path.join(root,'inputs'),f.options.commit);
  for (const item of f.artifacts.artifacts) {
    const directory=item.name==='nora-component-delivery'?evidence.delivery:item.name==='nora-component-acceptance'?evidence.reports:
      item.name==='nora-release-plan'?evidence.planRoot:path.join(evidence.reports,item.name);
    const zip = path.join(root, `${item.id}.zip`);
    writeFixtureArchives([{output:zip,directory,...(item.name==='nora-component-acceptance'?{only:'component-acceptance.json'}:{})}]);
    const bytes = fs.readFileSync(zip); item.size_in_bytes = bytes.length; item.digest = 'sha256:' + hash(bytes);
  }
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  writeGhFixture(bin, `const endpoint=process.argv.at(-1),fs=require('node:fs');if(endpoint.includes('/jobs?'))process.stdout.write(fs.readFileSync(process.env.FIXTURE_ZIP_ROOT+'/api-jobs.json'));else{const id=endpoint.split('/').at(-2);process.stdout.write(fs.readFileSync(process.env.FIXTURE_ZIP_ROOT+'/'+id+'.zip'));}\n`);
  const apiJobs=requalify?f.options.qualificationJobs:qualificationFixture().options.qualificationJobs;
  fs.writeFileSync(path.join(root,'api-jobs.json'),JSON.stringify([apiJobs]));
  const runFile = path.join(root, 'run.json'), artifactsFile = path.join(root, 'artifacts.json'); fs.writeFileSync(runFile, JSON.stringify(f.run));
  const jobsFile=path.join(root,'jobs.json');if(requalify)fs.writeFileSync(jobsFile,JSON.stringify(f.options.qualificationJobs));
  const execute = output => spawnSync(process.execPath, [path.resolve(__dirname, '../tooling/release/publication-source.cjs'),
    'delivery', runFile, artifactsFile, f.options.commit, f.options.repository, '123', 'components', output,
    ...(requalify?[evidence.tag,'','','',jobsFile]:[])],
  { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_ZIP_ROOT: root }, encoding: 'utf8' });
  fs.writeFileSync(artifactsFile, JSON.stringify(f.artifacts)); const accepted = path.join(root, 'accepted');
  const good = execute(accepted); assert.equal(good.status, 0, good.stderr);
  if(requalify)assert.equal(JSON.parse(fs.readFileSync(path.join(accepted,'source-receipt.json'))).qualification.mode,'component-raw-evidence-requalified');
  assert.deepEqual(fs.readFileSync(path.join(accepted, 'delivery/release-manifest.json')),fs.readFileSync(path.join(evidence.delivery,'release-manifest.json')));
  f.artifacts.artifacts[0].digest = 'sha256:' + hash('wrong bytes'); fs.writeFileSync(artifactsFile, JSON.stringify(f.artifacts));
  const bad = path.join(root, 'rejected'), failure = execute(bad); assert.notEqual(failure.status, 0); assert.match(failure.stderr, /digest differs/);
  assert.equal(fs.existsSync(path.join(bad, 'delivery')), false, 'Unverified ZIP bytes must not be extracted');
});
function fullCliFixture(t, {staged=false, mutateMetadata}={}) {
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
      ['nora-electron-network-acceptance.json', JSON.stringify({...native.network, platform, arch})],
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
  const stageArtifacts=[],stageJobs=[];
  if(staged){
    const tools=require('../tooling/release/build-stage.cjs');f.run.run_attempt=3;
    for(const platform of tools.platforms){const inputs=[];
      // Native packaging includes metadata intentionally excluded from public assets.
      // Same-named Mac metadata has different bytes in each platform archive.
      members['nora-tavern-'+platform].push(
        [`Nora-Tavern-${platform}.dmg.blockmap`, 'blockmap '+platform],
        ['latest-mac.yml', 'update metadata '+platform],
        ['release-notes.generated.md', 'generated notes '+platform]);
      for(const [index,phase] of tools.stages.entries()){
        const item={...f.artifacts.artifacts[0],id:100+stageArtifacts.length,name:tools.name(phase,platform)};stageArtifacts.push(item);
        const context={repository:f.options.repository,commit:f.options.commit,runId:123,attempt:index+1,platform,baseline:'EMPTY',options:{},environment:{imageOS:'fixture',imageVersion:'1',kernel:'fixture',node:'24.19.0',python:'3.11.9',platform}};
        const receipt={schema:'nora-build-stage/1',stage:phase,context,inputs:inputs.map(input=>({stage:input.stage,...input.artifact})),
          archive:{size:10,sha256:hash('fixture stage')},delivery:phase==='package'?Object.fromEntries(members['nora-tavern-'+platform]
            .map(([file,bytes])=>[file,{size:Buffer.byteLength(bytes),sha256:hash(bytes)}])):null};
        const id=200+stageJobs.length,gates=[...tools.required[phase],...(phase==='package'?[platform==='win32-x64'
          ?'Test Windows installation and managed update with legacy path limits':'Test real fresh installation and managed update before desktop packaging']:[])];
        stageJobs.push({id,run_id:123,head_sha:f.options.commit,run_attempt:index+1,name:tools.jobName(phase,platform),status:'completed',conclusion:'success',steps:gates.map(name=>({name,status:'completed',conclusion:'success'}))});
        inputs.push({schema:'nora-stage-input/1',stage:phase,artifact:{id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest},receipt,producer:{id,attempt:index+1}});
      }
      members['nora-operation-acceptance-'+platform].push(['nora-build-stages.json',JSON.stringify({schema:'nora-build-stages/1',inputs,acceptanceEnvironment:{...inputs[0].receipt.context.environment,imageVersion:'2'}})]);
      const gates=['Verify stage provenance and unchanged product before delivery','Verify real APP production module closure and executor receipts','Verify packaged network modules in native Chromium',
        'Verify packaged Nora images and instructions','Preserve isolated operation acceptance evidence','Upload launcher',...(platform==='win32-x64'?['Test the actual Windows setup and installed application']:[])];
      stageJobs.push({id:200+stageJobs.length,run_id:123,head_sha:f.options.commit,run_attempt:3,name:tools.jobName('build',platform),status:'completed',conclusion:'success',steps:gates.map(name=>({name,status:'completed',conclusion:'success'}))});
    }
  }
  if(mutateMetadata)mutateMetadata(members['nora-tavern-darwin-arm64']);
  f.artifacts.artifacts.push({ ...f.artifacts.artifacts[0], id: 8, name: 'nora-release-plan' }); f.artifacts.total_count++;
  writeFixtureArchives(f.artifacts.artifacts.map(item=>({output:path.join(root,`${item.id}.zip`),members:members[item.name]})));
  for (const item of f.artifacts.artifacts) {
    const bytes = fs.readFileSync(path.join(root, `${item.id}.zip`)); item.size_in_bytes = bytes.length; item.digest = 'sha256:' + hash(bytes);
  }
  f.artifacts.artifacts.push(...stageArtifacts);f.artifacts.total_count=f.artifacts.artifacts.length;
  const jobsFile=path.join(root,'stage-jobs.json');
  fs.writeFileSync(jobsFile,JSON.stringify(staged?{total_count:stageJobs.length,jobs:stageJobs}:{total_count:1,jobs:[{name:'build legacy'}]}));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  writeGhFixture(bin, `const fs=require('node:fs'),resource=process.argv.at(-1);if(resource.includes('/actions/runs/123/jobs?')){process.stdout.write('['+fs.readFileSync(process.env.FIXTURE_ZIP_ROOT+'/stage-jobs.json','utf8')+']');process.exit(0);}if(!/^repos\\/owner\\/tavern\\/actions\\/artifacts\\/\\d+\\/zip$/.test(resource))throw Error('Unexpected remote read: '+resource);const id=resource.split('/').at(-2);process.stdout.write(fs.readFileSync(process.env.FIXTURE_ZIP_ROOT+'/'+id+'.zip'));\n`);
  const runFile = path.join(root, 'run.json'), artifactsFile = path.join(root, 'artifacts.json'), factsFile = path.join(root, 'published-releases.json');
  fs.writeFileSync(runFile, JSON.stringify(f.run)); fs.writeFileSync(artifactsFile, JSON.stringify(f.artifacts));
  const execute = (output, pages = [[]]) => {
    fs.writeFileSync(factsFile, JSON.stringify(pages));
    return spawnSync(process.execPath, [path.resolve(__dirname, '../tooling/release/publication-source.cjs'),
      'delivery', runFile, artifactsFile, f.options.commit, f.options.repository, '123', 'full', output, 'v2.4.4', factsFile],
    { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_ZIP_ROOT: root }, encoding: 'utf8', timeout: 15000 });
  };
  return { root, execute, jobsFile };
}
test('the actual publisher CLI accepts complete staged evidence and refuses a skipped source group without rebuilding products',t=>{
  const f=fullCliFixture(t,{staged:true}),accepted=path.join(f.root,'staged-accepted');
  const good=f.execute(accepted);assert.equal(good.status,0,good.stderr);
  const receipt=JSON.parse(fs.readFileSync(path.join(accepted,'source-receipt.json')));assert.equal(receipt.stageAcceptance.mode,'staged');assert.equal(receipt.artifacts.length,8,'intermediate archives are verified as provenance, not downloaded as product assets');
  for(const name of ['latest-mac.yml','release-notes.generated.md','Nora-Tavern-darwin-arm64.dmg.blockmap'])
    assert.equal(fs.existsSync(path.join(accepted,'delivery',name)),false,'Packaging metadata is verified without becoming a public asset');
  const jobs=JSON.parse(fs.readFileSync(f.jobsFile));jobs.jobs[0].steps[0].conclusion='skipped';fs.writeFileSync(f.jobsFile,JSON.stringify(jobs));
  const rejected=path.join(f.root,'staged-rejected'),bad=f.execute(rejected);assert.notEqual(bad.status,0);assert.match(bad.stderr,/Stage gate did not pass/);
  assert.equal(fs.existsSync(path.join(rejected,'source-receipt.json')),false);
});
test('original packaging metadata cannot be removed or changed behind valid artifact ZIP hashes',t=>{
  for(const mode of ['missing','changed']){
    const f=fullCliFixture(t,{staged:true,mutateMetadata:members=>{
      const index=members.findIndex(([name])=>name.endsWith('.blockmap'));
      if(mode==='missing')members.splice(index,1);else members[index][1]='B'+members[index][1].slice(1);
    }}),output=path.join(f.root,'metadata-rejected'),result=f.execute(output);
    assert.notEqual(result.status,0);
    assert.equal(fs.existsSync(path.join(output,'source-receipt.json')),false);
    assert.match(result.stderr,/blockmap|Published product (?:size|differs)|Missing or duplicate original/);
  }
});
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
for (const [name, timeout, idleTimeout] of [['total', 150, 5000], ['idle', 5000, 150]]) test(`artifact ${name} deadline closes an actual child that ignores graceful termination`, {timeout:10000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-timeout-'));
  const script = 'process.on("SIGTERM",()=>{process.stderr.write("term ignored\\n")});process.on("message",value=>{if(value==="download")process.stdout.write("ready")});setInterval(()=>{},1000);process.send({ready:true,pid:process.pid,termHandlerInstalled:true});';
  const child = spawn(process.execPath, ['-e', script], {stdio:['ignore','pipe','pipe','ipc']}), state = captureChild(child), signals = [];
  const archive = path.join(root,'partial.zip'), createWriteStream = fs.createWriteStream;
  let output, outputClosed, outputDidClose = true, primary;
  const waitOutputClose = async () => {
    if (!output) return;
    let timer;
    try {
      await Promise.race([outputClosed,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error('Artifact fixture output did not close within 2000 ms'),{fixtureRoot:root})),2000);
      })]);
      assert.equal(outputDidClose,true);
    } finally {clearTimeout(timer);}
  };
  const observeOutput = t.mock.method(fs,'createWriteStream',function(file,...args){
    const stream=createWriteStream.call(this,file,...args);
    if(file===archive){
      output=stream;outputDidClose=false;
      outputClosed=new Promise(resolve=>stream.once('close',()=>{outputDidClose=true;resolve();}));
    }
    return stream;
  });
  const kill = child.kill.bind(child);
  t.mock.method(child, 'kill', signal => {signals.push(signal);return kill(signal);});
  t.after(async () => {
    try {
      await stopChild(child,{graceMs:25,timeoutMs:5000});
      if(output&&!outputDidClose)output.destroy();
      await waitOutputClose();
      assert.equal(state.didClose,true);assert.equal(outputDidClose,true);
      fs.rmSync(root,{recursive:true,force:true});
    } catch(error) {
      error.fixtureRoot=root;
      if(primary)error.cause=primary;
      t.diagnostic(`Preserved artifact fixture with unconfirmed child or output closure: ${root}`);
      throw error;
    }
  });
  const readyController = new AbortController(), readyTimer = setTimeout(() => readyController.abort(new Error('Artifact child readiness timed out')), 5000);
  try {
    const [ready] = await Promise.race([once(child, 'message', {signal:readyController.signal}),
      state.closed.then(() => {throw new Error('Artifact child closed before readiness: '+state.stderr);})]);
    assert.deepEqual(ready, {ready:true,pid:child.pid,termHandlerInstalled:true});assert.equal(state.didClose,false);
  } finally {clearTimeout(readyTimer);readyController.abort();}
  let spawned = 0;
  const spawnProcess = (program, args, options) => {
    assert.equal(program,'gh');assert.deepEqual(args,['api','repos/owner/tavern/actions/artifacts/1/zip']);
    assert.deepEqual(options.stdio,['ignore','pipe','inherit']);assert.equal(++spawned,1);
    child.send('download');return child;
  };
  try {
    await assert.rejects(downloadArchive({ id: 1, name: 'fixture', size_in_bytes: 5, digest: 'sha256:' + hash('ready') },
      'owner/tavern', archive, { timeout, idleTimeout, killGrace: 25, spawnProcess }), error => error.code === 'ETIMEDOUT');
    assert.ok(output,'Observe the actual archive writer rather than inferring file closure from the child');
    await waitOutputClose();
  } catch(error) {primary=error;throw error;}
  finally {observeOutput.mock.restore();}
  assert.equal(spawned,1);assert.equal(state.didClose,true,'Downloader must wait for actual child close');
  assert.equal(signals[0],'SIGTERM');
  if(process.platform!=='win32'){
    assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(state.result.signal,'SIGKILL');assert.match(state.stderr,/term ignored/);
  }else t.diagnostic('Windows SIGTERM terminates the native child; POSIX handler execution and force escalation are not Windows evidence.');
  assert.equal(fs.readFileSync(archive,'utf8'),'ready','Readiness must not be archive bytes; only download-start may write the original five bytes');
  t.diagnostic(JSON.stringify({evidence:'ready-artifact-child-deadline',kind:name,pid:child.pid,readyAck:true,
    timeout,idleTimeout,killGrace:25,signals,actualClose:state.didClose,outputClosed:outputDidClose,...state.result}));
});
function nativeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-native-report-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delivery = path.join(root, 'delivery'), acceptance = path.join(root, 'acceptance'), reports = path.join(acceptance, 'nora-operation-acceptance-darwin-arm64');
  fs.mkdirSync(delivery); fs.mkdirSync(reports, { recursive: true });
  const actorNames = ['operation_control.py', 'operation_cli.py', 'operation_evidence.py', 'desktop/operation-delegate.js'];
  const actors = Object.fromEntries(actorNames.map(name => [name, hash(name)]));
  const networkModules = Object.fromEntries(['release-network.js', 'release-sources.js', 'release-sources.json', 'launcher-errors.js'].map(name => [name, hash(name)]));
  const payload = {schema:'tavern-release/v2',versions:{tavern:'2.4.4'},commit: 'a'.repeat(40), candidate: false, dirty: false, hermesRuntime: { sha256: hash('runtime') },
    artifacts: { ...Object.fromEntries(Object.entries(actors).map(([name, hash]) => ['ops/installer/' + name, hash])),
      ...Object.fromEntries(Object.entries(networkModules).map(([name, hash]) => ['ops/installer/desktop/' + name, hash])), 'ops/installer/desktop/main.js': hash('main') } };
  const payloadBytes = JSON.stringify(payload), payloadHash = hash(payloadBytes); fs.writeFileSync(path.join(delivery, 'payload.json'), payloadBytes);
  const system = { commit: payload.commit, candidate: false, platform: 'darwin', arch: 'arm64', version: '2.4.4', files: { 'release-manifest.json': { asset: 'payload.json' } } };
  const systemBytes = JSON.stringify(system); fs.writeFileSync(path.join(delivery, 'nora-system-darwin-arm64.json'), systemBytes);
  const app = { schema: 'nora-app-candidate-gate/1', platform: 'darwin', arch: 'arm64', versions: { electron: 'fixture' }, payloadManifestSha256: hash(systemBytes),
    executable:{sha256:hash('native-executable')}, asar:{sha256:hash('native-asar')},
    moduleHashes: { ...networkModules, 'main.js': hash('main'), 'operation-delegate.js': actors['desktop/operation-delegate.js'] },
    assertions: Object.fromEntries(['actualElectron', 'nativeDependencyComplete', 'allFlatResourceHashesMatchCandidate', 'jsPythonReceiptAgree', 'arbitraryCliRefusedBeforeOperation'].map(name => [name, true])) };
  const runtime = { schema: 'nora-launcher-products-smoke/1', outcome: 'passed', platform: 'darwin', arch: 'arm64', executorHandles: 'verified-closed', operation: 'verified', runtime: 'verified', runtimeSha256: payload.hermesRuntime.sha256, actorSourceFiles: actors, releaseManifestSha256: null };
  const fresh = { ...runtime, releaseManifestSha256: payloadHash, actorSourceBinding: 'verified-selected-candidate-manifest', firstInstall: 'verified', http: 'verified', hermesSkills: 'verified', mcp: 'verified', stop: 'verified', userData: 'retained', modelConfiguration: 'verified-local-A-to-B-model-requests', committedFirstInstall: 'verified-real-resume-without-reinstall', missingSystemReceipt: 'verified-bound-repair-and-preserved-user-data', userConfigurationDigest: hash('user-config') };
  const network = {schema:'nora-electron-network/1', scope:'packaged-network-modules-in-native-chromium', platform:'darwin', arch:'arm64',
    versions:{electron:app.versions.electron}, executable:{...app.executable}, runtimeExecutable:{...app.executable}, asar:{...app.asar},
    moduleHashes:{...networkModules}, actualChromiumNet:true, windowCount:0,
    assertions:Object.fromEntries(['manualRedirect', 'sourceFallback', 'untrustedRedirectRefused', 'abort', 'sessionProxy', 'streaming', 'deadline'].map(name=>[name,true]))};
  const save = () => { fs.writeFileSync(path.join(reports, 'nora-packaged-app-acceptance.json'), JSON.stringify(app));
    fs.writeFileSync(path.join(reports, 'nora-electron-network-acceptance.json'), JSON.stringify(network));
    for (const [name, value] of [['runtime', runtime], ['fresh', fresh]]) { fs.mkdirSync(path.join(reports, name), { recursive: true }); fs.writeFileSync(path.join(reports, name, 'harness-result.json'), JSON.stringify(value)); } };
  save(); return { root, delivery, acceptance, app, network, runtime, fresh, save, commit: payload.commit };
}
test('native source acceptance parses the actual APP and process workflow evidence', async t => {
  const f = nativeFixture(t); const report = await verifyNativeAcceptance(f.delivery, f.acceptance, f.commit, ['darwin-arm64']); assert.equal(report['darwin-arm64'].harnessReports, 2);
});
for (const [name, mutate] of [
  ['Node substituted for Chromium', f=>f.network.actualChromiumNet=false],
  ['unverified redirect', f=>f.network.assertions.manualRedirect=false],
  ['different network module', f=>f.network.moduleHashes['release-network.js']=hash('other')],
  ['different native runtime', f=>f.network.runtimeExecutable.sha256=hash('other')],
  ['different packed resources', f=>f.network.asar.sha256=hash('other')],
]) test(`accepted source refuses ${name}`, async t=>{
  const f=nativeFixture(t); mutate(f); f.save();
  await assert.rejects(verifyNativeAcceptance(f.delivery,f.acceptance,f.commit,['darwin-arm64']));
});
test('native source acceptance refuses absence of real Chromium network evidence', async t => {
  const f = nativeFixture(t);
  const report = path.join(f.acceptance, 'nora-operation-acceptance-darwin-arm64/nora-electron-network-acceptance.json');
  fs.rmSync(report, {force:true});
  await assert.rejects(verifyNativeAcceptance(f.delivery, f.acceptance, f.commit, ['darwin-arm64']), /network|native report/);
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
function launcherHistoricalFixture(t) {
  const f=historicalFixture(t),proof=f.proof;
  const descriptor={schema:'nora-launcher/v1',candidate:false,platform:'darwin',arch:'arm64',version:'2.2.3',commit:f.commit,
    asset:'Nora-Tavern-Launcher-2.2.3-darwin-arm64-update.zip',sha256:hash('accepted native APP bytes'),size:25};
  const bytes=JSON.stringify(descriptor);
  fs.writeFileSync(path.join(f.delivery,'nora-launcher-darwin-arm64.json'),bytes);
  fs.writeFileSync(path.join(f.delivery,descriptor.asset),'accepted native APP bytes');
  const before={version:'2.2.2',commit:f.identity.commit,descriptorSha256:hash('official old descriptor'),
    archiveSha256:hash('official old APP bytes'),archiveSize:22,executableSha256:hash('old native executable'),asarSha256:hash('old native asar')};
  const after={version:descriptor.version,commit:f.commit,descriptorSha256:hash(bytes),archiveSha256:descriptor.sha256,
    archiveSize:descriptor.size,executableSha256:f.app.executable.sha256,asarSha256:f.app.asar.sha256};
  Object.assign(proof,{schema:'nora-app-upgrade-baseline/1',targetTag:'v2.4.4',baselineTag:'v2.4.3',targetVersion:'2.4.3',
    acceptance:'launcher-transition-required',baselineLauncher:before,targetLauncher:after,
    coreIdentity:{version:'2.4.3',commit:f.identity.commit,manifestSha256:f.identity.payloadManifestSha256},
    protectedDataSha256:hash('retained chats characters worlds settings'),userConfigurationDigest:f.fresh.userConfigurationDigest});
  f.options.targetManifest={schema:'tavern-release/v2',commit:f.commit,versions:{tavern:'2.4.3'},launcherVersion:'2.2.3',
    publication:{schema:'nora-component-publication/1',tag:'v2.4.4'}};
  f.options.targetDelivery=f.delivery;
  f.options.readLauncherIdentity=async()=>Object.fromEntries(Object.entries(before).filter(([name])=>!['executableSha256','asarSha256'].includes(name)));
  const payloadFile=path.join(f.delivery,'payload.json'),payload=JSON.parse(fs.readFileSync(payloadFile));
  payload.versions.tavern=proof.targetVersion;payload.commit=f.identity.commit;const payloadBytes=JSON.stringify(payload);fs.writeFileSync(payloadFile,payloadBytes);
  proof.targetManifestSha256=hash(payloadBytes);proof.baselineManifestSha256=hash(payloadBytes);f.identity.payloadManifestSha256=hash(payloadBytes);proof.coreIdentity.manifestSha256=hash(payloadBytes);f.fresh.releaseManifestSha256=proof.targetManifestSha256;
  const entry={asset:'darwin-arm64-release-manifest.json',sha256:hash(payloadBytes),size:Buffer.byteLength(payloadBytes)};
  f.options.targetManifest.coreRelease={schema:'nora-core-reference/1',tag:'v2.4.3',commit:f.identity.commit,manifests:{'darwin-arm64':entry}};
  Object.assign(f.options.targetManifest,{candidate:false,dirty:false,artifacts:payload.artifacts,hermesRuntime:payload.hermesRuntime});
  const productBytes=JSON.stringify(f.options.targetManifest);fs.writeFileSync(path.join(f.delivery,'release-manifest.json'),productBytes);f.fresh.actorManifestSha256=hash(productBytes);
  fs.writeFileSync(path.join(f.delivery,entry.asset),payloadBytes);
  const systemFile=path.join(f.delivery,'nora-system-darwin-arm64.json'),system=JSON.parse(fs.readFileSync(systemFile));
  system.version=proof.targetVersion;system.publication=f.options.targetManifest.publication;system.coreRelease=f.options.targetManifest.coreRelease;system.files['release-manifest.json']=entry;
  const systemBytes=JSON.stringify(system);fs.writeFileSync(systemFile,systemBytes);f.app.payloadManifestSha256=hash(systemBytes);
  f.save=(()=>{const save=f.save;return ()=>{save();fs.writeFileSync(path.join(f.reports,'nora-packaged-app-acceptance.json'),JSON.stringify(f.app));
    fs.writeFileSync(path.join(f.reports,'fresh/harness-result.json'),JSON.stringify(f.fresh));};})();
  proof.cases={};
  for(const [index,report] of f.historical.entries()) {
    delete report.versionTransition;
    Object.assign(report,{launcherTransition:{...proof,startState:['running','stopped'][index]},
      releaseManifestSha256:proof.targetManifestSha256,
      releaseAcceptance:'isolated-launcher-transition',update:'verified-launcher-transition',changedLauncherFiles:2,
      coreBefore:{...proof.coreIdentity},coreAfter:{...proof.coreIdentity},preservedCoreFiles:4,
      actorSourceBinding:'verified-native-app-source',moduleHashes:f.app.moduleHashes,http:'verified'});
    const state=['running','stopped'][index],directory=path.join(f.reports,'historical-'+index),runtimeProof=Object.fromEntries(['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'].map(key=>[key,true]));Object.assign(runtimeProof,{sessionReadable:true,httpStatus:200,worldCount:1});
    const before={core:{app:{files:[{path:'main.js',size:4,sha256:hash('core')}]}},receipts:{'installed-manifest.json':proof.coreIdentity.manifestSha256,'installed.json':hash('receipt'),'nora-system.json':hash('initialization')},protectedData:{files:[{path:'chat.jsonl',size:4,sha256:hash('chat')}]},config:{model:hash('config')}};
    const checkpoint={schema:'nora-app-native-checkpoint/1',scope:'published-baseline',productCommit:proof.targetCommit,targetTag:proof.targetTag,baselineTag:proof.baselineTag,sourceReceiptSha256:proof.sourceReceiptSha256,coreIdentity:proof.coreIdentity,before,status:{running:state==='running'},runtimeProof};
    const operation={operationId:'native-'+state,planDigest:hash('fixedplan'),state:'succeeded',verification:'confirmed',target:{request:{launcherOnly:true},releasePlan:{tag:proof.targetTag}},result:{running:state==='running',updateVerified:true,version:proof.coreIdentity.version,commit:proof.coreIdentity.commit}};
    const observed={sourceProof:{modules:f.app.moduleHashes,actors:report.actorSourceFiles},after:before,status:{running:state==='running'},runtimeProof,operation,operations:[operation],ready:{operationId:operation.operationId,planDigest:operation.planDigest,version:after.version}};
    const finished={status:{running:false,systemReady:true},offline:true,processes:[],lockProof:{busy:false}};
    const evidence={coreFilesCount:4,coreFilesSha256:hash(JSON.stringify({core:before.core,receipts:before.receipts})),protectedDataSha256:hash(JSON.stringify(before.protectedData.files)),userConfigurationDigest:hash(JSON.stringify(before.config)),nativeEvidence:{}};
    for(const [name,field,value]of [['checkpoint.json','checkpointSha256',checkpoint],['observed.json','observedSha256',observed],['finished-status.json','finishedStatusSha256',finished]]){const bytes=JSON.stringify(value);fs.writeFileSync(path.join(directory,name),bytes);evidence.nativeEvidence[field]=hash(bytes);}
    proof.cases[state]=evidence;Object.assign(report,{coreFilesBeforeSha256:evidence.coreFilesSha256,coreFilesAfterSha256:evidence.coreFilesSha256,protectedDataBeforeSha256:evidence.protectedDataSha256,protectedDataAfterSha256:evidence.protectedDataSha256,userConfigurationDigest:evidence.userConfigurationDigest});

  }
  for(const [index,report]of f.historical.entries())report.launcherTransition={...proof,startState:['running','stopped'][index]};
  f.save();return f;
}
test('APP-only publication requires native transitions while binding unchanged core separately from batch',async t=>{
  const f=launcherHistoricalFixture(t),result=await f.execute();
  assert.equal(result.baselines['darwin-arm64'].scope,'launcher-transition');
  assert.equal((await verifyNativeAcceptance(f.delivery,f.acceptance,f.commit,['darwin-arm64']))['darwin-arm64'].harnessReports,4);
});
test('APP-only native proof permits a reused Electron executable when actual ASAR changes',async t=>{
  const f=launcherHistoricalFixture(t);f.proof.baselineLauncher.executableSha256=f.proof.targetLauncher.executableSha256;f.save();
  assert.equal((await f.execute()).baselines['darwin-arm64'].scope,'launcher-transition');
});
test('APP-only publication independently binds a first-install receipt without confusing it with release bytes',async t=>{
 const f=launcherHistoricalFixture(t),target='darwin-arm64';
 const source=JSON.parse(fs.readFileSync(path.join(f.delivery,target+'-release-manifest.json')));
 const dependencies={schema:1,platform:'darwin',arch:'arm64',archive:'nora-tavern-dependencies-darwin-arm64.tar.gz',sha256:hash('deps archive'),size:50,nodeMajor:24,roots:['app/engine/sillytavern/node_modules','nora-mcp/node_modules']};
 const metadata=JSON.stringify(dependencies),asset='darwin-arm64-nora-tavern-dependencies.json',installedSha=hash(JSON.stringify({...source,integratedDependencies:dependencies},null,2));
 fs.writeFileSync(path.join(f.delivery,asset),metadata);
 const systemFile=path.join(f.delivery,'nora-system-'+target+'.json'),system=JSON.parse(fs.readFileSync(systemFile));system.files['nora-tavern-dependencies.json']={asset,sha256:hash(metadata),size:Buffer.byteLength(metadata)};
 const systemBytes=JSON.stringify(system);fs.writeFileSync(systemFile,systemBytes);f.app.payloadManifestSha256=hash(systemBytes);
 for(const [index,state]of ['running','stopped'].entries()){
  const directory=path.join(f.reports,'historical-'+index),checkpoint=JSON.parse(fs.readFileSync(path.join(directory,'checkpoint.json'))),observed=JSON.parse(fs.readFileSync(path.join(directory,'observed.json')));
  checkpoint.actualInstalledManifestSha256=installedSha;checkpoint.before.receipts['installed-manifest.json']=installedSha;observed.after=checkpoint.before;
  const evidence=f.proof.cases[state];evidence.actualInstalledManifestSha256=installedSha;evidence.coreFilesSha256=hash(JSON.stringify({core:checkpoint.before.core,receipts:checkpoint.before.receipts}));
  for(const [name,field,value]of [['checkpoint.json','checkpointSha256',checkpoint],['observed.json','observedSha256',observed]]){const bytes=JSON.stringify(value);fs.writeFileSync(path.join(directory,name),bytes);evidence.nativeEvidence[field]=hash(bytes);}
  Object.assign(f.historical[index],{coreFilesBeforeSha256:evidence.coreFilesSha256,coreFilesAfterSha256:evidence.coreFilesSha256});
 }
 for(const [index,report]of f.historical.entries())report.launcherTransition={...f.proof,startState:['running','stopped'][index]};f.save();
 assert.notEqual(installedSha,f.proof.coreIdentity.manifestSha256);assert.equal((await f.execute()).baselines[target].scope,'launcher-transition');
 fs.appendFileSync(path.join(f.delivery,asset),' ');await assert.rejects(f.execute(),/metadata (size|SHA)/,'Changed metadata cannot authorize another local receipt');
});
for(const [name,mutate] of [
  ['missing target metadata',f=>delete f.options.targetManifest],
  ['forged publication',f=>f.options.targetManifest.publication.tag='v2.4.5'],
  ['missing native APP proof',f=>fs.unlinkSync(path.join(f.reports,'nora-packaged-app-acceptance.json'))],
  ['missing stopped APP transition',f=>fs.rmSync(path.join(f.reports,'historical-1'),{recursive:true})],
  ['changed core',f=>{f.historical[0].coreAfter.manifestSha256=hash('changed');f.save();}],
  ['changed user data',f=>{f.historical[0].protectedDataAfterSha256=hash('changed');f.save();}],
  ['false post-update health',f=>{f.historical[0].http='unknown';f.save();}],
  ['forged baseline APP',f=>f.options.readLauncherIdentity=async()=>({...f.proof.baselineLauncher,archiveSha256:hash('other')} )],
  ['changed target archive',f=>fs.appendFileSync(path.join(f.delivery,'Nora-Tavern-Launcher-2.2.3-darwin-arm64-update.zip'),'changed')],
])test(`APP-only publication refuses ${name}`,async t=>{
  const f=launcherHistoricalFixture(t);mutate(f);await assert.rejects(f.execute());
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
for(const [name,mutate]of [
 ['missing explicit original core reference',f=>delete f.options.targetManifest.coreRelease],
 ['different original core source',f=>f.options.targetManifest.coreRelease.commit='c'.repeat(40)],
 ['different original core bytes',f=>f.options.targetManifest.coreRelease.manifests['darwin-arm64'].sha256=hash('repacked same version')],
 ['missing raw native evidence',f=>fs.unlinkSync(path.join(f.reports,'historical-0/observed.json'))],
 ['changed raw core inventory',f=>fs.appendFileSync(path.join(f.reports,'historical-0/checkpoint.json'),' ')],
 ['missing full core inventory digest',f=>{delete f.proof.cases.running.coreFilesSha256;f.save();}],
])test(`APP-only native publication refuses ${name}`,async t=>{const f=launcherHistoricalFixture(t);mutate(f);await assert.rejects(f.execute());});

test('tooling changes plan against the latest stable product, independently of its older upgrade baseline',()=>{
 const {selectPlanningBaseline}=require('../tooling/release/publication-source.cjs');
 const pages=[[stableRelease('v2.6.0'),stableRelease('v2.6.4'),{...stableRelease('v2.6.5'),prerelease:true}]];
 assert.equal(selectPlanningBaseline(pages),'v2.6.4');
 assert.equal(selectAcceptanceBaseline(pages,{repository:'owner/tavern',targetTag:'v2.6.4'}).tag,'v2.6.0');
 assert.equal(selectPlanningBaseline([[]]),'EMPTY');
 assert.throws(()=>selectPlanningBaseline([[stableRelease('v2.6.4')],[stableRelease('v2.6.4')]]));
});

test('failed component aggregation can preserve complete split source and native producers, never their failed stages',()=>{
 const {jobName,componentSourceGates}=require('../tooling/release/build-stage.cjs');
 const f=qualificationFixture(),listing=f.options.qualificationJobs;
 listing.jobs=listing.jobs.filter(job=>!job.name.startsWith('native-components'));
 for(const platform of ['darwin-arm64','darwin-x64','win32-x64'])for(const stage of ['source','acceptance']){
  const gates=stage==='source'?componentSourceGates:['Restore successful source qualification without running it again',
    'Test fresh target installation and both native upgrade states with retained user data','Preserve raw native component evidence'];
  listing.jobs.push({id:100+listing.jobs.length,run_id:f.run.id,run_attempt:1,head_sha:f.run.head_sha,name:jobName(stage,platform,'components'),
    status:'completed',conclusion:'success',steps:gates.map(name=>({name,status:'completed',conclusion:'success'}))});
 }
 listing.total_count=listing.jobs.length;
 assert.equal(componentQualification(f.run,f.options).producerJobIds.length,7);
 listing.jobs[2].steps[0].conclusion='skipped';assert.throws(()=>componentQualification(f.run,f.options));
});

test('a revised verifier may retain a successfully built component product even when its original native fixture failed',()=>{
 const {verifyComponentProduct}=require('../tooling/release/publication-source.cjs');
 const f=qualificationFixture();f.options.qualificationJobs.jobs[2].conclusion='failure';
 const producer=f.options.qualificationJobs.jobs[0];producer.started_at='2026-11-02T00:00:00Z';producer.completed_at='2026-11-02T00:05:00Z';
 for(const item of f.artifacts.artifacts)item.created_at='2026-11-02T00:04:00Z';
 const proof=verifyComponentProduct(f.run,f.artifacts,f.options.qualificationJobs,f.options);
 assert.equal(proof.productCommit,f.run.head_sha);assert.equal(proof.productRun,f.run.id);
 assert.deepEqual(proof.artifacts.map(item=>item.name).sort(),['nora-component-delivery','nora-release-plan']);
 for(const change of [x=>x.jobs.jobs[0].conclusion='failure',x=>x.jobs.jobs[0].steps[0].conclusion='skipped',x=>x.artifacts.artifacts[0].created_at='2026-11-02T00:06:00Z',x=>x.run.head_sha='b'.repeat(40),x=>x.run.conclusion='cancelled']){
  const x={run:structuredClone(f.run),artifacts:structuredClone(f.artifacts),jobs:structuredClone(f.options.qualificationJobs)};
  change(x);assert.throws(()=>verifyComponentProduct(x.run,x.artifacts,x.jobs,f.options));
 }
});

test('revalidation compares fixed source trees: pure verification changes are allowed, actual product changes are refused',async()=>{
 const {verifyRevalidationInputs}=require('../tooling/release/publication-source.cjs');
 const repo=path.resolve(__dirname,'..'),product='8241b79c6759c1aaea2e494b42f342d92ca15eff';
 const result=await verifyRevalidationInputs({root:repo,productCommit:product,verificationCommit:'4b74567cb5fc6344019fb3550cc0f1d6fb21756e'});
 assert.equal(result.mode,'verification-only');assert.equal(result.requiresReview,false);
 await assert.rejects(verifyRevalidationInputs({root:repo,productCommit:execFileSync('git',['rev-parse','v2.6.0^{commit}'],{cwd:repo,encoding:'utf8'}).trim(),verificationCommit:product}),/product|construction|verification-only/i);
});

test('retained product wrapper preserves original ZIP bytes and rechecks API provenance before extracting on a new worker',async t=>{
 const {restoreComponentProduct,unwrapComponentProduct}=require('../tooling/release/publication-source.cjs');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nora-retained-product-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const root=path.resolve(__dirname,'..'),tag='v2.5.5',commit=execFileSync('git',['rev-parse',tag+'^{commit}'],{cwd:root,encoding:'utf8'}).trim();
 const {componentAcceptanceFixture}=await import('./helpers/component-acceptance-fixture.mjs');
 const payload=componentAcceptanceFixture(path.join(temporary,'fixture'),commit),f=qualificationFixture();
 f.run.head_sha=commit;f.options.commit=commit;
 for(const item of f.artifacts.artifacts){item.workflow_run.head_sha=commit;item.created_at='2026-11-02T00:04:00Z';}
 for(const job of f.options.qualificationJobs.jobs){job.head_sha=commit;job.started_at='2026-11-02T00:00:00Z';job.completed_at='2026-11-02T00:05:00Z';}
 // An old native fixture failure is preserved; new raw native evidence will be required later.
 f.options.qualificationJobs.jobs[2].conclusion='failure';
 const archives=new Map();
 for(const name of ['nora-component-delivery','nora-release-plan']){
  const directory=name==='nora-component-delivery'?payload.delivery:payload.planRoot,file=path.join(temporary,name+'.zip');
  writeFixtureArchives([{output:file,directory}]);
  const item=f.artifacts.artifacts.find(item=>item.name===name);item.size_in_bytes=fs.statSync(file).size;item.digest='sha256:'+hash(fs.readFileSync(file));archives.set(item.id,file);
 }
 const verificationCommit='4b74567cb5fc6344019fb3550cc0f1d6fb21756e',checks=[];
 const shared={repository:f.options.repository,tag,verificationCommit,root,
  facts:()=>({run:f.run,artifacts:f.artifacts,jobs:f.options.qualificationJobs}),
  verifyInputs:async args=>{checks.push(args);return {mode:'verification-only',requiresReview:false};}};
 const restored=await restoreComponentProduct({...shared,runId:f.run.id,output:path.join(temporary,'source'),download:async(item,_repo,target)=>fs.copyFileSync(archives.get(item.id),target)});
 assert.deepEqual(fs.readFileSync(path.join(restored.bundle,'delivery.zip')),fs.readFileSync(archives.get(1)));
 const next=await unwrapComponentProduct({...shared,productCommit:commit,bundle:restored.bundle,output:path.join(temporary,'next-worker')});
 assert.deepEqual(fs.readFileSync(path.join(next.delivery,'release-manifest.json')),fs.readFileSync(path.join(payload.delivery,'release-manifest.json')));
 assert.equal(next.receipt.productRun,f.run.id);assert.equal(next.receipt.verificationCommit,verificationCommit);
 assert.equal(checks.length,2);assert.ok(checks.every(item=>item.productCommit===commit&&item.verificationCommit===verificationCommit));
 const archive=path.join(restored.bundle,'delivery.zip');fs.appendFileSync(archive,'changed');
 await assert.rejects(unwrapComponentProduct({...shared,productCommit:commit,bundle:restored.bundle,output:path.join(temporary,'bad-worker')}),/size|digest/);
 assert.equal(fs.existsSync(path.join(temporary,'bad-worker')),false);
});

test('actual revalidation CLIs restore one original product, bind new three-platform evidence and refuse changed protection',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-revalidation-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'source'),bin=path.join(root,'bin'),temp=path.join(root,'runner');for(const dir of [repo,bin,temp])fs.mkdirSync(dir);
 const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:'pipe'}).trim();
 const write=(file,value)=>{const target=path.join(repo,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);};
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 write('tooling/source-layout.json',JSON.stringify({schema:1,rules:[['launcher/ui/','ops/installer/']]}));
 write('launcher/desktop/package.json',JSON.stringify({name:'fixture',version:'1.0.0',build:{files:[],extraResources:[]}}));
 write('launcher/ui/index.html','unchanged product');git('add','.');git('-c','commit.gpgSign=false','commit','-qm','product');
 const productCommit=git('rev-parse','HEAD');git('tag','v2.5.5');
 write('tests/verifier.test.mjs','// revised verifier only');git('add','.');git('-c','commit.gpgSign=false','commit','-qm','verifier');
 const verificationCommit=git('rev-parse','HEAD'),script=path.resolve(__dirname,'../tooling/release/publication-source.cjs');
 const {componentAcceptanceFixture}=await import('./helpers/component-acceptance-fixture.mjs');
 const {sealComponentAcceptance}=await import('../tooling/release/component-acceptance.mjs');
 const stage=require('../tooling/release/build-stage.cjs'),payload=componentAcceptanceFixture(path.join(root,'payload'),productCommit);
 const original=qualificationFixture();original.run.id=456;original.run.head_sha=productCommit;original.options.runId='456';original.options.commit=productCommit;
 original.options.qualificationJobs.jobs[2].conclusion='failure';
 for(const item of original.artifacts.artifacts){item.id+=100;item.workflow_run.id=456;item.workflow_run.head_sha=productCommit;item.created_at='2026-11-02T00:04:00Z';}
 for(const job of original.options.qualificationJobs.jobs)Object.assign(job,{run_id:456,head_sha:productCommit,started_at:'2026-11-02T00:00:00Z',completed_at:'2026-11-02T00:05:00Z'});
 for(const item of original.artifacts.artifacts.filter(item=>['nora-component-delivery','nora-release-plan'].includes(item.name))){
  const file=path.join(root,`${item.id}.zip`);writeFixtureArchives([{output:file,directory:item.name==='nora-component-delivery'?payload.delivery:payload.planRoot}]);
  item.size_in_bytes=fs.statSync(file).size;item.digest='sha256:'+hash(fs.readFileSync(file));
 }
 for(const [name,value]of [['original-run',original.run],['original-artifacts',original.artifacts],['original-jobs',original.options.qualificationJobs]])fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value));
 writeGhFixture(bin,`const fs=require('node:fs'),path=require('node:path'),root=process.env.FIXTURE_ZIP_ROOT,endpoint=process.argv.at(-1);
fs.appendFileSync(path.join(root,'api-calls.txt'),endpoint+'\\n');
let file,slurp=false;
if(endpoint.includes('/actions/artifacts/'))file=endpoint.split('/').at(-2)+'.zip';
else if(endpoint.endsWith('/runs/456'))file='original-run.json';
else if(endpoint.includes('/runs/456/artifacts?')){file='original-artifacts.json';slurp=true;}
else if(endpoint.includes('/runs/456/jobs?')){file='original-jobs.json';slurp=true;}
else if(endpoint.includes('/runs/123/jobs?')){file='current-jobs.json';slurp=true;}
else throw Error('Unexpected fixture API '+endpoint);
const bytes=fs.readFileSync(path.join(root,file));process.stdout.write(slurp?'['+bytes+']':bytes);
`);
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FIXTURE_ZIP_ROOT:root,GITHUB_REPOSITORY:'owner/tavern',GITHUB_SHA:verificationCommit,
  RUNNER_TEMP:temp,GITHUB_ENV:path.join(temp,'env'),GITHUB_OUTPUT:path.join(temp,'output'),BASELINE_TAG:payload.baselineTag,
  NORA_PRODUCT_SOURCE_RUN:'456',NORA_PRODUCT_SOURCE_TAG:payload.tag};
 const execute=(args,extra={})=>spawnSync(process.execPath,[script,...args],{cwd:repo,env:{...env,...extra},encoding:'utf8'});
 const restored=execute(['restore-product']);assert.equal(restored.status,0,restored.stderr);
 const bundle=path.join(temp,'retained-component/bundle'),origin=JSON.parse(fs.readFileSync(path.join(bundle,'product-source.json')));
 assert.equal(origin.sourceRunConclusion,'failure');assert.equal(origin.productCommit,productCommit);
 const unwrapped=execute(['unwrap-product',bundle,path.join(temp,'native-worker')],{PRODUCT_COMMIT:productCommit,PRODUCT_TAG:payload.tag});
 assert.equal(unwrapped.status,0,unwrapped.stderr);
 const current=fixture('components');current.run.head_sha=verificationCommit;current.run.run_attempt=1;
 for(const item of current.artifacts.artifacts)item.workflow_run.head_sha=verificationCommit;
 const delivery=current.artifacts.artifacts.find(item=>item.name==='nora-component-delivery');
 writeFixtureArchives([{output:path.join(root,`${delivery.id}.zip`),directory:bundle}]);delivery.size_in_bytes=fs.statSync(path.join(root,`${delivery.id}.zip`)).size;delivery.digest='sha256:'+hash(fs.readFileSync(path.join(root,`${delivery.id}.zip`)));
 const jobs={jobs:[]};
 for(const [index,platform]of ['darwin-arm64','darwin-x64','win32-x64'].entries()){
  const item={...delivery,id:20+index,name:stage.name('source',platform,'components')};
  const bytes=Buffer.from('synthetic source checkpoint '+platform);fs.writeFileSync(path.join(root,`${item.id}.zip`),bytes);item.size_in_bytes=bytes.length;item.digest='sha256:'+hash(bytes);current.artifacts.artifacts.push(item);
  const environment={imageOS:platform,imageVersion:'1',kernel:'fixture',node:'v24.19.0',python:'3.11.9',platform};
  const context={repository:'owner/tavern',commit:verificationCommit,runId:123,attempt:1,platform,baseline:payload.baselineTag,environment,
   options:{pipeline:'components',force_full_regression:false,productCommit,productSourceRun:'456',deliveryArtifactId:String(delivery.id),deliveryArtifactDigest:delivery.digest}};
  const receipt={schema:'nora-build-stage/1',stage:'source',context,inputs:[],archive:{size:10240,sha256:hash('synthetic tar')}};
  const job={id:30+index,run_id:123,run_attempt:1,head_sha:verificationCommit,name:stage.jobName('source',platform,'components'),status:'completed',conclusion:'success',steps:stage.componentSourceGates.map(name=>({name,status:'completed',conclusion:'success'}))};jobs.jobs.push(job);
  payload.write(payload.reports,`nora-component-native-${platform}/nora-stage-input-source.json`,{schema:'nora-stage-input/1',stage:'source',consumerEnvironment:{...environment,imageVersion:'2'},artifact:{id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest},receipt,producer:{id:job.id,attempt:1}});
 }
 jobs.total_count=jobs.jobs.length;fs.writeFileSync(path.join(root,'current-jobs.json'),JSON.stringify(jobs));
 fs.unlinkSync(payload.output);sealComponentAcceptance({delivery:payload.delivery,reports:payload.reports,plan:payload.plan,output:payload.output,commit:productCommit,tag:payload.tag,productSource:origin,verificationCommit});
 const archiveEvidence=()=>{
  for(const item of current.artifacts.artifacts.filter(item=>item.id!==delivery.id&&item.id<20)){
   const directory=item.name==='nora-component-acceptance'?payload.reports:item.name==='nora-release-plan'?payload.planRoot:path.join(payload.reports,item.name);
   const file=path.join(root,`${item.id}.zip`);writeFixtureArchives([{output:file,directory,...(item.name==='nora-component-acceptance'?{only:'component-acceptance.json'}:{})}]);item.size_in_bytes=fs.statSync(file).size;item.digest='sha256:'+hash(fs.readFileSync(file));
  }
  current.artifacts.total_count=current.artifacts.artifacts.length;
  fs.writeFileSync(path.join(root,'current-run.json'),JSON.stringify(current.run));fs.writeFileSync(path.join(root,'current-artifacts.json'),JSON.stringify(current.artifacts));
 };
 archiveEvidence();fs.writeFileSync(path.join(root,'api-calls.txt'),'');
 const publish=(name,enabled='true')=>execute(['delivery',path.join(root,'current-run.json'),path.join(root,'current-artifacts.json'),productCommit,'owner/tavern','123','components',path.join(root,name),payload.tag,'','','','',enabled]);
 const accepted=publish('accepted');assert.equal(accepted.status,0,accepted.stderr);
 const proof=JSON.parse(fs.readFileSync(path.join(root,'accepted/source-receipt.json')));assert.equal(proof.sourceCommit,productCommit);assert.equal(proof.verificationCommit,verificationCommit);assert.deepEqual(proof.productOrigin,origin);assert.equal(Object.keys(proof.componentSourceQualification).length,3);
 assert.deepEqual(fs.readFileSync(path.join(root,'accepted/delivery/release-manifest.json')),fs.readFileSync(path.join(payload.delivery,'release-manifest.json')));
 const calls=fs.readFileSync(path.join(root,'api-calls.txt'),'utf8');
 for(const item of origin.artifacts)assert.ok(!calls.includes(`/actions/artifacts/${item.id}/zip`),'publisher must consume embedded original bytes instead of downloading the original product again');
 assert.notEqual(publish('without-opt-in','false').status,0);
 const raw=path.join(payload.reports,'nora-component-native-win32-x64/stopped/harness-result.json'),previous=fs.readFileSync(raw),bad=JSON.parse(previous);bad.userData='changed';fs.writeFileSync(raw,JSON.stringify(bad));archiveEvidence();
 const rejected=publish('bad-data');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/retained|changed|digest|native/i);assert.equal(fs.existsSync(path.join(root,'bad-data/source-receipt.json')),false);
 fs.writeFileSync(raw,previous);const sourceProof=path.join(payload.reports,'nora-component-native-win32-x64/nora-stage-input-source.json'),wrong=JSON.parse(fs.readFileSync(sourceProof));wrong.receipt.context.options.deliveryArtifactId='999';fs.writeFileSync(sourceProof,JSON.stringify(wrong));archiveEvidence();
 const refused=publish('bad-upstream');assert.notEqual(refused.status,0);assert.match(refused.stderr,/different upstream delivery/);assert.equal(fs.existsSync(path.join(root,'bad-upstream/source-receipt.json')),false);
});

test('cross-commit component revalidation is explicit, cannot authorize full packages, and still requires a completed new verification run',()=>{
 const f=fixture('components'),product='b'.repeat(40);
 assert.throws(()=>verifyDelivery(f.run,f.artifacts,{...f.options,commit:product}));
 assert.equal(verifyDelivery(f.run,f.artifacts,{...f.options,commit:product,revalidatedComponents:true}).length,6);
 for(const extra of [{mode:'full'},{revalidatedComponents:'false'}])
  assert.throws(()=>verifyDelivery(f.run,f.artifacts,{...f.options,commit:product,revalidatedComponents:true,...extra}));
 f.run.conclusion='failure';assert.throws(()=>verifyDelivery(f.run,f.artifacts,{...f.options,commit:product,revalidatedComponents:true}));
});

test('failed attempt diagnostics never become product input or erase the preserved failure',()=>{
 const f=fixture('components');f.run.run_attempt=2;
 const item={...f.artifacts.artifacts[0],id:99,name:'nora-component-failed-native-darwin-arm64-attempt-1'};
 f.artifacts.artifacts.push(item);f.artifacts.total_count++;
 assert.equal(verifyDelivery(f.run,f.artifacts,f.options).length,6);
 item.name='nora-component-failed-native-darwin-arm64-attempt-3';assert.throws(()=>verifyDelivery(f.run,f.artifacts,f.options));
 item.name='nora-component-failed-native-unknown-attempt-1';assert.throws(()=>verifyDelivery(f.run,f.artifacts,f.options));
});

test('summary requalification uses the latest producer of each name and records, rather than hides, earlier failures',()=>{
 const f=qualificationFixture();f.run.run_attempt=2;
 const current=f.options.qualificationJobs.jobs[2],old={...structuredClone(current),id:99,conclusion:'failure'};
 current.run_attempt=2;f.options.qualificationJobs.jobs.push(old);f.options.qualificationJobs.total_count++;
 const proof=componentQualification(f.run,f.options);
 assert.equal(proof.previousAttempts[0].id,99);assert.equal(proof.previousAttempts[0].conclusion,'failure');
 current.conclusion='failure';old.conclusion='success';assert.throws(()=>componentQualification(f.run,f.options));
});
