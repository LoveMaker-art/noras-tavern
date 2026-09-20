const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('../installer/desktop/node_modules/@electron/asar');
const { verify } = require('./verify_launcher_update.cjs');

async function fixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-update-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'desktop');
  const application = path.join(root, 'application');
  const resources = path.join(application, platform === 'darwin' ? 'Contents/Resources' : 'resources');
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(root, 'payload'));
  const pkg = { name: 'launcher', main: 'main.js', version: '1.1.0', noraReleaseChannel: 'beta', build: {
    productName: 'Launcher', files: ['main.js'], extraResources: [{ from: 'replace-launcher.py', to: 'replace-launcher.py' },
      { from: '../payload', to: 'payload' }] } };
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(desktop, 'main.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(desktop, 'replace-launcher.py'), '# replacement');
  fs.writeFileSync(path.join(resources, 'replace-launcher.py'), '# replacement');
  const commit = 'a'.repeat(40);
  fs.writeFileSync(path.join(root, 'payload/release-manifest.json'), JSON.stringify({ commit, hermesRuntime: { arch: 'x64' } }));
  fs.writeFileSync(path.join(resources, 'launcher-update-info.json'), JSON.stringify({ schema: 1, version: '1.1.0', platform, arch: 'x64', commit }));
  const executable = path.join(application, platform === 'darwin' ? 'Contents/MacOS/Launcher' : 'Launcher.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'executable');
  await asar.createPackage(desktop, path.join(resources, 'app.asar'));
  return { desktop, resources, executable, run: () => verify(application, desktop, platform) };
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: lightweight contents match build inputs`, async t => {
    const f = await fixture(t, platform);
    assert.doesNotThrow(f.run);
  });
  for (const defect of ['payload', 'identity', 'resource', 'source', 'executable', 'channel']) {
    test(`${platform}: rejects ${defect} mismatch`, async t => {
      const f = await fixture(t, platform);
      if (defect === 'payload') fs.mkdirSync(path.join(f.resources, 'payload'));
      if (defect === 'identity') fs.writeFileSync(path.join(f.resources, 'launcher-update-info.json'), '{}');
      if (defect === 'resource') fs.unlinkSync(path.join(f.resources, 'replace-launcher.py'));
      if (defect === 'source') fs.writeFileSync(path.join(f.desktop, 'main.js'), 'changed');
      if (defect === 'executable') fs.unlinkSync(f.executable);
      if (defect === 'channel') {
        const file = path.join(f.desktop, 'package.json');
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), noraReleaseChannel: 'stable' }));
      }
      assert.throws(f.run);
    });
  }
}
