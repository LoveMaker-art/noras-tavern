const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('../installer/desktop/node_modules/acorn');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
let selection;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'IfStatement' && source.slice(node.test.start, node.test.end) === "['install', 'update'].includes(payload.action)") selection = node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') walk(value);
  }
}
walk(ast);

test('actual install handler selects bundled bytes without online preparation, updates remain online', async () => {
  assert.ok(selection);
  for (const [action, local, expected] of [['install', false, 'bundled'], ['install', true, 'candidate'], ['update', false, 'online']]) {
    const calls = [];
    const context = vm.createContext({
      payload: { action }, LOCAL_TEST: local, CHANNEL: 'stable', AbortController,
      releaseAbort: null, selectedPayload: null, cancelled: false,
      app: { getVersion: () => '1.0.0' }, path,
      noraHome: () => '/home', payloadDirectory: () => '/payload',
      event: { sender: {} }, sendBridgeEvent() {},
      releaseNetwork: { fetch() { throw new Error('network unavailable'); } },
      updateFetch() { throw new Error('network unavailable'); },
      releases: {
        prepareBundled: async () => { calls.push('bundled'); return '/payload'; },
        prepareUpdate: async () => { calls.push('online'); return '/download'; },
      },
      prepareTestPayload: async () => { calls.push('candidate'); return '/payload'; },
      diagnostics: { write() {} }, cleanupInstallTemps: () => [],
      ensureHermesFromNode: async (_sender, _run, root) => calls.push(root),
    });
    await vm.runInContext(`(async () => { ${source.slice(selection.start, selection.end)} })()`, context);
    assert.deepEqual(calls, action === 'install' ? [expected, '/payload'] : [expected]);
    assert.equal(context.releaseAbort, null);
  }
});

test('automatic version check waits for completed setup and network failure remains nonblocking', async () => {
  const ui = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
  const start = ui.indexOf('  async function checkVersionsInBackground()');
  const end = ui.indexOf('\n  document.querySelectorAll', start);
  assert.ok(start >= 0 && end > start);
  let installed = false, requests = 0;
  const context = vm.createContext({
    complete: () => installed, autoVersionChecked: false, versionChecking: false,
    busy: false, snapshot: {}, versionInfo: null,
    api: { checkUpdate: async () => { requests++; throw new Error('offline'); } },
    textError: error => error.message, showVersionNotice() {},
  });
  const check = vm.runInContext(`(${ui.slice(start, end).trim()})`, context);
  await check();
  assert.equal(requests, 0);
  installed = true;
  await check();
  assert.equal(requests, 1);
  assert.equal(context.versionInfo.state, 'unavailable');
  assert.equal(context.busy, false);
  await check();
  assert.equal(requests, 1);
});
