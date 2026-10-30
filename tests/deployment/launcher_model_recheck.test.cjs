const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test, after } = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { modelCredential,configurationFingerprint } = require('../installer/desktop/model-config');

const mainPath = path.join(__dirname, '../installer/desktop/main.js');
const mainRequire = createRequire(mainPath);
const source = fs.readFileSync(mainPath, 'utf8');
const fixtureHomes = new Set();
after(() => { for (const home of fixtureHomes) fs.rmSync(home, { recursive: true, force: true }); });
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

test('restored handoff recheck accepts real bridge progress through the active operation context',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-restored-bridge-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bridge=vm.createContext({activeOperationContext:null,
    diagnostics:{clean:value=>value},recordEvent(){},readInstallerState:()=>({phase:'done'}),taskCancellation:()=>({})});
  const node=nodes.sendBridgeEvent;
  const send=vm.runInContext('('+source.slice(node.start,node.end)+')',bridge);
  const controller=mainRequire('./operation-state').createOperationController({directory,
    lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),verifyResult:()=>true,
    evidence:mainRequire('./evidence-store').createEvidenceStore({directory}),
    verifyRestoredHandoff:async(record,context)=>{
      assert.equal(context.target.currentVersion,'2.5.0');
      context.delivery({schema:1,operationId:record.operationId,status:'pending',queued:0});
      bridge.activeOperationContext=context;
      try{
        send(null,'',{event:'task',task:'verify-current-update'});
        send(null,'',{event:'result',ok:true});
      }finally{bridge.activeOperationContext=null;}
      return {operationId:record.operationId,planDigest:record.planDigest,job:record.handoffRef,
        status:'restored',verification:'confirmed',value:{version:'2.5.0'}};
    }});
  const pending=await controller.start('update',{target:{currentVersion:'2.5.0'},execute:async context=>{
    await context.handoff('/owned/restored-job');return {handoff:true};
  }},'restored-bridge');
  const result=await controller.recheck(pending.operationId);
  assert.equal(result.state,'rolled-back');assert.equal(result.verification,'confirmed');
  assert.equal(result.currentFailure,null);assert.equal(result.primaryFailure.code,'LAUNCHER_START_FAILED');
  assert.equal((await controller.start('stop',{execute:async()=>({verification:'confirmed'})},'after-bridge')).state,'succeeded');
});

test('restored GUI startup waits for the helper writer and verifies its task once outside status polling',async t=>{
  for(const kind of ['closing-helper','active-writer','terminal','ordinary'])await t.test(kind,async()=>{
    let snapshots=0,checks=0,waits=0;
    const pending={handoffRef:'/owned/job',operationId:'original-operation',snapshotSequence:9,state:'interrupted',busy:false};
    const controller={snapshot:async()=>{
      snapshots++;
      if(kind==='ordinary')return null;
      if(kind==='terminal')return {...pending,state:'rolled-back'};
      return {...pending,busy:kind==='active-writer'||snapshots===1};
    },recheck:async(id,options)=>{
      checks++;assert.equal(id,pending.operationId);assert.equal(options.snapshotSequence,9);return {state:'rolled-back'};
    }};
    const context=vm.createContext({operations:()=>controller,setTimeout:fn=>{waits++;queueMicrotask(fn);}});
    const node=nodes.reconcileRestoredHandoff;
    const run=vm.runInContext('('+source.slice(node.start,node.end)+')',context);
    await run();
    assert.equal(checks,kind==='closing-helper'?1:0);
    assert.equal(waits,kind==='active-writer'?8:kind==='closing-helper'?1:0);
  });
});

