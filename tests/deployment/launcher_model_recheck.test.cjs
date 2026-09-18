const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { modelCredential } = require('../installer/desktop/model-config');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
const nodes = {};
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') nodes[node.id.name] = node;
  if (node.type === 'CallExpression' && node.callee.name === 'handle') nodes[node.arguments[0]?.value] = node.arguments[1];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') visit(value);
  }
}
visit(parse(source, { ecmaVersion: 'latest' }));

function fixture({ setupCompleted = false, running = true, syncFails = false, recheck = true, marker = null } = {}) {
  const order = [], events = [];
  const context = vm.createContext({
    diagnostics: { addSecret() {}, error() {}, clean: value => value }, modelCredential,
    activeRun: false, modelBusy: false, statusRequest: Promise.resolve(),
    requireProvider: () => ({ id: 'custom', keyEnv: '', custom: true }), normalizeCustomBaseUrl: value => value,
    recordEvent: event => { events.push(event); order.push(event.state); },
    runModelConfigHelper: async value => {
      order.push(value.action);
      if (value.action === 'sync-saved-tavern' && syncFails) throw new Error('fixture sync failure');
      return { ok: true, provider: 'custom:local', model: 'fixture-model', baseUrl: 'http://127.0.0.1:8080/v1' };
    },
    testCustomModel: async () => { order.push('test'); },
    readInstallerState: () => ({ setupCompleted, port: 18999 }),
    noraHome: () => '/fixture', DEFAULT_PORT: 8799,
    readVerifiedModel: () => marker,
    writeVerifiedModel: (_home, value) => { marker = value; order.push('save-marker'); },
    runBridge: async (command, options) => {
      order.push(command);
      if (command === 'start') { assert.equal(options.service, 'tavern'); return { running }; }
      assert.equal(command, 'verify-model'); return { ok: recheck, error: '模型配置复核未通过' };
    },
  });
  const load = name => vm.runInContext(`(${source.slice(nodes[name].start, nodes[name].end)})`, context);
  context.finishModelSetup = load('finishModelSetup');
  return { context, order, events, marker: () => marker, save: load('nora:model-save-test'), resume: load('nora:model-resume') };
}
const input = { provider: 'custom', key: 'fixture-only', model: 'fixture-model', baseUrl: 'http://127.0.0.1:8080/v1' };

test('model validation, saved checkpoint, Tavern readiness, sync and recheck occur in order', async () => {
  const f = fixture();
  assert.equal((await f.save({}, input)).ok, true);
  for (const [a, b] of [['test', 'save'], ['save', 'save-marker'], ['start', 'sync-saved-tavern'], ['sync-saved-tavern', 'verify-model'], ['verify-model', 'done']]) {
    assert.ok(f.order.indexOf(a) < f.order.indexOf(b), `${a} before ${b}`);
  }
  assert.equal(f.marker().tavernSyncPending, false);
  assert.equal(f.context.modelBusy, false);
  assert.ok(!JSON.stringify(f.events).includes('fixture-only'));
});

test('failed sync survives restart and resumes without credentials or another model request', async () => {
  const first = fixture({ syncFails: true });
  await assert.rejects(first.save({}, input), /模型验证已通过.*同步未完成/);
  assert.equal(first.marker().tavernSyncPending, true);
  assert.equal(first.events.some(e => e.state === 'done'), false);
  const restarted = fixture({ marker: first.marker() });
  await restarted.resume();
  assert.ok(!restarted.order.includes('test'));
  assert.ok(!restarted.order.includes('save'));
  assert.equal(restarted.marker().tavernSyncPending, false);
});

test('unready Tavern never receives a sync request', async () => {
  const f = fixture({ running: false });
  await assert.rejects(f.save({}, input), /接口尚未就绪/);
  assert.ok(!f.order.includes('sync-saved-tavern'));
});

test('model recheck failure is not success and releases busy state', async () => {
  const f = fixture({ recheck: false });
  await assert.rejects(f.save({}, input), /复核未通过/);
  assert.equal(f.events.some(e => e.state === 'done'), false);
  assert.equal(f.context.modelBusy, false);
});

test('changing Nora model after setup does not overwrite the Tavern selection', async () => {
  const f = fixture({ setupCompleted: true });
  await f.save({}, input);
  assert.ok(!f.order.includes('start'));
  assert.ok(!f.order.includes('sync-saved-tavern'));
});
