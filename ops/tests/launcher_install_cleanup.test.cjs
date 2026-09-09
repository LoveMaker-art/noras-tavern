const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanupInstallTemps } = require('../installer/desktop/install-cleanup');

test('retry removes only known staging directories and preserves runtime, credentials, data and backups', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cleanup-'));
  try {
    const stale = ['cache/tmp/nora-first-install-ab82unep', 'cache/tmp/nora-tavern-bootstrap.nnld20is',
      '.tmp/i-ab82unep', '.runtime-aB1234'];
    const keep = ['hermes/.env', 'hermes/SOUL.md', 'hermes/hermes-agent/.hermes-bootstrap-complete',
      'tavern/tavern-state/chat.json', 'installer/backups/hermes-partial-123/data',
      'cache/releases/current/data', 'cache/tmp/user-folder/file', '.tmp/i-not-an-installer/file'];
    for (const relative of stale) {
      const file = path.join(home, relative, 'deep', 'x'.repeat(100), 'y'.repeat(100), 'workerHelpers.worker.js');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'stale fixture');
    }
    for (const relative of keep) {
      const file = path.join(home, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'preserved fixture');
    }
    assert.deepEqual(cleanupInstallTemps(home).map(file => file.split(path.sep).join('/')).sort(), stale.sort());
    for (const relative of keep) assert.equal(fs.readFileSync(path.join(home, relative), 'utf8'), 'preserved fixture', relative);
    assert.deepEqual(cleanupInstallTemps(home), [], 'retry cleanup is idempotent');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cleanup never follows staging symlinks or redirected cache directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cleanup-link-'));
  try {
    const home = path.join(root, 'home'), outside = path.join(root, 'outside');
    fs.mkdirSync(home); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'preserved');
    fs.symlinkSync(outside, path.join(home, '.runtime-abc123'), 'junction');
    assert.deepEqual(cleanupInstallTemps(home), []);
    fs.symlinkSync(outside, path.join(home, 'cache'), 'junction');
    fs.mkdirSync(path.join(outside, 'tmp'));
    assert.throws(() => cleanupInstallTemps(home), /越过隔离目录/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'preserved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup is packaged and runs after payload validation but before starting the installer', () => {
  const desktop = path.resolve(__dirname, '../installer/desktop');
  assert.ok(require(path.join(desktop, 'package.json')).build.files.includes('install-cleanup.js'));
  const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  const run = main.slice(main.indexOf("handle('nora:run'"));
  assert.ok(run.indexOf('prepareTestPayload(') < run.indexOf('cleanupInstallTemps(noraHome())'));
  assert.ok(run.indexOf('cleanupInstallTemps(noraHome())') < run.indexOf('await ensureHermesFromNode('));
  assert.ok(main.includes('app.requestSingleInstanceLock()'));
});
