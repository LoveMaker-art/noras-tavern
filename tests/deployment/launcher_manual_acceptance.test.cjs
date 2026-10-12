// Helper lifecycle contracts only; this does not exercise a packaged Mac APP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHelper } = require('./uninstall-mac-smoke.cjs');

function fixture(t, body) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nora-helper-lifecycle-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'worker.cjs'), file = path.join(root, 'plan.json');
  fs.writeFileSync(modulePath, `exports.worker = file => { require('node:fs').writeFileSync(file, String(process.pid)); ${body} };\n`);
  return { root, modulePath, file };
}

function assertClosed(file) {
  const pid = Number(fs.readFileSync(file, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('manual helper succeeds only after its actual process closes', async t => {
  const f = fixture(t, 'setTimeout(() => {}, 30);');
  await runHelper(process.execPath, f.modulePath, f.file);
  assertClosed(f.file);
});

test('failed manual helper has closed before fixture cleanup begins', async t => {
  const f = fixture(t, 'process.exitCode = 7;');
  await assert.rejects(runHelper(process.execPath, f.modulePath, f.file));
  assertClosed(f.file);
});

test('timed out manual helper kills only its owned child and waits for close', async t => {
  const f = fixture(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(runHelper(process.execPath, f.modulePath, f.file, { timeout: 1000 }), /timed out/);
  assertClosed(f.file);
});

test('a missing manual executable rejects without leaving a live helper', async t => {
  const f = fixture(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(runHelper(path.join(f.root, 'missing-node'), f.modulePath, f.file), { code: 'ENOENT' });
  assert.equal(fs.existsSync(f.file), false);
});
