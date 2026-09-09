const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('../installer/desktop/node_modules/@electron/asar');
const { testBuild, prepareTestPayload } = require('../installer/desktop/test-build');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function only(items, label) {
  assert.equal(items.length, 1, `Expected one ${label}, found ${items.length}`);
  return items[0];
}
function files(directory, suffix) {
  return fs.readdirSync(directory).filter(name => name.endsWith(suffix)).map(name => path.join(directory, name));
}

async function main() {
  assert.ok(process.argv[2], 'Pass the packaged desktop dist directory');
  const dist = path.resolve(process.argv[2]);
  let resources, executable;
  if (process.platform === 'darwin') {
    const folder = only(fs.readdirSync(dist).filter(name => /^mac(?:-|$)/.test(name)), 'Mac output directory');
    const app = only(files(path.join(dist, folder), '.app'), 'Mac app');
    resources = path.join(app, 'Contents/Resources');
    executable = path.join(resources, 'icon.icns');
    const generated = only(files(path.join(dist, '.icon-icns'), '.icns'), 'generated Nora icon');
    assert.deepEqual(fs.readFileSync(executable), fs.readFileSync(generated), 'Mac app icon differs from generated Nora icon');
  } else {
    assert.equal(process.platform, 'win32');
    const folder = path.join(dist, 'win-unpacked');
    resources = path.join(folder, 'resources');
    executable = only(files(folder, '.exe'), 'Windows app executable');
    const pe = require('../installer/desktop/node_modules/pe-library');
    const { Data, Resource } = require('../installer/desktop/node_modules/resedit');
    const entries = pe.NtExecutableResource.from(pe.NtExecutable.from(fs.readFileSync(executable), { ignoreCert: true })).entries;
    const generated = only(files(path.join(dist, '.icon-ico'), '.ico'), 'generated Nora icon');
    const iconBytes = item => Buffer.from(item.isRaw() ? item.bin : item.generate());
    const expected = Data.IconFile.from(fs.readFileSync(generated)).icons.map(item => digest(iconBytes(item.data))).sort();
    assert.ok(expected.length > 0);
    const groups = Resource.IconGroupEntry.fromEntries(entries);
    assert.ok(groups.some(group => JSON.stringify(group.getIconItemsFromEntries(entries).map(item => digest(iconBytes(item))).sort()) === JSON.stringify(expected)),
      'Windows executable does not contain the generated Nora icon');
  }
  const source = path.resolve(__dirname, '../installer');
  const assetHashes = {};
  for (const name of ['nora-launcher-portrait.png', 'tavern-icon-dbf4ecbd54ec.png']) {
    const bytes = fs.readFileSync(path.join(resources, 'assets', name));
    assert.deepEqual(bytes, fs.readFileSync(path.join(source, 'assets', name)), `Packaged Nora image differs: ${name}`);
    assetHashes[name] = digest(bytes);
  }
  const html = fs.readFileSync(path.join(resources, 'launcher-conversation-prototype.html'), 'utf8');
  assert.ok(html.includes('src="assets/nora-launcher-portrait.png"'), 'UI does not reference the packaged Nora portrait');
  const metadata = JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'package.json'));
  const payload = path.join(resources, 'payload');
  const system = JSON.parse(fs.readFileSync(path.join(payload, 'nora-system.json')));
  if (system.candidate) await prepareTestPayload(payload, testBuild(metadata), metadata.version);
  const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'release-manifest.json')));
  const instructions = {};
  for (const relative of ['ops/skills/agents-tavern.md', 'ops/installer/templates/SOUL.md']) {
    instructions[relative] = digest(fs.readFileSync(path.resolve(__dirname, '../..', relative)));
    assert.equal(manifest.artifacts[relative], instructions[relative], `Packaged instruction hash differs: ${relative}`);
  }
  const report = { platform: process.platform, arch: process.arch, commit: system.commit, version: system.version,
    launcherVersion: metadata.version, assets: assetHashes, instructions, nativeIcon: true,
    iconContainerSha256: digest(fs.readFileSync(executable)) };
  fs.writeFileSync(path.join(dist, `Nora-Tavern-package-verification-${process.platform}-${process.arch}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: packaged Nora portrait, native icon, instruction hashes and candidate payload integrity');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
