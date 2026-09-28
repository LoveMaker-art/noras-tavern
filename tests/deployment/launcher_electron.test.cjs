const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { test } = require('node:test');
const { _electron } = require(process.env.NORA_PLAYWRIGHT || 'playwright');

test('sandboxed Electron loads the real bridge into a fresh isolated home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-electron-contract-'));
  const env = { ...process.env, NORA_TAVERN_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NORA_HERMES_HOME;
  delete env.NORA_TAVERN_INSTALL_ROOT;
  let app;
  try {
    app = await _electron.launch({ executablePath: process.env.NORA_ELECTRON || undefined,
      args: [path.resolve(__dirname, '../installer/desktop'), '--nora-test-hidden'], env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.getElementById('copy')?.textContent === '我是诺拉。欢迎来到酒馆。');
    const result = await page.evaluate(async () => {
      const api = window.NoraLauncherBridge;
      return { status: await api.status(), nodeVisible: typeof require !== 'undefined',
        methods: ['install', 'start', 'stop', 'pair', 'checkUpdate', 'saveAndTestModel'].every(name => typeof api[name] === 'function') };
    });
    assert.equal(result.nodeVisible, false);
    assert.equal(result.methods, true);
    assert.equal(result.status.installed, false);
    assert.equal(result.status.hermesInstalled, false);
    assert.equal(fs.realpathSync(result.status.noraHome), fs.realpathSync(home));
    const rejected = await page.evaluate(async () => {
      try { await window.NoraLauncherBridge.openExternal('file:///etc/passwd'); return false; } catch { return true; }
    });
    assert.equal(rejected, true);
  } finally {
    if (app) await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Electron custom-model UI tests a response and persists through real Hermes APIs', { skip: !process.env.NORA_TEST_HERMES }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-electron-model-'));
  const hermesHome = path.join(home, 'hermes');
  fs.mkdirSync(hermesHome);
  fs.symlinkSync(process.env.NORA_TEST_HERMES, path.join(hermesHome, 'hermes-agent'), 'dir');
  const runtime = path.join(home, 'tavern/apps/tavern-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'native-runtime.json'), '{}');
  fs.writeFileSync(path.join(runtime, 'native_lifecycle.py'), 'import json\nprint(json.dumps({"health":{"ok":False}}))\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'NORA_OK' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  const env = { ...process.env, NORA_TAVERN_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NORA_HERMES_HOME; delete env.NORA_TAVERN_INSTALL_ROOT;
  try {
    app = await _electron.launch({ executablePath: process.env.NORA_ELECTRON || undefined,
      args: [path.resolve(__dirname, '../installer/desktop'), '--nora-test-hidden'], env });
    const page = await app.firstWindow();
    await page.locator('#provider').selectOption('custom');
    await page.locator('#key').fill('local-test-only');
    await page.locator('#endpoint').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('#model').fill('contract-model');
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    await page.locator('#pairCode').waitFor();
    assert.equal(requests, 1);
    const status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.modelConfigured, true);
    assert.equal(status.modelName, 'contract-model');
    assert.equal(status.clawchatPaired, false);
    assert.equal(status.installer.setupCompleted, false);
    const marker = fs.readFileSync(path.join(home, 'installer/model.json'), 'utf8');
    assert.ok(!marker.includes('local-test-only'));
    assert.ok(!JSON.stringify(status).includes('local-test-only'));
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
