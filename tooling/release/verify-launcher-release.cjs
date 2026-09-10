const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

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
let reuse;
if (mode === 'components') {
  reuse = JSON.parse(fs.readFileSync(byName.get('component-release.json')));
  assert.equal(reuse.schema, 'nora-component-release/v1');
  assert.equal(reuse.version, tag.slice(1));
  assert.equal(reuse.commit, commit);
  assert.match(reuse.baselineTag, /^v\d+\.\d+\.\d+$/);
  assert.match(reuse.installerTag, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(reuse.reused.map(item => item.platform).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
}
for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
  const manifest = JSON.parse(fs.readFileSync(byName.get(`nora-system-${platform}.json`)));
  assert.equal(manifest.version, tag.slice(1));
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
  assert.equal(payload.commit, commit);
  assert.equal(payload.candidate, false);
  assert.equal(payload.versions.tavern, tag.slice(1));
  for (const [name, fingerprint] of [['nora-hermes-runtime.json', 'runtimeSha256'], ['nora-tavern-dependencies.json', 'dependenciesSha256']]) {
    const component = payloadJson(name);
    assert.equal(`${component.platform}-${component.arch}`, platform);
    assert.equal(component.sha256, manifest.files[component.archive]?.sha256);
    if (reuse) assert.equal(component.sha256, reuse.reused.find(item => item.platform === platform)[fingerprint]);
  }
  if (mode === 'full') {
  const report = JSON.parse(fs.readFileSync(byName.get(`Nora-Tavern-package-verification-${platform}.json`)));
  assert.equal(report.commit, commit);
  assert.equal(report.version, tag.slice(1));
  assert.equal(report.nativeIcon, true);
  assert.ok(report.instructions['ops/installer/templates/greeting.md']);
  const suffix = platform.replace('darwin', 'mac').replace('win32', 'win');
  assert.ok([...byName.keys()].some(name => name.startsWith('Nora-Tavern-') && name.endsWith(`${suffix}${platform.startsWith('darwin') ? '.dmg' : '-setup.exe'}`)), `Missing installer: ${platform}`);
  }
}
const shared = JSON.parse(fs.readFileSync(byName.get('release-manifest.json')));
assert.equal(shared.commit, commit);
assert.equal(shared.candidate, false);
assert.equal(shared.versions.tavern, tag.slice(1));
for (const archive of Object.values(shared.archives)) assert.equal(digest(byName.get(archive.name)), archive.sha256);
for (const archive of Object.values(shared.modules)) assert.equal(digest(byName.get(archive.name)), archive.sha256);
// The build also seals intermediate packages which are not public downloads.
const checksumFile = byName.get('SHA256SUMS');
if (checksumFile) {
  const publicChecksums = fs.readFileSync(checksumFile, 'utf8').trim().split('\n').filter(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, 'Invalid shared checksum entry');
    const file = byName.get(match[2]);
    if (!file) return false;
    assert.equal(digest(file), match[1]);
    return true;
  });
  fs.writeFileSync(checksumFile, publicChecksums.join('\n') + '\n');
}
fs.writeFileSync(path.join(root, 'LAUNCHER-SHA256SUMS'), [...byName].sort().map(([name, file]) => `${digest(file)}  ${name}\n`).join(''));
console.log(`Verified ${tag}: ${mode === 'full' ? 'three platform packages, greeting, icons and' : 'reused environments and'} complete system components and shared updater assets.`);
