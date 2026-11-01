// Publication tools may evolve without changing already accepted product bytes.
// Keep the product commit, publisher commit and GitHub artifact identities separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { verifyArchive, extractScript } = require('./reuse-windows-build.cjs');
const {stageArtifacts,verifyPublishedStages} = require('./build-stage.cjs');
const platforms = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const fullNames = ['nora-tavern-shared', ...platforms.map(p => `nora-tavern-${p}`),
  ...platforms.map(p => `nora-operation-acceptance-${p}`)];
const componentNames = ['nora-component-delivery', 'nora-component-acceptance', 'nora-release-plan',
  ...platforms.map(p => `nora-component-native-${p}`)];
const stateNames = ['nora-publication-state-before-transfer', 'nora-publication-state'];
const diagnostics = ['nora-windows-failed-packaging-diagnostic'];
const digestBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function versionParts(tag) { assert.match(tag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/); return tag.slice(1).split('-')[0].split('.').map(Number); }
function compareVersions(left, right) { const a = versionParts(left), b = versionParts(right); for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1; return 0; }
function selectAcceptanceBaseline(pages, { repository, targetTag, requestedTag = '', publication = false }) {
  versionParts(targetTag); assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(Array.isArray(pages)); const releases = pages.flat(); assert.ok(releases.every(value => value && typeof value === 'object'));
  const stable = releases.filter(value => value.draft === false && value.prerelease === false && /^v\d+\.\d+\.\d+$/.test(value.tag_name));
  assert.equal(new Set(stable.map(value => value.tag_name)).size, stable.length, 'Duplicate published stable tag');
  const historical = stable.filter(value => compareVersions(value.tag_name, targetTag) < 0).sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  if (requestedTag === 'EMPTY') assert.equal(stable.length, 0, 'EMPTY is allowed only when the API proves there is no published stable release');
  let tag = requestedTag || historical[0]?.tag_name || 'EMPTY';
  if (tag !== 'EMPTY') { assert.ok(stable.some(value => value.tag_name === tag), 'Acceptance baseline must be an actually published stable release'); assert.ok(compareVersions(tag, targetTag) < 0, 'Acceptance baseline must be strictly older than the product'); assert.equal(tag, historical[0]?.tag_name, 'Formal acceptance must use the most recent published older stable release'); }
  else if (!publication) assert.equal(stable.length, 0, 'First release requires independent empty stable-release facts');
  return { schema: 'nora-acceptance-baseline-selection/1', repository, targetTag, tag, initialRelease: tag === 'EMPTY',
    stableReleaseCount: stable.length, historicalReleaseCount: historical.length,
    releases: stable.map(({ id, tag_name, draft, prerelease, published_at }) => ({ id, tag_name, draft, prerelease, published_at })),
    apiSnapshotSha256: digestBytes(JSON.stringify(pages)), observedAt: new Date().toISOString() };
}
async function digestFile(file) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function reportFiles(root, basename) { return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name === basename).map(entry => path.join(entry.parentPath, entry.name)); }
function oneReport(root, name) { const files = reportFiles(root, name); assert.equal(files.length, 1, `Missing or duplicate native report: ${name}`); return JSON.parse(fs.readFileSync(files[0])); }
async function verifyNativeAcceptance(delivery, acceptance, commit, selected = platforms) {
  const result = {};
  for (const target of selected) {
    const [platform, arch] = target.split('-'), reports = path.join(acceptance, `nora-operation-acceptance-${target}`);
    const systemFile = path.join(delivery, `nora-system-${target}.json`), systemBytes = fs.readFileSync(systemFile), system = JSON.parse(systemBytes);
    assert.equal(system.commit, commit); assert.equal(system.candidate, false); assert.equal(`${system.platform}-${system.arch}`, target);
    const payloadBytes = fs.readFileSync(path.join(delivery, system.files['release-manifest.json'].asset)), payload = JSON.parse(payloadBytes);
    const payloadHash = digestBytes(payloadBytes), systemHash = digestBytes(systemBytes);
    let product=payload;
    if(system.coreRelease){
      product=JSON.parse(fs.readFileSync(path.join(delivery,'release-manifest.json')));
      const {assertCoreReleasePayload}=await import('./system-release.mjs');
      assert.equal(product.commit,commit);assert.deepEqual(system.coreRelease,product.coreRelease);
      assertCoreReleasePayload(product,payloadBytes,target,system.files['release-manifest.json']);
    }
    const runtimeHash=payload.hermesRuntime?.sha256||JSON.parse(fs.readFileSync(path.join(delivery,system.files['nora-hermes-runtime.json'].asset))).sha256;
    assert.equal(product.commit, commit); assert.equal(payload.candidate, false); assert.equal(payload.dirty, false);
    const app = name => {
      const value = oneReport(reports, name); assert.equal(value.schema, 'nora-app-candidate-gate/1'); assert.equal(value.platform, platform); assert.equal(value.arch, arch);
      assert.equal(value.payloadManifestSha256, systemHash);
      assert.ok(typeof value.versions?.electron === 'string' && value.versions.electron);
      for (const key of ['actualElectron', 'nativeDependencyComplete', 'allFlatResourceHashesMatchCandidate', 'jsPythonReceiptAgree', 'arbitraryCliRefusedBeforeOperation']) assert.equal(value.assertions?.[key], true, `Native APP gate failed: ${key}`);
      assert.ok(Object.keys(value.moduleHashes || {}).length > 0, 'Actual APP module hashes are missing');
      const expectedModules = Object.keys(product.artifacts).filter(name => name.startsWith('ops/installer/desktop/')
        && /\.(?:js|mjs|cjs|json)$/.test(name) && !['ops/installer/desktop/package.json', 'ops/installer/desktop/package-lock.json'].includes(name))
        .map(name => name.slice('ops/installer/desktop/'.length)).sort();
      assert.deepEqual(Object.keys(value.moduleHashes).sort(), expectedModules, 'Native APP report must cover the exact authored production modules');
      for (const [name, hash] of Object.entries(value.moduleHashes)) assert.equal(hash, product.artifacts['ops/installer/desktop/' + name], `APP module differs: ${name}`);
      return value;
    };
    const packaged = app('nora-packaged-app-acceptance.json');
    const network = oneReport(reports, 'nora-electron-network-acceptance.json');
    assert.equal(network.schema, 'nora-electron-network/1');
    assert.equal(network.scope, 'packaged-network-modules-in-native-chromium');
    assert.equal(network.platform, platform); assert.equal(network.arch, arch);
    assert.equal(network.actualChromiumNet, true); assert.equal(network.windowCount, 0);
    assert.equal(network.versions?.electron, packaged.versions.electron);
    for (const key of ['manualRedirect', 'sourceFallback', 'untrustedRedirectRefused', 'abort', 'sessionProxy', 'streaming', 'deadline'])
      assert.equal(network.assertions?.[key], true, `Native network gate failed: ${key}`);
    for (const field of ['executable', 'asar']) {
      assert.match(packaged[field]?.sha256 || '', /^[a-f0-9]{64}$/);
      assert.equal(network[field]?.sha256, packaged[field].sha256, `Native network ${field} differs from APP`);
    }
    assert.equal(network.runtimeExecutable?.sha256, packaged.executable.sha256, 'Native network runtime executable differs');
    const networkModules = ['release-network.js', 'release-sources.js', 'release-sources.json', 'launcher-errors.js'];
    assert.deepEqual(Object.keys(network.moduleHashes || {}).sort(), networkModules.sort(), 'Native network module closure differs');
    for (const name of networkModules)
      assert.equal(network.moduleHashes[name], packaged.moduleHashes[name], `Native network module differs: ${name}`);
    if (platform === 'win32') {
      app('nora-installed-app-acceptance.json'); const setup = oneReport(reports, 'nora-installed-setup-acceptance.json');
      assert.equal(setup.schema, 'nora-installed-setup/1'); assert.equal(setup.exitCode, 0); assert.equal(setup.autoLaunch, false);
      assert.ok(Number.isSafeInteger(setup.verifiedUnpackedFiles) && setup.verifiedUnpackedFiles > 0);
      assert.match(setup.installer, /^Nora-Tavern-[A-Za-z0-9.+-]+-win-x64-setup\.exe$/);
      assert.equal(setup.installerSha256, await digestFile(path.join(delivery, setup.installer)));
    }
    const harness = reportFiles(reports, 'harness-result.json').map(file => JSON.parse(fs.readFileSync(file)));
    assert.ok(harness.length >= 2, 'Missing native runtime/install harness evidence');
    for (const value of harness) {
      assert.equal(value.schema, 'nora-launcher-products-smoke/1'); assert.equal(value.outcome, 'passed'); assert.equal(value.platform, platform); assert.equal(value.arch, arch);
      assert.equal(value.executorHandles, 'verified-closed'); assert.equal(value.operation, 'verified'); assert.equal(value.runtime, 'verified'); assert.equal(value.runtimeSha256, runtimeHash);
      if(value.launcherTransition){assert.equal(value.actorSourceBinding,'verified-native-app-source');assert.deepEqual(value.moduleHashes,packaged.moduleHashes);for(const name of ['operation_control.py','operation_cli.py','operation_evidence.py','desktop/operation-delegate.js'])assert.equal(value.actorSourceFiles?.[name],product.artifacts['ops/installer/'+name]);continue;}
      for (const name of ['operation_control.py', 'operation_cli.py', 'operation_evidence.py', 'desktop/operation-delegate.js']) assert.match(value.actorSourceFiles?.[name] || '', /^[a-f0-9]{64}$/);
      for (const [name, hash] of Object.entries(value.actorSourceFiles)) assert.equal(hash, product.artifacts['ops/installer/' + name], `Native actor differs: ${name}`);
      if (value.releaseManifestSha256) {
        assert.equal(value.releaseManifestSha256, payloadHash);if(system.coreRelease)assert.match(value.actorManifestSha256||'',/^[a-f0-9]{64}$/,'Actual current actor manifest hash is missing'); assert.equal(value.actorSourceBinding, 'verified-selected-candidate-manifest');
        for (const key of ['firstInstall', 'http', 'hermesSkills', 'mcp', 'stop']) assert.equal(value[key], 'verified');
        assert.equal(value.userData, 'retained'); assert.equal(value.modelConfiguration, 'verified-local-A-to-B-model-requests');
      }
    }
    assert.equal(harness.filter(value => value.releaseManifestSha256 === null).length, 1);
    const fresh = harness.filter(value => value.releaseManifestSha256 === payloadHash && !value.versionTransition && !value.launcherTransition);
    assert.equal(fresh.length, 1); assert.equal(fresh[0].committedFirstInstall, 'verified-real-resume-without-reinstall');
    assert.equal(fresh[0].missingSystemReceipt, 'verified-bound-repair-and-preserved-user-data');
    assert.match(fresh[0].userConfigurationDigest || '', /^[a-f0-9]{64}$/, 'User configuration preservation requires a concrete digest');
    const baselineFiles = reportFiles(reports, 'nora-upgrade-baseline-acceptance.json'); assert.ok(baselineFiles.length <= 1);
    if (baselineFiles.length) {
      const baseline = JSON.parse(fs.readFileSync(baselineFiles[0]));
      const launcherOnly=baseline.schema==='nora-app-upgrade-baseline/1';
      assert.ok(launcherOnly||baseline.schema==='nora-upgrade-baseline/1');
      assert.equal(baseline.platform, target); assert.equal(baseline.targetCommit, commit); assert.equal(baseline.targetVersion, system.version); assert.equal(baseline.targetManifestSha256, payloadHash);
      assert.ok((launcherOnly?['launcher-transition-required']:['version-transition-required', 'same-version-repair-only']).includes(baseline.acceptance));
      if(launcherOnly){
        const {releasePublicationTag}=await import('./system-release.mjs');
        assert.equal(baseline.targetTag,releasePublicationTag(system));
        assert.equal(baseline.targetLauncher?.executableSha256,packaged.executable.sha256);
        assert.equal(baseline.targetLauncher?.asarSha256,packaged.asar.sha256);
      }
      if (baseline.acceptance === 'version-transition-required') for (const state of ['running', 'stopped']) {
        const historical = harness.filter(value => value.versionTransition?.startState === state); assert.equal(historical.length, 1);
        const { startState, ...proof } = historical[0].versionTransition; assert.deepEqual(proof, baseline);
        assert.equal(historical[0].update, 'verified-content-transition'); assert.equal(historical[0].userConfigurationDigest, fresh[0].userConfigurationDigest);
      }
    }
    result[target] = { outcome: 'passed', appManifestSha256: systemHash, payloadManifestSha256: payloadHash,
      nativeNetwork:network.scope, harnessReports: harness.length };
  }
  return result;
}
async function verifyAppOnlyHistory(reports,proof,{identity,readLauncher,repository,tag,target,targetManifest,targetDelivery}) {
  const {releasePublicationTag,coreReleaseIdentity,coreReceiptRepresentations}=await import('./system-release.mjs');
  assert.ok(targetManifest&&targetDelivery,'APP-only evidence requires authenticated target delivery metadata');
  assert.equal(proof.acceptance,'launcher-transition-required');
  assert.equal(proof.targetVersion,proof.baselineVersion,'APP-only evidence must retain the actual core version');
  assert.equal(proof.targetTag,releasePublicationTag(targetManifest),'APP-only target publication differs');
  const retained=coreReleaseIdentity(targetManifest,target);assert.ok(retained,'APP-only requires an explicit original core reference');
  assert.equal(retained.commit,identity.commit);assert.equal(retained.tag,identity.coreTag||tag);
  assert.equal(retained.manifests[target].sha256,identity.payloadManifestSha256,'APP-only may not repack the core');
  assert.equal(proof.targetManifestSha256,identity.payloadManifestSha256);
  assert.deepEqual(proof.coreIdentity,{version:identity.version,commit:identity.commit,manifestSha256:identity.payloadManifestSha256});
  const coreEntry=retained.manifests[target],coreBytes=fs.readFileSync(path.join(targetDelivery,coreEntry.asset));
  assert.equal(coreBytes.length,coreEntry.size);assert.equal(digestBytes(coreBytes),identity.payloadManifestSha256);
  const targetSystem=JSON.parse(fs.readFileSync(path.join(targetDelivery,`nora-system-${target}.json`)));
  const dependencyEntry=targetSystem.files?.['nora-tavern-dependencies.json'];let dependenciesBytes;
  if(dependencyEntry){assert.match(dependencyEntry.asset||'',/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);dependenciesBytes=fs.readFileSync(path.join(targetDelivery,dependencyEntry.asset));}
  const [platform,arch]=target.split('-'),receiptIdentity=coreReceiptRepresentations(coreBytes,{platform,arch,
    ...(dependencyEntry?{dependencyEntry,dependenciesBytes}:{})});
  assert.deepEqual(Object.keys(proof.cases||{}).sort(),['running','stopped']);
  const official=await readLauncher({repository,tag,platform:target});
  for(const [name,value] of Object.entries(official))assert.equal(proof.baselineLauncher?.[name],value,`Official baseline APP differs: ${name}`);
  const descriptorBytes=fs.readFileSync(path.join(targetDelivery,`nora-launcher-${target}.json`)),descriptor=JSON.parse(descriptorBytes);
  assert.equal(descriptor.schema,'nora-launcher/v1');assert.equal(descriptor.candidate,false);
  assert.equal(`${descriptor.platform}-${descriptor.arch}`,target);assert.equal(descriptor.commit,targetManifest.commit);
  assert.equal(descriptor.version,targetManifest.launcherVersion);
  assert.match(descriptor.asset||'',/^[A-Za-z0-9][A-Za-z0-9._-]*-update\.zip$/);
  const archive=path.join(targetDelivery,descriptor.asset);
  assert.equal(fs.statSync(archive).size,descriptor.size);assert.equal(await digestFile(archive),descriptor.sha256);
  const targetIdentity={version:descriptor.version,commit:descriptor.commit,descriptorSha256:digestBytes(descriptorBytes),
    archiveSha256:descriptor.sha256,archiveSize:descriptor.size};
  for(const [name,value] of Object.entries(targetIdentity))assert.equal(proof.targetLauncher?.[name],value,`Target APP differs: ${name}`);
  assert.ok(compareVersions('v'+descriptor.version,'v'+official.version)>0,'APP-only evidence needs an actual APP version transition');
  for(const value of [proof.baselineLauncher,proof.targetLauncher])for(const name of ['executableSha256','asarSha256'])assert.match(value?.[name]||'',/^[a-f0-9]{64}$/);
  assert.ok(proof.baselineLauncher.executableSha256!==proof.targetLauncher.executableSha256
    ||proof.baselineLauncher.asarSha256!==proof.targetLauncher.asarSha256,'APP transition must change actual executable or ASAR bytes');
  const packaged=oneReport(reports,'nora-packaged-app-acceptance.json');
  assert.equal(packaged.schema,'nora-app-candidate-gate/1');
  assert.equal(packaged.assertions?.actualElectron,true);
  assert.equal(packaged.executable?.sha256,proof.targetLauncher.executableSha256);
  assert.equal(packaged.asar?.sha256,proof.targetLauncher.asarSha256);
  const harness=reportFiles(reports,'harness-result.json').map(file=>JSON.parse(fs.readFileSync(file))).filter(value=>value.launcherTransition);
  assert.equal(harness.length,2,'APP-only publication requires running and stopped native APP upgrades');
  for(const state of ['running','stopped']){
    const values=harness.filter(value=>value.launcherTransition.startState===state);assert.equal(values.length,1);
    const value=values[0],{startState,...recorded}=value.launcherTransition;assert.deepEqual(recorded,proof);
    assert.equal(value.outcome,'passed');assert.equal(value.update,'verified-launcher-transition');
    assert.equal(value.releaseAcceptance,'isolated-launcher-transition');assert.equal(value.updateInitialService,state);
    const evidence=proof.cases[state];assert.ok(Number.isSafeInteger(evidence.coreFilesCount)&&evidence.coreFilesCount>0);
    for(const name of ['coreFilesSha256','protectedDataSha256','userConfigurationDigest'])assert.match(evidence[name]||'',/^[a-f0-9]{64}$/);
    for(const [field,expected] of Object.entries({executorHandles:'verified-closed',operation:'verified',runtime:'verified',
      http:'verified',hermesSkills:'verified',mcp:'verified',stop:'verified',userData:'retained'}))assert.equal(value[field],expected);
    assert.deepEqual(value.coreBefore,proof.coreIdentity);assert.deepEqual(value.coreAfter,proof.coreIdentity);
    assert.equal(value.preservedCoreFiles,evidence.coreFilesCount);
    assert.equal(value.coreFilesBeforeSha256,evidence.coreFilesSha256);assert.equal(value.coreFilesAfterSha256,evidence.coreFilesSha256);
    assert.equal(value.protectedDataBeforeSha256,evidence.protectedDataSha256);assert.equal(value.protectedDataAfterSha256,evidence.protectedDataSha256);
    assert.equal(value.userConfigurationDigest,evidence.userConfigurationDigest);
    assert.ok(Number.isSafeInteger(value.changedLauncherFiles)&&value.changedLauncherFiles>0);
    const directory=path.dirname(reportFiles(reports,'harness-result.json').find(file=>JSON.parse(fs.readFileSync(file)).launcherTransition?.startState===state));
    const native={};for(const [name,field]of [['checkpoint.json','checkpointSha256'],['observed.json','observedSha256'],['finished-status.json','finishedStatusSha256']]){const bytes=fs.readFileSync(path.join(directory,name));assert.equal(digestBytes(bytes),evidence.nativeEvidence?.[field],'Native evidence bytes differ');native[name]=JSON.parse(bytes);}
    const before=native['checkpoint.json'],after=native['observed.json'],finished=native['finished-status.json'];
    assert.equal(before.schema,'nora-app-native-checkpoint/1');assert.equal(before.scope,'published-baseline','Private native baselines cannot authorize publication');
    assert.equal(before.productCommit,proof.targetCommit);assert.equal(before.targetTag,proof.targetTag);assert.equal(before.baselineTag,tag);assert.equal(before.sourceReceiptSha256,proof.sourceReceiptSha256);
    assert.deepEqual(before.coreIdentity,proof.coreIdentity);assert.deepEqual(after.after,before.before,'Raw native core/data/config inventories changed');
    const actualInstalled=evidence.actualInstalledManifestSha256||proof.coreIdentity.manifestSha256;
    assert.ok(receiptIdentity.representations.some(value=>value.sha256===actualInstalled),'Local manifest is not an authenticated core representation');
    assert.equal(before.actualInstalledManifestSha256||proof.coreIdentity.manifestSha256,actualInstalled);
    assert.equal(before.before.receipts['installed-manifest.json'],actualInstalled);
    assert.equal(digestBytes(JSON.stringify({core:before.before.core,receipts:before.before.receipts})),evidence.coreFilesSha256);
    assert.equal(digestBytes(JSON.stringify(before.before.protectedData.files)),evidence.protectedDataSha256);
    assert.equal(digestBytes(JSON.stringify(before.before.config)),evidence.userConfigurationDigest);
    assert.equal(Object.values(before.before.core).reduce((count,tree)=>count+tree.files.length,0)+Object.keys(before.before.receipts).length,evidence.coreFilesCount);
    assert.equal(before.status.running,state==='running');assert.equal(after.operation.result.running,state==='running');
    if(state==='stopped'&&after.status.running){assert.ok(after.continuationOperations?.length);for(const start of after.continuationOperations){assert.equal(start.kind,'start');assert.equal(start.target?.request?.service,'tavern');assert.equal(start.state,'succeeded');assert.equal(start.verification,'confirmed');assert.ok(Date.parse(start.createdAt)>=Date.parse(after.operation.updatedAt));}}else assert.equal(after.status.running,state==='running');
    for(const runtime of [before.runtimeProof,after.runtimeProof]){for(const key of ['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration','sessionReadable'])assert.equal(runtime?.[key],true);assert.equal(runtime.httpStatus,200);assert.ok(Number.isSafeInteger(runtime.worldCount)&&runtime.worldCount>0);}
    assert.deepEqual(after.sourceProof.modules,value.moduleHashes);assert.deepEqual(after.sourceProof.actors,value.actorSourceFiles);
    assert.equal(after.operation.state,'succeeded');assert.equal(after.operation.verification,'confirmed');assert.equal(after.operation.target?.request?.launcherOnly,true);assert.equal(after.operation.target?.releasePlan?.tag,proof.targetTag);
    assert.equal(after.operation.result?.updateVerified,true);assert.equal(after.operation.result?.version,proof.coreIdentity.version);assert.equal(after.operation.result?.commit,proof.coreIdentity.commit);
    assert.equal(after.operations.length,1);assert.equal(after.ready.operationId,after.operation.operationId);assert.equal(after.ready.planDigest,after.operation.planDigest);assert.equal(after.ready.version,proof.targetLauncher.version);
    assert.equal(finished.status.running,false);assert.equal(finished.status.systemReady,true);assert.equal(finished.offline,true);assert.deepEqual(finished.processes,[]);assert.equal(finished.lockProof.busy,false);

  }
}
async function verifyHistoricalAcceptance(acceptance, planRoot, pages, { repository, targetTag, commit, selected = platforms, readIdentity,readLauncherIdentity,targetManifest,targetDelivery }) {
  const {releasePublicationTag}=await import('./system-release.mjs');
  if(targetManifest){assert.equal(targetManifest.commit,commit);assert.equal(releasePublicationTag(targetManifest),targetTag);}
  const coreVersion=targetManifest?.versions?.tavern||targetTag.slice(1);
  const freshFacts = selectAcceptanceBaseline(pages, { repository, targetTag, publication: true });
  const selections = fs.existsSync(planRoot) ? reportFiles(planRoot, 'nora-acceptance-baseline-selection.json') : [];
  assert.ok(selections.length <= 1, 'Duplicate original acceptance selection');
  const original = selections.length ? JSON.parse(fs.readFileSync(selections[0])) : null;
  if (original) {
    assert.equal(original.schema, 'nora-acceptance-baseline-selection/1'); assert.equal(original.repository, repository); assert.equal(original.targetTag, targetTag);
    assert.match(original.apiSnapshotSha256 || '', /^[a-f0-9]{64}$/); assert.ok(Array.isArray(original.releases));
    const snapshot = oneReport(planRoot, 'nora-acceptance-published-releases.json');
    assert.equal(digestBytes(JSON.stringify(snapshot)), original.apiSnapshotSha256, 'Original API snapshot differs from its acceptance selection');
    const derived = selectAcceptanceBaseline(snapshot, { repository, targetTag, requestedTag: original.tag });
    for (const key of ['tag', 'initialRelease', 'stableReleaseCount', 'historicalReleaseCount', 'releases']) assert.deepEqual(original[key], derived[key], 'Original acceptance selection does not follow its API facts');
    if (original.initialRelease === true) {
      assert.equal(original.tag, 'EMPTY'); assert.equal(original.stableReleaseCount, 0); assert.equal(original.historicalReleaseCount, 0);
      assert.equal(original.releases.length, 0); assert.equal(freshFacts.historicalReleaseCount, 0, 'A historical stable release now disproves the first-release exception');
      for (const target of selected) assert.equal(reportFiles(path.join(acceptance, `nora-operation-acceptance-${target}`), 'nora-upgrade-baseline-acceptance.json').length, 0);
      return { initialRelease: true, source: 'original-workflow-api-facts-and-current-published-history', apiSnapshotSha256: original.apiSnapshotSha256 };
    }
    assert.equal(original.initialRelease, false); assert.ok(original.stableReleaseCount > 0);
  }
  const result = {};
  const read = readIdentity || (await import('./acceptance-baseline.mjs')).readAcceptanceIdentity;
  for (const target of selected) {
    const reports = path.join(acceptance, `nora-operation-acceptance-${target}`), proof = oneReport(reports, 'nora-upgrade-baseline-acceptance.json');
    const launcherOnly=proof.schema==='nora-app-upgrade-baseline/1';
    assert.ok(launcherOnly||proof.schema==='nora-upgrade-baseline/1');assert.equal(proof.targetCommit,commit);assert.equal(proof.targetVersion,coreVersion);
    if(targetTag!==`v${coreVersion}`)assert.equal(proof.targetTag,targetTag,'Component evidence must bind its publication batch separately');
    const tag = proof.baselineTag||`v${proof.baselineVersion}`; assert.ok(compareVersions(tag, targetTag) < 0, 'Historical upgrade evidence must use a strictly older version');
    assert.ok(freshFacts.releases.some(value => value.tag_name === tag), 'Historical baseline is not an actually published stable release');
    assert.equal(tag, freshFacts.tag, 'Historical upgrade evidence must cover the most recent published older stable release');
    if (original) { assert.equal(original.tag, tag); assert.equal(proof.sourceTag, tag); }
    const identity = await read({ tag, repository, platform: target });
    assert.equal(identity.schema, 'nora-acceptance-baseline/1'); assert.equal(identity.repository, repository); assert.equal(identity.tag, tag);
    assert.equal(identity.platform, target); assert.equal(identity.version, proof.baselineVersion); assert.equal(identity.commit, proof.baselineCommit);
    assert.equal(identity.systemManifestSha256, proof.systemManifestSha256); assert.equal(identity.payloadManifestSha256, proof.baselineManifestSha256);
    assert.equal(identity.declaredFiles, proof.verifiedFiles);
    if(launcherOnly){
      await verifyAppOnlyHistory(reports,proof,{identity,readLauncher:readLauncherIdentity||(await import('./acceptance-baseline.mjs')).readAcceptanceLauncherIdentity,
        repository,tag,target,targetManifest,targetDelivery});
    }else{
    assert.equal(proof.acceptance, 'version-transition-required');
    assert.ok(compareVersions('v'+proof.targetVersion,'v'+proof.baselineVersion)>0,'Core upgrade evidence requires an actual version transition');
    const historical = reportFiles(reports, 'harness-result.json').map(file => JSON.parse(fs.readFileSync(file))).filter(value => value.versionTransition);
    assert.equal(historical.length, 2, 'Formal publication requires both running and stopped historical upgrades');
    for (const state of ['running', 'stopped']) {
      const values = historical.filter(value => value.versionTransition.startState === state); assert.equal(values.length, 1);
      const { startState, ...recorded } = values[0].versionTransition; assert.deepEqual(recorded, proof);
      assert.equal(values[0].outcome, 'passed'); assert.equal(values[0].update, 'verified-content-transition');
      assert.equal(values[0].releaseAcceptance, 'isolated-version-transition'); assert.equal(values[0].updateInitialService, state);
      assert.ok(Number.isSafeInteger(values[0].changedSourceArtifacts) && values[0].changedSourceArtifacts > 0);
    }
    }
    const retained = reportFiles(reports, 'baseline-source-receipt.json');
    if (original) assert.equal(retained.length, 1, 'New acceptance must retain the official baseline receipt');
    if (retained.length) {
      assert.equal(retained.length, 1); const bytes = fs.readFileSync(retained[0]), receipt = JSON.parse(bytes);
      assert.equal(digestBytes(bytes), proof.sourceReceiptSha256); assert.equal(receipt.schema, 'nora-acceptance-baseline/1'); assert.equal(receipt.mode, 'materialized');
      for (const key of ['repository', 'tag', 'platform', 'commit', 'version', 'systemManifestSha256', 'payloadManifestSha256', 'declaredFiles']) assert.equal(receipt[key], identity[key]);
      assert.equal(receipt.verifiedFiles, receipt.declaredFiles); assert.deepEqual(receipt.files, identity.files);
    }
    result[target] = { tag, commit: identity.commit, systemManifestSha256: identity.systemManifestSha256, payloadManifestSha256: identity.payloadManifestSha256, states: ['running', 'stopped'],...(launcherOnly?{scope:'launcher-transition'}:{}) };
  }
  return { initialRelease: false, baselines: result };
}
async function verifyComponentAcceptance(delivery, acceptance, planRoot, commit) {
  const report = oneReport(acceptance, 'component-acceptance.json');
  assert.equal(report.schema, 'nora-component-acceptance/2', 'Component publication requires three-platform native acceptance; old source-only receipts are insufficient');
  assert.equal(report.commit, commit); assert.equal(report.outcome, 'passed'); assert.match(report.tag, /^v\d+\.\d+\.\d+$/);
  const plan = oneReport(planRoot, 'release-plan.json'); assert.equal(plan.schema, 'nora-release-plan/v1'); assert.equal(plan.source.commit, commit);
  assert.equal(plan.mode, 'components'); assert.equal(plan.requiresReview, false);
  const names = new Set();
  for (const [relative, entry] of Object.entries(report.files)) {
    const name = path.basename(relative); assert.ok(!names.has(name), 'Duplicate component receipt basename'); names.add(name);
    assert.equal(fs.statSync(path.join(delivery, name)).size, entry.size); assert.equal(await digestFile(path.join(delivery, name)), entry.sha256);
  }
  assert.deepEqual([...names].sort(), fs.readdirSync(delivery).sort(), 'Component receipt must cover the exact delivery');
  assert.match(plan.baseline.ref, /^v\d+\.\d+\.\d+$/); assert.match(plan.baseline.commit, /^[a-f0-9]{40}$/);
  const {verifyComponentNative}=await import('./component-acceptance.mjs');
  assert.deepEqual(Object.keys(report.native || {}).sort(), [...platforms].sort(), 'All native platforms are required for component publication');
  const native={};
  for(const platform of platforms){
    native[platform]=verifyComponentNative({delivery,reports:path.join(acceptance,`nora-component-native-${platform}`),
      platform,commit,baselineTag:plan.baseline.ref,baselineCommit:plan.baseline.commit});
    assert.deepEqual(report.native[platform],native[platform],'Final component receipt differs from raw native evidence');
  }
  return { outcome: 'passed', files: names.size, native };
}
function identity(run, artifacts, { repository, runId }, conclusions) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(String(runId), /^[1-9][0-9]*$/); assert.ok(Number.isSafeInteger(Number(runId)));
  assert.equal(run.id, Number(runId)); assert.equal(run.repository.full_name, repository);
  assert.ok(Number.isSafeInteger(run.repository.id) && run.repository.id > 0);
  assert.equal(run.head_repository?.id, run.repository.id, 'Source run came from a fork');
  assert.equal(run.head_repository?.full_name, repository);
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.status, 'completed');
  assert.ok(conclusions.includes(run.conclusion), 'Source run has not reached an accepted terminal state');
  assert.equal(artifacts.total_count, artifacts.artifacts.length, 'Incomplete artifact listing');
  assert.equal(new Set(artifacts.artifacts.map(item => item.name)).size, artifacts.artifacts.length, 'Duplicate artifact name');
  assert.equal(new Set(artifacts.artifacts.map(item => item.id)).size, artifacts.artifacts.length, 'Duplicate artifact ID');
  for (const item of artifacts.artifacts) {
    assert.ok(Number.isSafeInteger(item.id) && item.id > 0); assert.equal(item.expired, false);
    assert.ok(Number.isSafeInteger(item.size_in_bytes) && item.size_in_bytes > 0);
    assert.match(item.digest || '', /^sha256:[a-f0-9]{64}$/, 'Artifact API digest is required');
    assert.equal(item.workflow_run.id, run.id); assert.equal(item.workflow_run.head_sha, run.head_sha);
    assert.equal(item.workflow_run.repository_id, run.repository.id);
    assert.equal(item.workflow_run.head_repository_id, run.repository.id);
  }
}
function verifyDelivery(run, artifacts, options) {
  identity(run, artifacts, options, ['success']);
  assert.match(options.commit, /^[a-f0-9]{40}$/); assert.equal(run.head_sha, options.commit, 'Product source differs from release tag');
  assert.ok(['full', 'components'].includes(options.mode));
  const full = options.mode === 'full';
  assert.equal(run.path, `.github/workflows/${full ? 'build-integrated-launcher' : 'publish-component-update'}.yml`);
  const intermediate = full ? new Set(stageArtifacts(artifacts).map(item=>item.name)) : new Set();
  const names = artifacts.artifacts.filter(item=>!intermediate.has(item.name)).map(item => item.name).sort();
  const expected = full ? fullNames : componentNames;
  assert.deepEqual(names.filter(name => name !== 'nora-release-plan' && !(full && diagnostics.includes(name))), expected.filter(name => name !== 'nora-release-plan').sort(), 'Incomplete accepted delivery or unexpected artifact');
  if (!full) assert.ok(names.includes('nora-release-plan'), 'Component source must retain its change plan');
  return artifacts.artifacts.filter(item => !diagnostics.includes(item.name)&&!intermediate.has(item.name));
}
function verifyState(run, artifacts, options) {
  identity(run, artifacts, options, ['success', 'failure', 'cancelled']);
  assert.equal(run.path, '.github/workflows/publish-accepted-release.yml');
  assert.ok(artifacts.artifacts.length > 0 && artifacts.artifacts.every(item => stateNames.includes(item.name)), 'Unexpected publication state artifact');
  // Prefer the last durable checkpoint; a runner crash can leave only the original sealed plan.
  return artifacts.artifacts.find(item => item.name === stateNames[1]) || artifacts.artifacts[0];
}
function immutableStateHashes(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Linked checkpoint member'); if (entry.isDirectory()) continue;
    assert.ok(entry.isFile(), 'Invalid checkpoint member');
    const file = path.join(entry.parentPath, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
    if (['publication-state.json', 'workflow-provenance.json'].includes(relative)) continue;
    result[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right, 'en')));
}
function snapshotBeforeTransfer(root,target) {
  root=path.resolve(root);target=path.resolve(target);
  const relative=path.relative(root,target),parent=fs.lstatSync(path.dirname(target)),source=fs.lstatSync(root);
  assert.ok(source.isDirectory()&&!source.isSymbolicLink()&&parent.isDirectory()&&!parent.isSymbolicLink(),'Invalid checkpoint directory');
  assert.ok(relative&&(relative.startsWith('..'+path.sep)||path.isAbsolute(relative))&&!fs.existsSync(target),'Snapshot must be a new directory outside the live state');
  immutableStateHashes(root); // Reject linked or non-regular members before copying.
  const plan=JSON.parse(fs.readFileSync(path.join(root,'publication-plan.json')));
  assert.ok(plan.destinations===undefined||Array.isArray(plan.destinations),'Invalid checkpoint destinations');
  fs.mkdirSync(target,{mode:0o700});
  try {
    for(const entry of fs.readdirSync(root,{recursive:true,withFileTypes:true})) {
      const file=path.join(entry.parentPath,entry.name),name=path.relative(root,file),destination=path.join(target,name);
      if(entry.isDirectory())fs.mkdirSync(destination,{recursive:true,mode:0o700});
      else {
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        if(['publication-state.json','workflow-provenance.json'].includes(name))fs.copyFileSync(file,destination);
        else fs.linkSync(file,destination);
      }
    }
    if(plan.destinations?.includes('jihulab')) {
      const file=path.join(target,'publication-state.json'),checkpoint=JSON.parse(fs.readFileSync(file));
      checkpoint.checkpointKind='before-transfer';
      fs.writeFileSync(file,JSON.stringify(checkpoint,null,2)+'\n');
    }
  }catch(error){fs.rmSync(target,{recursive:true,force:true});throw error;}
}
function verifyRestoredState(root, run, options) {
  const file = path.join(root, 'workflow-provenance.json');
  assert.ok(fs.lstatSync(file).isFile(), 'Publication workflow provenance is required');
  const value = JSON.parse(fs.readFileSync(file));
  assert.equal(value.schema, 'nora-publication-workflow/1');
  assert.equal(value.publisherCommit, run.head_sha, 'Checkpoint publisher commit differs');
  assert.equal(value.tag, options.tag, 'Checkpoint belongs to another release tag');
  assert.equal(value.sourceCommit, options.commit, 'Checkpoint belongs to another product commit');
  assert.equal(String(value.sourceRun), String(options.deliveryRun), 'Checkpoint belongs to another accepted source run');
  assert.equal(value.assetMode, options.assetMode, 'Cannot change the original asset mode during resume');
  assert.equal(value.receipt?.sourceCommit, options.commit);
  assert.equal(String(value.receipt?.sourceRun), String(options.deliveryRun));
  assert.equal(value.receipt?.mode, options.mode);
  assert.deepEqual(immutableStateHashes(root), value.sealedStateHashes, 'Immutable checkpoint bytes differ from the original receipt');
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'publication-plan.json')));
  if(plan.destinations?.includes('jihulab'))assert.equal(options.stateArtifact?.name,stateNames[1],
    'JihuLab recovery requires the final checkpoint; a pre-transfer snapshot may have lost an unresolved PUT. Reconcile the remote inventory manually before retrying.');
  const planId = crypto.createHash('sha256').update(JSON.stringify(plan, null, 2) + '\n').digest('hex');
  assert.equal(value.planId, planId, 'Plan differs from the externally retained publication receipt');
  const expectedReceipt = options.deliveryReceipt;
  if (expectedReceipt) {
    const sort = values => values.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    assert.deepEqual(sort(value.receipt.artifacts), sort(expectedReceipt.artifacts), 'Accepted artifact identities changed during resume');
  }
  return value;
}
function flattenDelivery(source, target) {
  fs.mkdirSync(target, { recursive: true }); const seen = new Set(fs.readdirSync(target).map(name => name.normalize('NFC').toLowerCase()));
  for (const entry of fs.readdirSync(source, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Linked delivery entry'); if (entry.isDirectory()) continue; assert.ok(entry.isFile());
    const name = entry.name;
    if (name === 'release-notes.generated.md' || name.endsWith('.blockmap') || /^latest.*\.yml$/.test(name)) continue;
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    const key = name.normalize('NFC').toLowerCase(); assert.ok(!seen.has(key), `Duplicate delivery basename: ${name}`); seen.add(key);
    fs.renameSync(path.join(entry.parentPath, name), path.join(target, name));
  }
}
async function downloadArchive(item, repository, archive, { timeout = 20 * 60 * 1000, idleTimeout = 5 * 60 * 1000, killGrace = 2000, spawnProcess = spawn } = {}) {
  const child = spawnProcess('gh', ['api', `repos/${repository}/actions/artifacts/${item.id}/zip`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let failure, force, idle, received = 0; const started = Date.now();
  const stop = reason => { if (failure) return; failure = new Error(`Artifact ${item.name} download ${reason}`); failure.code = 'ETIMEDOUT'; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), killGrace); };
  const deadline = setTimeout(() => stop('exceeded its total deadline'), timeout);
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => stop('made no progress before its idle deadline'), idleTimeout); };
  resetIdle(); child.stdout.on('data', chunk => { received += chunk.length; resetIdle(); });
  const heartbeat = setInterval(() => console.log(`Artifact download ${item.name}: ${received}/${item.size_in_bytes} bytes, ${Math.round((Date.now() - started) / 1000)} seconds`), 30000);
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error(`Artifact download exited ${code}`))); });
  try {
    await Promise.all([pipeline(child.stdout, fs.createWriteStream(archive, { flags: 'wx' })), closed]);
    await verifyArchive(archive, item);
  } catch (error) { if (!failure) { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), killGrace); } await closed.catch(() => {}); throw error; }
  finally { clearTimeout(deadline); clearTimeout(force); clearTimeout(idle); clearInterval(heartbeat); }
}
async function materialize(run, artifacts, options, root, kind) {
  const accepted = kind === 'state' ? [verifyState(run, artifacts, options)] : verifyDelivery(run, artifacts, options);
  assert.ok(!fs.existsSync(root), 'Source directory already exists'); fs.mkdirSync(root, { recursive: true });
  const receipt = { schema: 'nora-publication-source/1', kind, sourceRun: run.id, sourceCommit: run.head_sha,
    publisherCommit: process.env.GITHUB_SHA || null, mode: options.mode || null, artifacts: [] };
  const originalDeliveries = new Map();
  for (const item of accepted) {
    const archive = path.join(root, item.name + '.zip');
    await downloadArchive(item, options.repository, archive);
    const category = kind === 'state' ? 'state' : item.name === 'nora-release-plan' ? 'plan'
      : item.name.includes('acceptance') || item.name.startsWith('nora-component-native-') ? 'acceptance' : 'delivery';
    const destination = kind === 'state' ? path.join(root, 'state') : path.join(root, category === 'delivery' ? 'originals' : category, item.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync('python3', ['-c', extractScript, archive, destination], { stdio: 'inherit' });
    if (category === 'delivery') originalDeliveries.set(item.name,destination);
    receipt.artifacts.push({ id: item.id, name: item.name, size: item.size_in_bytes, digest: item.digest });
  }
  if (kind === 'state') verifyRestoredState(path.join(root, 'state'), run, {...options,stateArtifact:accepted[0]});
  else {
    if (options.mode === 'full') {
      // Verify the complete sealed package before filtering public assets.
      // Metadata names may repeat across platform archives with different bytes.
      receipt.stageAcceptance = await verifyPublishedStages(path.join(root,'delivery'),path.join(root,'acceptance'),run,artifacts,{
        resolveDeliveryFile:(platform,name)=>{
          const source=originalDeliveries.get(`nora-tavern-${platform}`);
          assert.ok(source,`Missing original platform delivery: ${platform}`);
          const files=reportFiles(source,name);
          assert.equal(files.length,1,`Missing or duplicate original package file: ${platform}/${name}`);
          return files[0];
        },
      });
    }
    for (const source of originalDeliveries.values()) flattenDelivery(source,path.join(root,'delivery'));
    if (options.mode === 'full') {
      receipt.acceptance = await verifyNativeAcceptance(path.join(root, 'delivery'), path.join(root, 'acceptance'), options.commit);
      assert.ok(options.publishedFacts && options.tag, 'Full publication requires independent published-release facts');
      receipt.historicalAcceptance = await verifyHistoricalAcceptance(path.join(root, 'acceptance'), path.join(root, 'plan'), options.publishedFacts,
        { ...options, targetTag: options.tag,targetDelivery:path.join(root,'delivery'),
          targetManifest:JSON.parse(fs.readFileSync(path.join(root,'delivery/release-manifest.json'))) });
    } else receipt.acceptance = await verifyComponentAcceptance(path.join(root, 'delivery'), path.join(root, 'acceptance'), path.join(root, 'plan'), options.commit);
  }
  fs.writeFileSync(path.join(root, 'source-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(`Verified ${kind} source ${run.id} at ${run.head_sha}; artifact ZIP digests match.`);
  return receipt;
}
module.exports = { selectAcceptanceBaseline, compareVersions, verifyHistoricalAcceptance, verifyDelivery, verifyState, verifyRestoredState, verifyNativeAcceptance, verifyComponentAcceptance, immutableStateHashes, snapshotBeforeTransfer, flattenDelivery, downloadArchive, materialize, fullNames, componentNames, stateNames };
if (require.main === module) {
  if (process.argv[2] === 'baseline-selection') {
    const [, , , releasesFile, targetTag, repository, requestedTag, output, githubOutput, operation] = process.argv;
    const selection = selectAcceptanceBaseline(JSON.parse(fs.readFileSync(releasesFile)), { targetTag, repository, requestedTag, publication: operation === 'publication' });
    fs.writeFileSync(output, JSON.stringify(selection, null, 2) + '\n', { flag: 'wx' });
    if (githubOutput) fs.appendFileSync(githubOutput, `acceptance_baseline_tag=${selection.tag}\ninitial_release=${selection.initialRelease}\n`);
    process.exit(0);
  }
  const [kind, runFile, artifactsFile, commit, repository, runId, mode, output, tag, deliveryRun, assetMode, receiptFile] = process.argv.slice(2);
  assert.ok(['delivery', 'state'].includes(kind));
  materialize(JSON.parse(fs.readFileSync(runFile)), JSON.parse(fs.readFileSync(artifactsFile)),
    { commit, repository, runId, mode, tag, deliveryRun, assetMode,
      publishedFacts: kind === 'delivery' && mode === 'full' && deliveryRun ? JSON.parse(fs.readFileSync(deliveryRun)) : null,
      deliveryReceipt: receiptFile ? JSON.parse(fs.readFileSync(receiptFile)) : null }, path.resolve(output), kind).catch(error => { console.error(error); process.exitCode = 1; });
}
