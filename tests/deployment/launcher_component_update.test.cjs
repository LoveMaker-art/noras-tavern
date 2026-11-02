const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const releases = require('../installer/desktop/releases');
const { sourceCandidates } = require('../installer/desktop/release-sources');

// Core execution is owned by the independent updater. APP-only desktop dispatch
// and handoff acceptance are exercised in launcher_app_only_update.test.cjs.
test('component download uses shared updater plan, with no Hermes or platform bundle request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = x => crypto.createHash('sha256').update(x).digest('hex');
  const manifest = { schema: 'tavern-release/v2', commit: 'a'.repeat(40), versions: { tavern: '2.3.7' },
    launcherCapabilities:{operationSchema:'nora-operation/1',executorProtocol:'nora-operation-executor/1',telemetrySchema:3,faultSchema:2},
    bootstrap: { sha256: sha('updater'), managedComponents: 1 } };
  const files = { 'release-manifest.json': JSON.stringify(manifest), 'tavern-updater-bootstrap.py': 'updater',
    'nora-tavern-module-updater.tar.gz': 'changed-module' };
  files.SHA256SUMS = Object.entries(files).map(([name, body]) => `${sha(body)}  ${name}`).join('\n');
  const base = 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.3.7/';
  const release = { tag_name: 'v2.3.7', assets: Object.keys(files).map(name => ({ name, browser_download_url: base + name })) };
  const catalogueUrls = new Set(sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest')
    .map(source => source.url));
  const assetUrls = new Map(release.assets.flatMap(asset => sourceCandidates(asset.browser_download_url)
    .map(source => [source.url, asset.name])));
  const requests = [];
  const options = { cacheRoot: root, launcherVersion: '1.0.0',
    fetcher: async url => {
      requests.push(url);
      let body;
      if (catalogueUrls.has(url)) body = JSON.stringify(release);
      else {
        const name = assetUrls.get(url);
        assert.ok(name && Object.hasOwn(files, name), `Unexpected full package or untrusted source request: ${url}`);
        body = files[name];
      }
      const response = new Response(body);
      Object.defineProperty(response, 'url', { value: url });
      return response;
    },
    plan: async directory => {
      assert.equal(fs.readFileSync(path.join(directory, 'tavern-updater-bootstrap.py'), 'utf8'), 'updater');
      return { version: '2.3.7', mode: 'incremental', archives: [{ name: 'nora-tavern-module-updater.tar.gz', sha256: sha('changed-module') }] };
    } };
  const output = await releases.prepareUpdate(options);
  assert.equal(requests[0], sourceCandidates('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest')[0].url);
  assert.equal(fs.readFileSync(path.join(output, 'nora-tavern-module-updater.tar.gz'), 'utf8'), 'changed-module');
  requests.length = 0;
  await releases.prepareUpdate(options);
  assert.equal(requests.some(url => url.endsWith('.tar.gz')), false);
  await assert.rejects(releases.prepareUpdate({ ...options, plan: async () => ({ error: 'wrong installation path' }) }), /wrong installation path/);
  const info = await releases.check({ ...options, installRoot: root });
  assert.equal(info.updateSupported, true);
});
