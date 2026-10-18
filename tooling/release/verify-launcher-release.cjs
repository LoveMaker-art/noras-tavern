const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function verifyRelease() {
const { assertMaintenanceVersions, releasePublicationTag, assertCoreReleasePayload } = await import('./system-release.mjs');
const [root, tag, commit, mode = 'full'] = process.argv.slice(2);
assert.ok(root && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag) && /^[a-f0-9]{40}$/.test(commit));
assert.ok(['full', 'components'].includes(mode), 'Invalid verification mode');
const files = fs.readdirSync(root, { recursive: true }).filter(name => fs.statSync(path.join(root, name)).isFile());
const byName = new Map();
for (const name of files) {
  const base = path.basename(name);
  if (base === 'LAUNCHER-SHA256SUMS' || base === 'release-notes.generated.md' || base.endsWith('.blockmap') || /^latest.*\.yml$/.test(base)) continue;
  assert.ok(!byName.has(base), `Duplicate release asset: ${base}`);
  byName.set(base, path.join(root, name));
}
const digest = file => {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const shared = JSON.parse(fs.readFileSync(byName.get('release-manifest.json')));
const capabilities={operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2};
assert.deepEqual(shared.launcherCapabilities,capabilities,'Shared launcherCapabilities are unsupported');
assert.match(shared.bootstrap?.minimumLauncherVersion, /^\d+\.\d+\.\d+$/);
assertMaintenanceVersions({ launcherVersion: shared.launcherVersion, minimumLauncherVersion: shared.bootstrap.minimumLauncherVersion });
let reuse;
if (mode === 'components') {
  reuse = JSON.parse(fs.readFileSync(byName.get('component-release.json')));
  assert.equal(reuse.schema, 'nora-component-release/v1');
  assert.equal(reuse.version, shared.versions.tavern);
  assert.equal(reuse.commit, commit);
  assert.match(reuse.baselineTag, /^v\d+\.\d+\.\d+$/);
  assert.match(reuse.installerTag, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(reuse.reused.map(item => item.platform).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
}
for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
  const manifest = JSON.parse(fs.readFileSync(byName.get(`nora-system-${platform}.json`)));
  assert.deepEqual(manifest.launcherCapabilities,shared.launcherCapabilities,'System launcherCapabilities differ from the shared release');
  assert.equal(releasePublicationTag(manifest),tag);
  assert.equal(manifest.version,shared.versions.tavern);
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.candidate, false);
  assert.equal(manifest.channel, tag.includes('-beta.') ? 'beta' : 'stable');
  assert.equal(`${manifest.platform}-${manifest.arch}`, platform);
  for (const entry of Object.values(manifest.files)) {
    const file = byName.get(entry.asset);
    assert.ok(file, `Missing system component: ${entry.asset}`);
    assert.equal(fs.statSync(file).size, entry.size);
    assert.equal(digest(file), entry.sha256);
  }
  const payloadJson = name => JSON.parse(fs.readFileSync(byName.get(manifest.files[name]?.asset)));
  const payload = payloadJson('release-manifest.json');
  assert.deepEqual(manifest.coreRelease,shared.coreRelease,'Platform core reference differs from product');
  if(shared.coreRelease)assertCoreReleasePayload(shared,fs.readFileSync(byName.get(manifest.files['release-manifest.json'].asset)),platform,manifest.files['release-manifest.json']);
  const appIdentity=shared.coreRelease?shared:payload;
  assert.deepEqual(appIdentity.launcherCapabilities,shared.launcherCapabilities,'Payload launcherCapabilities differ from the shared release');
  assert.equal(appIdentity.commit, commit);
  assert.equal(payload.candidate, false);
  assert.equal(releasePublicationTag(appIdentity),tag);
  assert.equal(payload.versions.tavern,shared.versions.tavern);
  assert.deepEqual(appIdentity.updateCompatibility,shared.updateCompatibility,'Platform compatibility declaration differs');
  assert.deepEqual(manifest.updateCompatibility,shared.updateCompatibility,'System compatibility declaration differs');
  if (shared.launcherBuildReuse) {
    const provenance = appIdentity.launcherBuildReuse;
    assert.equal(provenance?.schema, 1, 'Missing launcher build provenance');
    assert.match(provenance.baselineCommit, /^[a-f0-9]{40}$/);
    assert.match(provenance.baselineVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(provenance.baselineCommit, shared.launcherBuildReuse.baselineCommit);
    assert.equal(provenance.baselineVersion, shared.launcherBuildReuse.baselineVersion);
    for (const kind of ['archives', 'modules']) {
      for (const [name, checksum] of Object.entries(provenance[kind])) {
        assert.equal(appIdentity[kind][name]?.sha256, checksum, `Reused ${kind} changed: ${name}`);
      }
    }
  } else assert.ok(!appIdentity.launcherBuildReuse, 'Mixed full and reused platform builds');
  assert.equal(appIdentity.launcherVersion, shared.launcherVersion);
  assert.equal(manifest.launcherVersion, shared.launcherVersion);
  assert.equal(appIdentity.bootstrap?.minimumLauncherVersion, shared.bootstrap.minimumLauncherVersion);
  assert.equal(manifest.minimumLauncherVersion, shared.bootstrap.minimumLauncherVersion);
  for (const [name, fingerprint] of [['nora-hermes-runtime.json', 'runtimeSha256'], ['nora-tavern-dependencies.json', 'dependenciesSha256']]) {
    const component = payloadJson(name);
    assert.equal(`${component.platform}-${component.arch}`, platform);
    assert.equal(component.sha256, manifest.files[component.archive]?.sha256);
    if (reuse) assert.equal(component.sha256, reuse.reused.find(item => item.platform === platform)[fingerprint]);
    if (shared.launcherBuildReuse) assert.equal(component.sha256, appIdentity.launcherBuildReuse[fingerprint], 'Reused environment changed');
  }
  if (mode === 'full') {
  const report = JSON.parse(fs.readFileSync(byName.get(`Nora-Tavern-package-verification-${platform}.json`)));
  assert.equal(report.commit, commit);
  assert.equal(report.version,shared.versions.tavern);
  assert.equal(report.nativeIcon, true);
  assert.ok(report.instructions['ops/installer/templates/greeting.md']);
  const suffix = platform.replace('darwin', 'mac').replace('win32', 'win');
  assert.ok([...byName.keys()].some(name => name.startsWith('Nora-Tavern-') && name.endsWith(`${suffix}${platform.startsWith('darwin') ? '.dmg' : '-setup.exe'}`)), `Missing installer: ${platform}`);
  }
}
for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
  const item = JSON.parse(fs.readFileSync(byName.get(`nora-launcher-${platform}.json`)));
  assert.equal(item.schema, 'nora-launcher/v1');
  assert.equal(item.candidate, false);
  assert.equal(item.version, shared.launcherVersion);
  assert.match(item.commit, /^[a-f0-9]{40}$/);
  if (mode === 'full') assert.equal(item.commit, commit, 'Launcher commit differs from full release');
  else assert.deepEqual(Object.fromEntries(['commit', 'version', 'asset', 'size', 'sha256'].map(key => [key, item[key]])),
    reuse.reused.find(entry => entry.platform === platform)?.launcher, 'Launcher differs from approved reuse provenance');
  assert.equal(`${item.platform}-${item.arch}`, platform);
  assert.ok(item.asset.endsWith('-update.zip'));
  assert.equal(fs.statSync(byName.get(item.asset)).size, item.size);
  assert.equal(digest(byName.get(item.asset)), item.sha256);
}
assert.equal(shared.commit, commit);
assert.equal(shared.candidate, false);
assert.equal(releasePublicationTag(shared),tag);
for (const archive of Object.values(shared.archives)) assert.equal(digest(byName.get(archive.name)), archive.sha256);
for (const archive of Object.values(shared.modules)) assert.equal(digest(byName.get(archive.name)), archive.sha256);
// The build's sealed component list may include unpublished intermediate
// packages. Validate published entries without changing the sealed bytes.
// LAUNCHER-SHA256SUMS below is the separate final public asset index.
const checksumFile = byName.get('SHA256SUMS');
if (checksumFile) {
  for (const line of fs.readFileSync(checksumFile, 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, 'Invalid shared checksum entry');
    const file = byName.get(match[2]);
    if (!file) continue;
    assert.equal(digest(file), match[1]);
  }
}
fs.writeFileSync(path.join(root, 'LAUNCHER-SHA256SUMS'), [...byName].sort().map(([name, file]) => `${digest(file)}  ${name}\n`).join(''));
console.log(`Verified ${tag}: ${mode === 'full' ? 'three platform packages, greeting, icons and' : 'reused environments and'} complete system components and shared updater assets.`);
}
verifyRelease().catch(error => { console.error(error); process.exitCode = 1; });