function fixture({ setupCompleted = false, running = true, syncFails = false, runtimeFails = false, configureFailure = null, recheck = true, marker = null } = {}) {
  const order = [], events = [], helperRequests = [], effects = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-model-recheck-'));
  fixtureHomes.add(home);
  const context = vm.createContext({
    fs, path, require: mainRequire, CHANNEL: 'stable', releases: mainRequire('./releases'),
    activeOperationContext: null, installerPortBinding: null,
    telemetry: undefined, launcherError: require('../installer/desktop/launcher-errors').launcherError,
    diagnostics: { addSecret() {}, error() {}, clean: value => value }, modelCredential,configurationFingerprint,
    uninstall:{own:()=> 'isolated-installation-identity'},
    telemetry: null,
    // This fixture isolates model ordering; the real ownership/close protocol
    // is exercised separately by launcher_operation_lock.test.cjs.
    runOwnedTask: async (_kind, _request, execute) => {
      const result = await execute({ stage: async () => {}, effect:async value => effects.push(value) });
      assert.equal(result.verification, 'confirmed');
      return result.value;
    },
    activeRun: false, modelBusy: false, statusRequest: Promise.resolve(),
    requireProvider: () => ({ id: 'custom', keyEnv: '', custom: true }), normalizeCustomBaseUrl: value => value,
    recordFailureEvent(){},recordEvent: event => { events.push(event); order.push(event.state); },
    runModelConfigHelper: async value => {
      helperRequests.push({ ...value });
      order.push(value.action);
      if (value.action === 'configure') {
        if (configureFailure) throw configureFailure;
        // The shared helper owns candidate validation, configuration commit and
        // this checkpoint. Its real validation ordering has separate integration
        // coverage; this fixture verifies the desktop orchestration boundary.
        marker = { provider: 'custom:local', model: value.model, baseUrl: value.baseUrl,
          keyEnv: value.keyEnv, authMode: value.authMode, tavernSyncPending: value.tavernSyncPending };
        order.push('shared-checkpoint');
      }
      if (value.action === 'sync-saved-tavern') assert.equal(value.port, 18999);
      if (value.action === 'sync-saved-tavern' && syncFails) throw new Error('fixture sync failure');
      if (value.action === 'verify-runtime' && runtimeFails) throw new Error('实际模型服务与新配置不一致');
      return { ok: true, provider: 'custom:local', model: 'fixture-model', baseUrl: 'http://127.0.0.1:8080/v1' };
    },
    testCustomModel: async () => { throw new Error('Desktop must delegate validation to configure'); },
    testProviderModel: async () => { throw new Error('Desktop must delegate validation to configure'); },
    readInstallerState: () => ({ setupCompleted, port: 18999 }),
    noraHome: () => home, hermesHome: () => path.join(home, 'hermes'), installRoot: () => path.join(home, 'tavern'), DEFAULT_PORT: 8799,
    readVerifiedModel: () => marker,
    writeVerifiedModel: (_home, value) => {
      assert.equal(value.tavernSyncPending, false, 'JS only clears the completed Tavern synchronization checkpoint');
      marker = value; order.push('sync-checkpoint');
    },
    runBridge: async (command, options) => {
      order.push(command);
      if (command === 'start') { assert.equal(options.service, 'tavern'); assert.equal(options.port, 18999); return { running }; }
      assert.equal(command, 'verify-model'); return { ok: recheck, error: '模型配置复核未通过' };
    },
  });
  const load = name => vm.runInContext(`(${source.slice(nodes[name].start, nodes[name].end)})`, context);
  // Use the production port and retained-record checks before exercising model
  // ordering; the isolated empty root permits the real pre-install fallback.
  context.confirmedMaintenanceIdentity = load('confirmedMaintenanceIdentity');
  context.installationPort = load('installationPort');
  context.finishModelSetup = load('finishModelSetup');
  return { context, order, events, helperRequests, effects, marker: () => marker, save: load('nora:model-save-test'), resume: load('nora:model-resume') };
}
const input = { provider: 'custom', key: 'fixture-only', model: 'fixture-model', baseUrl: 'http://127.0.0.1:8080/v1' };

