const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const crypto = require('node:crypto');
const releases = require('../installer/desktop/releases');
const { parse } = require('../installer/desktop/node_modules/acorn');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
const fn = parse(source, { ecmaVersion: 'latest' }).body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'performSystemUpdate');
function harness(failure, running = true, gatewayRunning = true, version = '2.3.6', systemReady = true) {
  const calls = [];
  const before = { version, systemReady, setupCompleted: true, running, gatewayRunning };
  let updated = false;
  const home = path.resolve('/nora');
  const context = vm.createContext({
    path, hermesHome: () => path.join(home, 'hermes'), noraHome: () => home, installRoot: () => path.join(home, 'tavern'),
    fs: { readFileSync: () => JSON.stringify({ versions: { tavern: '2.3.7' } }) },
    releases: { compare: (a, b) => a === b ? 0 : a < b ? -1 : 1 },
    updatingSystem: false, sendBridgeEvent() {}, diagnostics: { error() {} },
    systemUpdate: { perform: () => { throw new Error('EBUSY: rename hermes'); } },
    stopForUpdate: async () => calls.push('stop'),
    runBridge: async (action, options) => {
      calls.push([action, options?.service]);
      if (action === 'update') { if (failure) throw failure; updated = true; }
      return { ...before, version: updated ? '2.3.7' : version, systemReady: updated || systemReady, updateVerified: updated };
    },
  });
  return { calls, context, run: vm.runInContext(`(${source.slice(fn.start, fn.end)})`, context) };
}
test('damaged current version can be repaired by the shared transaction without reinstalling', async () => {
  const h = harness(null, false, false, '2.3.7', false);
  const result = await h.run('/release', { runId: 'repair' }, {});
  assert.equal(result.systemReady, true);
  assert.ok(h.calls.some(c => c[0] === 'update'));
});
test('repair never downgrades an existing newer installation', async () => {
  const h = harness(null, false, false, '2.3.8', false);
  await assert.rejects(h.run('/release', { runId: 'repair' }, {}));
  assert.equal(h.calls.some(c => c[0] === 'update'), false);
});
test('ordinary update uses updater without moving the occupied Hermes directory', async () => {
  const h = harness();
  const result = await h.run('/release', { runId: 'test' }, {});
  assert.equal(result.version, '2.3.7');
  assert.equal(h.calls.filter(c => Array.isArray(c) && c[0] === 'update').length, 1);
  assert.equal(h.calls.some(c => c[0] === 'start' || c[0] === 'stop'), false);
  assert.equal(h.context.updatingSystem, false);
});
test('failed updater preserves its recovery result without a second out-of-transaction service operation', async () => {
  const error = new Error('updater failure; recovery=restored; backup=/test');
  const h = harness(error, true, false);
  await assert.rejects(h.run('/release', { runId: 'test' }, {}), e => e === error);
  assert.equal(h.calls.some(c => c[0] === 'start' || c[0] === 'stop'), false);
  assert.equal(h.context.updatingSystem, false);
});
test('update does not start services that were stopped before updating', async () => {
  const h = harness(null, false, false);
  await h.run('/release', { runId: 'test' }, {});
  assert.equal(h.calls.some(c => c[0] === 'start'), false);
});
test('uncertain rollback does not restart services', async () => {
  const h = harness(new Error('rollback failed'));
  await assert.rejects(h.run('/release', { runId: 'test' }, {}), /rollback failed/);
  assert.equal(h.calls.some(c => c[0] === 'start'), false);
});

test('component download uses shared updater plan, with no Hermes or platform bundle request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-component-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = x => crypto.createHash('sha256').update(x).digest('hex');
  const manifest = { schema: 'tavern-release/v2', commit: 'a'.repeat(40), versions: { tavern: '2.3.7' },
    bootstrap: { sha256: sha('updater'), managedComponents: 1 } };
  const files = { 'release-manifest.json': JSON.stringify(manifest), 'tavern-updater-bootstrap.py': 'updater',
    'nora-tavern-module-updater.tar.gz': 'changed-module' };
  files.SHA256SUMS = Object.entries(files).map(([name, body]) => `${sha(body)}  ${name}`).join('\n');
  const base = 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.3.7/';
  const release = { tag_name: 'v2.3.7', assets: Object.keys(files).map(name => ({ name, browser_download_url: base + name })) };
  const requests = [];
  const options = { cacheRoot: root, launcherVersion: '1.0.0',
    fetcher: async url => {
      requests.push(url);
      if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(release));
      assert.ok(url.startsWith(base));
      const name = url.slice(base.length);
      assert.ok(name in files, `Unexpected full package request: ${name}`);
      return new Response(files[name]);
    },
    plan: async directory => {
      assert.equal(fs.readFileSync(path.join(directory, 'tavern-updater-bootstrap.py'), 'utf8'), 'updater');
      return { version: '2.3.7', mode: 'incremental', archives: [{ name: 'nora-tavern-module-updater.tar.gz', sha256: sha('changed-module') }] };
    } };
  const output = await releases.prepareUpdate(options);
  assert.equal(fs.readFileSync(path.join(output, 'nora-tavern-module-updater.tar.gz'), 'utf8'), 'changed-module');
  requests.length = 0;
  await releases.prepareUpdate(options);
  assert.equal(requests.some(url => url.endsWith('.tar.gz')), false);
  await assert.rejects(releases.prepareUpdate({ ...options, plan: async () => ({ error: 'wrong installation path' }) }), /wrong installation path/);
  const info = await releases.check({ ...options, installRoot: root });
  assert.equal(info.updateSupported, true);
});
