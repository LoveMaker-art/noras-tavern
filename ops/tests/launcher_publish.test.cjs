const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/verify-launcher-release.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-publish-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commit = 'a'.repeat(40);
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const [system, arch] = platform.split('-');
    const asset = `${platform}-payload.json`;
    write(asset, {});
    write(`nora-system-${platform}.json`, {
      version: '2.2.11', commit, candidate: false, channel: 'stable', platform: system, arch,
      files: { payload: { asset, size: 2, sha256: crypto.createHash('sha256').update('{}').digest('hex') } },
    });
    write(`Nora-Tavern-package-verification-${platform}.json`, {
      version: '2.2.11', commit, nativeIcon: true, instructions: { 'ops/installer/templates/greeting.md': 'verified' },
    });
    write(`Nora-Tavern-Launcher-0.3.2-${system === 'darwin' ? 'mac' : 'win'}-${arch}${system === 'darwin' ? '.dmg' : '-setup.exe'}`, {});
  }
  write('release-manifest.json', { version: '2.2.11', versions: { tavern: '2.2.11' }, commit, candidate: false, archives: {}, modules: {} });
  return { root, run: () => spawnSync(process.execPath, [script, root, 'v2.2.11', commit], { encoding: 'utf8' }) };
}
test('complete stable release passes and produces asset checksums', t => {
  const { root, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'LAUNCHER-SHA256SUMS'), 'utf8'), /win-x64-setup.exe/);
});
test('missing Windows installer prevents publication', t => {
  const { root, run } = fixture(t);
  fs.unlinkSync(path.join(root, 'Nora-Tavern-Launcher-0.3.2-win-x64-setup.exe'));
  assert.notEqual(run().status, 0);
});
test('corrupted component prevents publication', t => {
  const { root, run } = fixture(t);
  fs.writeFileSync(path.join(root, 'darwin-arm64-payload.json'), 'corrupt');
  assert.notEqual(run().status, 0);
});
test('mixed commits prevent publication', t => {
  const { root, run } = fixture(t);
  const file = path.join(root, 'nora-system-win32-x64.json');
  const value = JSON.parse(fs.readFileSync(file));
  value.commit = 'b'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(value));
  assert.notEqual(run().status, 0);
});
