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
  if (node.type === 'IfStatement' && source.slice(node.test.start, node.test.end) === "payload.action==='install'||isUpdate") selection = node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') walk(value);
  }
}
walk(ast);

test('GUI telemetry distinguishes explicit recovery from a failed update with automatic rollback',()=>{
  const node=ast.body.find(value=>value.type==='FunctionDeclaration'&&value.id.name==='finishOperationTelemetry');
  assert.ok(node);const outcomes=[],records=[],operationErrors=new Map(),primaryFailure={code:'ORIGINAL_FAILURE'};
  const context=vm.createContext({operationErrors,diagnostics:{operationId:'fixture',write:(event,fields)=>records.push({event,fields})},
    telemetry:{finish:(outcome,error)=>outcomes.push({outcome,error})}});
  const finish=vm.runInContext(`(${source.slice(node.start,node.end)})`,context);
  const original={operationId:'fixture',kind:'update',state:'rolled-back',verification:'confirmed',primaryFailure};
  operationErrors.set('fixture',primaryFailure);finish(original);
  assert.equal(outcomes.at(-1).outcome,'failed');assert.equal(outcomes.at(-1).error,primaryFailure);
  finish(original,{recover:true});assert.equal(outcomes.at(-1).outcome,'succeeded');
  finish({...original,verification:'failed'},{recover:true});assert.equal(outcomes.at(-1).outcome,'failed');
  assert.equal(original.primaryFailure,primaryFailure);assert.equal(operationErrors.has('fixture'),false);
  assert.equal(records.length,3);assert.ok(records.every(record=>record.event==='operation.result'));
  assert.equal(records.at(-1).fields.verification,'failed');
});

test('actual first-install handler selects the latest complete release; local candidates stay offline', async () => {
  assert.ok(selection);
  for (const [action, local, expected] of [['install', false, 'latest'], ['install', true, 'candidate'], ['update', false, 'online']]) {
    const calls = [];
    const context = vm.createContext({
      payload: { action }, isUpdate: action === 'update', LOCAL_TEST: local, CHANNEL: 'stable', AbortController, process,
      selectedPlan: null, fixedTarget: async plan => { context.selectedPlan = plan; },
      context: { stage: async () => {}, effect: async () => {} }, fs: { readFileSync: () => JSON.stringify({versions:{tavern:'2.4.2'},commit:'a'.repeat(40)}) },
      releaseAbort: null, selectedPayload: null, cancelled: false,
      app: { getVersion: () => '1.0.0' }, path,
      noraHome: () => '/home', payloadDirectory: () => '/payload',
      operationDirectory: '/operation/fixture-install',
      event: { sender: {} }, sendBridgeEvent() {},
      releaseNetwork: { fetch() { throw new Error('network unavailable'); } },
      updateFetch() { throw new Error('network unavailable'); },
      releases: {
        prepareBundled: async () => { calls.push('bundled'); return '/payload'; },
        prepareInstall: async options => {
          assert.equal(options.fetcher, context.updateFetch);
          assert.equal(options.operationDirectory, context.operationDirectory);
          assert.equal(typeof options.confirmBundled, 'function');
          calls.push('latest'); return '/latest';
        },
        prepareUpdate: async () => { calls.push('online'); return '/download'; },
      },
      prepareTestPayload: async () => { calls.push('candidate'); return '/payload'; },
      diagnostics: { write() {} }, cleanupInstallTemps: () => [],
      ensureHermesFromNode: async (_sender, _run, root) => calls.push(root),
    });
    await vm.runInContext(`(async () => { ${source.slice(selection.start, selection.end)} })()`, context);
    assert.deepEqual(calls, action === 'install' ? [expected, local ? '/payload' : '/latest'] : [expected]);
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

test('offline installation dialog names the bundled version and defaults to cancellation', async () => {
  let confirmation;
  function find(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property' && node.key.name === 'confirmBundled') confirmation=node.value;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(find);
      else if (value && typeof value === 'object') find(value);
    }
  }
  find(selection);
  assert.ok(confirmation);
  for(const response of [0,1]) {
    let shown;
    const context=vm.createContext({diagnostics:{error(){}},telemetry:null,
      dialog:{showMessageBox:async options=>{shown=options;return {response};}}});
    const confirm=vm.runInContext(`(${source.slice(confirmation.start,confirmation.end)})`,context);
    assert.equal(await confirm({version:'2.2.4',error:new Error('offline')}),response===1);
    assert.equal(shown.defaultId,0);assert.equal(shown.cancelId,0);
    assert.match(shown.buttons[1],/包内版本 2\.2\.4/);
    assert.match(shown.detail,/未确认它是最新版/);
  }
});
