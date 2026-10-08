const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { test } = require('node:test');
const { _electron } = require(process.env.NORA_PLAYWRIGHT || 'playwright');

test('sandboxed Electron loads the real bridge and completes quit in a fresh isolated home', {timeout:45000}, async () => {
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
    if (app) {
      const exited = new Promise(resolve=>app.process().once('exit',resolve));
      await app.evaluate(({app})=>app.quit());
      await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('The isolated launcher did not finish managed quit')),10000))]);
      await app.close();
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Model UI acceptance requires a complete verified installation. Its real
// packaged APP workflow is recorded in README-nora-acceptance.md; an empty
// native-runtime descriptor cannot stand in for a healthy installation.
