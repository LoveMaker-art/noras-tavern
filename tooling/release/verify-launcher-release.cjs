const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const [root, tag, commit] = process.argv.slice(2);
assert.ok(root && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag) && /^[a-f0-9]{40}$/.test(commit));
const files = fs.readdirSync(root, { recursive: true }).filter(name => fs.statSync(path.join(root, name)).isFile());
const byName = new Map();
for (const name of files) {
  const base = path.basename(name);
  if (base.endsWith('.blockmap') || /^latest.*\.yml$/.test(base)) continue;
  assert.ok(!byName.has(base), `Duplicate release asset: ${base}`);
  byName.set(base, path.join(root, name));
}
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  const report = JSON.parse(fs.readFileSync(byName.get(`Nora-Tavern-package-verification-${platform}.json`)));
  assert.equal(report.commit, commit);
  assert.equal(report.version, tag.slice(1));
  assert.equal(report.nativeIcon, true);
  assert.ok(report.instructions['ops/installer/templates/greeting.md']);
  const suffix = platform.replace('darwin', 'mac').replace('win32', 'win');
  assert.ok([...byName.keys()].some(name => name.startsWith('Nora-Tavern-') && name.endsWith(`${suffix}${platform.startsWith('darwin') ? '.dmg' : '-setup.exe'}`)), `Missing installer: ${platform}`);
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
console.log(`Verified ${tag}: three platform packages, system components, greeting, icons and shared updater assets.`);
