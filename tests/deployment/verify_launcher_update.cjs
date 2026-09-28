const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('../installer/desktop/node_modules/@electron/asar');

function verify(application, desktop, platform) {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
  const release = JSON.parse(fs.readFileSync(path.join(desktop, '../payload/release-manifest.json')));
  const resources = path.join(application, platform === 'darwin' ? 'Contents/Resources' : 'resources');
  assert.equal(fs.existsSync(path.join(resources, 'payload')), false, 'Update must not include payload');
  const identity = JSON.parse(fs.readFileSync(path.join(resources, 'launcher-update-info.json')));
  assert.deepEqual(identity, { schema: 1, version: pkg.version, platform,
    arch: release.hermesRuntime.arch, commit: release.commit });
  const archive = path.join(resources, 'app.asar');
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
  for (const key of ['version', 'name', 'main', 'noraReleaseChannel', 'noraLocalTest']) {
    assert.deepEqual(metadata[key], pkg[key], `Packaged metadata differs: ${key}`);
  }
  for (const name of pkg.build.files) {
    assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(path.join(desktop, name)),
      `Packaged source differs: ${name}`);
  }
  function compare(source, target) {
    if (fs.statSync(source).isDirectory()) {
      for (const name of fs.readdirSync(source)) compare(path.join(source, name), path.join(target, name));
    } else assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source), `Packaged resource differs: ${target}`);
  }
  for (const entry of pkg.build.extraResources.filter(item => item.to !== 'payload')) {
    compare(path.resolve(desktop, entry.from), path.join(resources, entry.to));
  }
  const executable = platform === 'darwin'
    ? path.join(application, 'Contents/MacOS', pkg.build.productName)
    : path.join(application, `${pkg.build.productName}.exe`);
  assert.ok(fs.statSync(executable).isFile(), 'Missing application executable');
}

if (require.main === module) verify(...process.argv.slice(2));
module.exports = { verify };
