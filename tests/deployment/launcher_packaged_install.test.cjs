const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { _electron } = require(process.env.NORA_PLAYWRIGHT || 'playwright');

test('packaged candidate really installs through the visible UI and survives reopen', { timeout: 240000 }, async () => {
  const executablePath = process.env.NORA_PACKAGED_APP;
  const buildId = process.env.NORA_TEST_BUILD_ID;
  assert.ok(executablePath && /^[a-zA-Z0-9-]+$/.test(buildId || ''), 'Pass the packaged binary and build ID');
  const home = path.join(os.homedir(), 'Library/NoraTavern-Tests', `launcher-${buildId}`);
  assert.equal(fs.existsSync(home), false, 'Never clean or reuse an existing user test home');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let stopped = false;
  const launch = async () => {
    app = await _electron.launch({ executablePath, args: [], env, timeout: 60000 });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => Boolean(window.NoraLauncherBridge), { timeout: 30000 });
    return page;
  };
  try {
    let page = await launch();
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    let status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.noraHome, home);
    assert.equal(status.installed, false);
    assert.equal(status.port, 18999);
    console.log('Initial UI:', (await page.locator('body').innerText()).slice(-2000));
    await page.evaluate(() => {
      window.sawIndependentNoraStage = false;
      new MutationObserver(() => {
        const steps = document.querySelectorAll('#steps .step');
        if (steps[0]?.classList.contains('done') && steps[1]?.classList.contains('active') && !steps[1]?.classList.contains('done')) {
          window.sawIndependentNoraStage = true;
        }
      }).observe(document.getElementById('steps'), { childList: true, subtree: true, attributes: true });
    });
    await page.getByRole('button', { name: '安装酒馆', exact: true }).click();
    console.log('Clicked install in the packaged app');
    await page.locator('#provider').waitFor({ state: 'visible', timeout: 180000 });
    status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.systemReady, true, JSON.stringify(status.systemProblems));
    assert.equal(status.noraInstalled, true);
    assert.equal(await page.evaluate(() => window.sawIndependentNoraStage), true, 'The real UI must show Nora done while Tavern installs');
    assert.equal(status.setupCompleted, false);
    assert.equal(status.modelConfigured, false);
    assert.equal(status.clawchatPaired, false);
    const system = JSON.parse(fs.readFileSync(path.join(home, 'tavern/tavern-updates/nora-system.json')));
    assert.equal(system.proof.managedConfiguration, true);
    assert.equal(system.proof.mcpInstanceRead, true);
    console.log('Real installation reached model configuration; Nora integrity and MCP passed');
    if (process.env.NORA_SCREENSHOT) await page.screenshot({ path: process.env.NORA_SCREENSHOT });
    await page.evaluate(() => window.NoraLauncherBridge.stop());
    stopped = true;
    await app.close(); app = null;
    page = await launch();
    await page.locator('#provider').waitFor({ state: 'visible', timeout: 30000 });
    status = await page.evaluate(() => window.NoraLauncherBridge.status());
    assert.equal(status.systemReady, true);
    assert.equal(status.setupCompleted, false);
    assert.equal(status.running, false);
    console.log('Reopen correctly resumes model configuration, without reinstalling');
  } finally {
    if (app) {
      try {
        const page = await app.firstWindow();
        if (fs.existsSync(path.join(home, 'hermes/hermes-agent/venv'))) {
          await page.evaluate(() => window.NoraLauncherBridge.stop());
        }
        stopped = true;
      } catch (error) {
        console.error('Cleanup could not stop the test instance:', error.message);
      } finally { await app.close(); }
    }
    if (stopped) fs.rmSync(home, { recursive: true, force: true });
  }
});
