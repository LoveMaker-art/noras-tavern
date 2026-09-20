const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createLocalRelease } = require('../installer/desktop/local-release');
const releases = require('../installer/desktop/releases');

test('local acceptance uses production check, plan and verified component download', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-local-release-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const manifest = { schema: 'tavern-release/v2', commit: 'a'.repeat(40), versions: { tavern: '2.3.8' },
    bootstrap: { managedComponents: 1, sha256: sha('bootstrap') } };
  const files = { 'release-manifest.json': JSON.stringify(manifest),
    'tavern-updater-bootstrap.py': 'bootstrap', 'nora-tavern-module-updater.tar.gz': 'module' };
  files.SHA256SUMS = Object.entries(files).map(([name, data]) => `${sha(data)}  ${name}`).join('\n');
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(root, name), data);
  const fetcher = createLocalRelease(root);
  const installRoot = path.join(root, 'installed');
  fs.mkdirSync(path.join(installRoot, 'tavern-updates'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'tavern-updates/installed.json'), JSON.stringify({ version: '2.3.6' }));
  assert.equal((await releases.check({ installRoot, launcherVersion: '1.0.1', fetcher })).state, 'available');
  const options = { cacheRoot: path.join(root, 'cache'), launcherVersion: '1.0.1', fetcher,
    plan: async () => ({ version: '2.3.8', archives: [{ name: 'nora-tavern-module-updater.tar.gz', sha256: sha('module') }] }) };
  const prepared = await releases.prepareUpdate(options);
  assert.equal(fs.readFileSync(path.join(prepared, 'nora-tavern-module-updater.tar.gz'), 'utf8'), 'module');
  await assert.rejects(fetcher('https://example.com/anything'), /unexpected URL/);
  fs.writeFileSync(path.join(root, 'nora-tavern-module-updater.tar.gz'), 'corrupt');
  await assert.rejects(releases.prepareUpdate({ ...options, cacheRoot: path.join(root, 'other-cache') }), /校验失败/);
});
