const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { formatUserError } = require('../installer/desktop/error-presentation');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
const functions = new Map(ast.body.filter(n => n.type === 'FunctionDeclaration').map(n => [n.id.name, n]));
function fixture(overrides = {}) {
  const calls = [], dialogs = [];
  const context = vm.createContext({
    quitting: false, quitReady: false, uninstalling: false, MOCK_SCENARIO: '', setImmediate,
    activeRun: false, modelBusy: false, selectingLocation: false, statusRequest: null,
    runOwnedTask: async (kind,target,work) => { calls.push(['owned',kind,target]); return work({stage:async()=>{}}); },
    findPython: () => '/managed/python', nodeStatus: () => ({ installed: false, hermesInstalled: false }),
    runBridge: async (command, options) => { calls.push([command, options.service]); return { running: false, gatewayRunning: false }; },
    app: { quit: () => calls.push('quit') },
    diagnostics: { write() {}, error() {}, clean: String },
    formatUserError,
    telemetry: { report() {} },
    dialog: { showMessageBox: async options => { dialogs.push(options); } },
    ...overrides,
  });
  const node = functions.get('requestQuit');
  assert.ok(node, 'Full exit must have a managed shutdown handler');
  const quit = vm.runInContext(`(${source.slice(node.start, node.end)})`, context);
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  return { context, calls, dialogs, quit, event };
}

test('cancellation availability describes the actual backend boundary, including replacement and guarded processes',()=>{
  const node=functions.get('taskCancellation');
  const state=vm.createContext({updatingSystem:false,cancelled:false,releaseAbort:null,activeProcess:null,activeOperationContext:null});
  const read=vm.runInContext(`(${source.slice(node.start,node.end)})`,state);
  assert.equal(read().canCancel,false);
  state.releaseAbort={signal:{aborted:false}};assert.equal(read().canCancel,true);
  state.updatingSystem=true;assert.equal(read().canCancel,false);assert.match(read().cancelReason,/暂不能取消/);
  state.updatingSystem=false;state.releaseAbort=null;state.activeProcess={cancelSafe:false};state.activeOperationContext={};
  assert.equal(read().canCancel,false);
  state.activeProcess.cancelSafe=true;assert.equal(read().canCancel,true);
  state.cancelled=true;assert.equal(read().canCancel,false);assert.match(read().cancelReason,/正在取消/);
});

test('full exit awaits stopping both services before allowing Electron to quit', async () => {
  let finish;
  const f = fixture({ runBridge: (command, options) => {
    f.calls.push([command, options.service]);
    return new Promise(resolve => { finish = resolve; });
  } });
  const event = f.event();
  const pending = f.quit(event);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(event.prevented, true);
  assert.deepEqual(f.calls.map(item=>Array.isArray(item)&&item[0]==='owned'?'owned':item), ['owned',['stop', 'all']]);
  await f.quit(f.event());
  assert.equal(f.calls.length, 2, 'Repeated quit must not race shutdown');
  finish({ running: false, gatewayRunning: false });
  await pending;
  assert.deepEqual(f.calls.map(item=>Array.isArray(item)&&item[0]==='owned'?'owned':item), ['owned',['stop', 'all'],'quit']);
  const second = f.event();
  await f.quit(second);
  assert.equal(second.prevented, false);
});

test('stop error or surviving service keeps the launcher alive and permits retry', async () => {
  for (const result of [new Error('fixture stop error'), { running: true }, { gatewayRunning: true }, {}]) {
    const f = fixture({ runBridge: async () => { if (result instanceof Error) throw result; return result; } });
    await f.quit(f.event());
    assert.equal(f.context.quitReady, false);
    assert.equal(f.context.quitting, false);
    assert.equal(f.calls.includes('quit'), false);
    assert.match(f.dialogs[0].message, /未退出/);
    f.context.runBridge = async () => ({ running: false, gatewayRunning: false });
    await f.quit(f.event());
    assert.equal(f.calls.includes('quit'), true);
  }
});

test('install, model save and directory selection cannot race quitting', async () => {
  for (const flag of ['activeRun', 'modelBusy', 'selectingLocation']) {
    const f = fixture({ [flag]: true });
    await f.quit(f.event());
    assert.deepEqual(f.calls, []);
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.context.quitting, false);
  }
});

test('status read settles before shutdown and shutdown still runs if it failed', async () => {
  for (const fails of [false, true]) {
    const statusRequest = fails ? Promise.reject(new Error('status failed')) : Promise.resolve();
    const f = fixture({ statusRequest });
    await f.quit(f.event());
    assert.deepEqual(f.calls.map(item=>Array.isArray(item)&&item[0]==='owned'?'owned':item), ['owned',['stop', 'all'],'quit']);
  }
});

test('uninstalled home exits without Python; missing Python for installed services is an error', async () => {
  const f = fixture({ findPython: () => null });
  await f.quit(f.event());
  assert.deepEqual(f.calls, ['quit']);
  const installed = fixture({ findPython: () => null, nodeStatus: () => ({ installed: true }) });
  await installed.quit(installed.event());
  assert.deepEqual(installed.calls, []);
  assert.equal(installed.dialogs.length, 1);
});

test('mock and uninstall retain their own lifecycle', async () => {
  for (const override of [{ MOCK_SCENARIO: 'installed' }, { uninstalling: true }]) {
    const f = fixture(override), event = f.event();
    await f.quit(event);
    assert.equal(event.prevented, false);
    assert.deepEqual(f.calls, []);
  }
});

test('only the primary instance registers managed shutdown', () => {
  const primary = source.indexOf('if (primaryInstance) {');
  assert.ok(source.indexOf('app.requestSingleInstanceLock()') < primary);
  assert.ok(primary < source.indexOf('telemetry = createTelemetry('));
  assert.ok(primary < source.indexOf("app.on('before-quit', requestQuit)"));
  assert.match(source, /if\(initialized&&!primaryInstance\)app\.quit\(\)/);
  assert.ok(source.includes("if (quitting && channel !== 'nora:status') throw new Error('正在退出"));
});

test('Windows window close waits for shutdown and remains open on failure', () => {
  let closeNode;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.object?.name === 'win'
      && node.callee.property?.name === 'on' && node.arguments[0]?.value === 'close') closeNode = node.arguments[1];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  assert.ok(closeNode);
  for (const platform of ['win32', 'darwin']) {
    let quits = 0;
    const context = vm.createContext({ process: { platform }, quitting: false, quitReady: false,
      uninstalling: false, MOCK_SCENARIO: '', activeRun: false, modelBusy: false,
      app: { quit: () => { quits++; } } });
    const close = vm.runInContext(`(${source.slice(closeNode.start, closeNode.end)})`, context);
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const initial = event(); close(initial);
    assert.equal(initial.prevented, platform === 'win32');
    assert.equal(quits, platform === 'win32' ? 1 : 0);
    context.quitting = true;
    const stopping = event(); close(stopping);
    assert.equal(stopping.prevented, true);
    context.quitting = false;
    const failedRetry = event(); close(failedRetry);
    assert.equal(failedRetry.prevented, platform === 'win32');
    context.quitReady = true;
    const completed = event(); close(completed);
    assert.equal(completed.prevented, false);
  }
});
