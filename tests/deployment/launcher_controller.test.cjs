const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { chromium } = require(process.env.NORA_PLAYWRIGHT || 'playwright');
const url = pathToFileURL(path.resolve(__dirname, '../installer/launcher-conversation-prototype.html')).href;

test('real controller waits for backend results through install, model, pairing, launch and stop', async () => {
  const browser = await chromium.launch({ executablePath: process.env.NORA_CHROMIUM || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 680 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.state = { noraHome: '/isolated/NoraTavern', installed: false, hermesInstalled: false,
        modelConfigured: false, clawchatPaired: false, clawchatConnected: false, gatewayRunning: false,
        running: false, port: 8799, url: 'http://127.0.0.1:8799', installer: { setupCompleted: false } };
      window.calls = [];
      const action = name => options => {
        window.calls.push(name);
        window.lastOptions = options;
        options.onEvent?.({ event: 'task', task: `backend-${name}` });
        return new Promise((resolve, reject) => { window.settle = (patch, error) => {
          Object.assign(window.state, patch);
          error ? reject(new Error(error)) : resolve({ ...window.state });
        }; });
      };
      window.NoraLauncherBridge = {
        status: async () => ({ ...window.state }), install: action('install'), start: action('start'), stop: action('stop'), pair: action('pair'),
        modelProviders: async () => ({ ok: true, providers: [{ id: 'custom', label: '自定义模型', custom: true }] }),
        saveAndTestModel: async payload => { window.calls.push('model'); window.state.modelConfigured = true; },
        openExternal: async url => { window.calls.push('open'); }, cancel: async () => ({ ok: true }),
        openClawChat: async () => {}, checkUpdate: async () => ({ available: false, latest: 'v1.0.0' }),
      };
    });
    await page.goto(url);
    await page.getByRole('button', { name: '安装酒馆', exact: true }).click();
    await page.waitForFunction(() => window.calls.includes('install'));
    assert.equal(await page.locator('#provider').count(), 0);
    assert.equal(await page.locator('#jobPercent').textContent(), '');
    await page.evaluate(() => window.settle({ installed: true, hermesInstalled: true }));
    await page.locator('#key').fill('test-only');
    await page.locator('#endpoint').fill('https://relay.example/v1');
    await page.locator('#model').fill('test-model');
    if (process.env.NORA_SCREENSHOT) await page.screenshot({ path: process.env.NORA_SCREENSHOT, animations: 'disabled' });
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    await page.locator('#pairCode').fill('test-code');
    await page.getByRole('button', { name: '连接并继续', exact: true }).click();
    await page.waitForFunction(() => window.calls.includes('pair'));
    await page.evaluate(() => window.settle({ clawchatPaired: true }));
    await page.waitForFunction(() => window.calls.includes('start'));
    assert.equal(await page.locator('#launchbar').isVisible(), false);
    await page.evaluate(() => window.settle({}, 'connection failed'));
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'start').length === 2);
    await page.evaluate(() => window.settle({ running: true, gatewayRunning: true, clawchatConnected: true, installer: { setupCompleted: true } }));
    await page.locator('#launch').click();
    await page.waitForFunction(() => window.calls.includes('open'));
    await page.getByRole('button', { name: '停止诺拉', exact: true }).click();
    await page.waitForFunction(() => window.calls.includes('stop'));
    assert.equal(await page.evaluate(() => window.lastOptions.service), 'nora');
    await page.evaluate(() => window.settle({ gatewayRunning: false, clawchatConnected: false }));
    await page.locator('[data-service="nora"][data-state="stopped"]').waitFor();
    assert.equal(await page.locator('[data-service="tavern"]').getAttribute('data-state'), 'running');
    await page.locator('#launch').click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'open').length === 2);
    assert.equal(await page.evaluate(() => window.state.gatewayRunning), false);
    await page.getByRole('button', { name: '停止酒馆', exact: true }).click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'stop').length === 2);
    assert.equal(await page.evaluate(() => window.lastOptions.service), 'tavern');
    await page.evaluate(() => window.settle({ running: false }));
    await page.locator('[data-service="tavern"][data-state="stopped"]').waitFor();
    await page.locator('#launch').click();
    await page.waitForFunction(() => window.calls.filter(c => c === 'start').length === 3);
    assert.equal(await page.evaluate(() => window.lastOptions.service), 'tavern');
    await page.evaluate(() => window.settle({ running: true }));
    await page.waitForFunction(() => window.calls.filter(c => c === 'open').length === 3);
    await page.locator('#moreButton').click();
    assert.equal(await page.locator('#more').isVisible(), true);
    assert.equal(await page.locator('.portrait img').getAttribute('draggable'), 'false');
    if (process.env.NORA_SCREENSHOT) await page.screenshot({ path: process.env.NORA_SCREENSHOT.replace('.png', '-daily.png'), animations: 'disabled' });
    assert.equal(await page.locator('#steps').isVisible(), false);
    assert.equal(await page.locator('#launchbar').isVisible(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.calls), ['install', 'model', 'pair', 'start', 'start', 'open', 'stop', 'open', 'stop', 'start', 'open']);
  } finally { await browser.close(); }
});
