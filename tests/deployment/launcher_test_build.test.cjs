const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { testBuild, prepareTestPayload } = require('../installer/desktop/test-build');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('production metadata cannot enable candidate installs', async () => {
  assert.equal(testBuild({}), null);
  assert.throws(() => testBuild({ noraLocalTest: { schema: 1, buildId: '../escape' } }));
  await assert.rejects(prepareTestPayload('/unused', null, '0.2.0'), /明确标识/);
});

test('local candidate is hash pinned; changed content fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-test-build-'));
  try {
    const names = ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz',
      'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz', 'nora-hermes-runtime.json',
      'nora-tavern-dependencies.json', 'nora-tavern-first-install-bootstrap.py'];
    const files = {};
    for (const name of names) {
      fs.writeFileSync(path.join(root, name), 'fixture');
      files[name] = { size: 7, sha256: digest('fixture') };
    }
    const manifest = JSON.stringify({ schema: 'nora-system/v1', candidate: true, platform: process.platform,
      arch: process.arch, minimumLauncherVersion: '0.2.0', files });
    fs.writeFileSync(path.join(root, 'nora-system.json'), manifest);
    const build = testBuild({ noraLocalTest: { schema: 1, buildId: 'test-1', systemManifestSha256: digest(manifest) } });
    assert.equal(await prepareTestPayload(root, build, '0.2.0'), root);
    fs.writeFileSync(path.join(root, names[0]), 'changed');
    await assert.rejects(prepareTestPayload(root, build, '0.2.0'), /文件校验失败/);
    fs.appendFileSync(path.join(root, 'nora-system.json'), ' ');
    await assert.rejects(prepareTestPayload(root, build, '0.2.0'), /清单校验失败/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