test('desktop delegates validation and commit once to configure before Tavern synchronization and final checks', async () => {
  const f = fixture();
  assert.equal((await f.save({}, input)).ok, true);
  assert.deepEqual(f.helperRequests[0], { action: 'configure', provider: 'custom', keyEnv: '', key: input.key,
    model: input.model, baseUrl: input.baseUrl, authMode: 'key', tavernSyncPending: true });
  assert.equal(f.helperRequests.filter(request => request.action === 'configure').length, 1);
  assert.ok(!f.order.includes('save'), 'the desktop must not run the old independent save action');
  for (const [a, b] of [['configure', 'shared-checkpoint'], ['shared-checkpoint', 'start'], ['start', 'sync-saved-tavern'],
    ['sync-saved-tavern', 'sync-checkpoint'], ['sync-checkpoint', 'verify-model'], ['verify-model', 'done']]) {
    assert.ok(f.order.indexOf(a) < f.order.indexOf(b), `${a} before ${b}`);
  }
  assert.equal(f.marker().tavernSyncPending, false);
  assert.ok(f.order.indexOf('verify-model') < f.order.indexOf('verify-runtime'));
  assert.ok(f.order.indexOf('verify-runtime') < f.order.indexOf('done'));
  assert.equal(f.context.modelBusy, false);
  assert.deepEqual(f.effects,['unknown','changed']);
  assert.ok(!JSON.stringify(f.events).includes('fixture-only'));
});

test('a missing shared helper response reports an uncertain save rather than a candidate refusal', async () => {
  const f=fixture({configureFailure:new Error('helper response interrupted')});
  await assert.rejects(f.save({},input),error=>error.userCode==='MODEL_CONFIG_PARTIAL'
    && error.modelFailureStage!=='candidate');
  assert.equal(f.context.modelBusy,false);
  assert.equal(f.helperRequests.length,1);
  assert.equal(f.marker(),null,'the desktop does not invent a saved checkpoint from a lost response');
  assert.deepEqual(f.effects,['unknown']);
});

test('a rejected shared candidate leaves the old checkpoint and skips synchronization while releasing busy state', async () => {
  const previous = { provider: 'old-provider', model: 'old-model', tavernSyncPending: false };
  const failure = Object.assign(new Error('fixture candidate validation rejected'), { modelFailureStage: 'candidate' });
  const f = fixture({ marker: previous, configureFailure: failure });
  await assert.rejects(f.save({}, input), error => error === failure);
  assert.equal(f.marker(), previous);
  assert.deepEqual(f.effects,['unknown','untouched']);
  assert.deepEqual(f.order, ['running', 'configure']);
  assert.equal(f.events.some(event => event.state === 'done'), false);
  assert.equal(f.context.modelBusy, false);
});

test('failed sync survives restart and resumes without credentials or another model request', async () => {
  const first = fixture({ syncFails: true });
  await assert.rejects(first.save({}, input), /模型验证已通过.*同步未完成/);
  assert.equal(first.marker().tavernSyncPending, true);
  assert.equal(first.events.some(e => e.state === 'done'), false);
  const restarted = fixture({ marker: first.marker() });
  await restarted.resume();
  assert.ok(!restarted.order.includes('configure'));
  assert.ok(!restarted.order.includes('save'));
  assert.equal(restarted.marker().tavernSyncPending, false);
});

test('unready Tavern never receives a sync request', async () => {
  const f = fixture({ running: false });
  await assert.rejects(f.save({}, input), /接口尚未就绪/);
  assert.ok(!f.order.includes('sync-saved-tavern'));
  assert.ok(!f.order.includes('verify-runtime'));
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
  assert.ok(f.order.includes('verify-runtime'));
});

test('runtime route mismatch never reports model setup complete', async () => {
  const f = fixture({ setupCompleted: true, runtimeFails: true });
  await assert.rejects(f.save({}, input), /实际模型服务与新配置不一致/);
  assert.equal(f.events.some(e => e.state === 'done'), false);
  assert.equal(f.context.modelBusy, false);
});
