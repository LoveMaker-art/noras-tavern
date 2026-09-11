const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
let callback;
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'CallExpression' && node.callee.name === 'handle' && node.arguments[0]?.value === 'nora:model-save-test') callback = node.arguments[1];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') visit(value);
  }
}
visit(parse(source, { ecmaVersion: 'latest' }));

for (const ok of [true, false]) test(`model completion follows shared recheck: ${ok ? 'success' : 'failure'}`, async () => {
  const order = [], events = [];
  const context = vm.createContext({
    diagnostics: { addSecret() {}, error() {}, clean: value => value },
    activeRun: false, modelBusy: false, statusRequest: Promise.resolve(),
    requireProvider: () => ({ id: 'custom', keyEnv: '' }), normalizeCustomBaseUrl: value => value,
    recordEvent: event => { events.push(event); order.push(event.state); },
    runModelConfigHelper: async value => { order.push(value.action); return { ok: true, provider: 'custom:local', model: 'fixture-model' }; },
    testCustomModel: async () => { order.push('test'); },
    readInstallerState: () => ({ setupCompleted: false, port: 18999 }),
    fs: { rmSync() {} }, path, installerDirectory: () => '/fixture/installer', noraHome: () => '/fixture', DEFAULT_PORT: 8799,
    writeVerifiedModel: () => { order.push('save-marker'); },
    runBridge: async command => { assert.equal(command, 'verify-model'); order.push('recheck'); return { ok, error: '模型配置复核未通过：接口地址与验证记录不一致' }; },
  });
  const handler = vm.runInContext(`(${source.slice(callback.start, callback.end)})`, context);
  const result = handler({}, { provider: 'custom', key: 'fixture-only', model: 'fixture-model', baseUrl: 'http://127.0.0.1:8080/v1' });
  if (ok) { assert.equal((await result).ok, true); assert.ok(order.indexOf('recheck') < order.indexOf('done')); }
  else { await assert.rejects(result, /复核未通过/); assert.equal(events.some(event => event.state === 'done'), false); }
  assert.ok(order.indexOf('sync-tavern') < order.indexOf('recheck'));
  assert.equal(context.modelBusy, false);
  assert.ok(!JSON.stringify(events).includes('fixture-only'));
});
