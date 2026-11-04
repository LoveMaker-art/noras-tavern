const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { formatUserError } = require('../installer/desktop/error-presentation');
const { verifyWorkflowResult } = require('../installer/desktop/operation-result');

const source = fs.readFileSync(path.join(__dirname, '../installer/desktop/main.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
const functions = new Map(ast.body.filter(n => n.type === 'FunctionDeclaration').map(n => [n.id.name, n]));
function fixture(overrides = {}) {
  const calls = [], dialogs = [];
  const context = vm.createContext({
    quitting: false, quitReady: false, shutdownPending: null, uninstalling: false, MOCK_SCENARIO: '',
    setImmediate, setTimeout, clearTimeout, verifyWorkflowResult,
    activeRun: false, modelBusy: false, selectingLocation: false, statusRequest: null,
    activeOperationContext: null, activeProcess: null,
    noraHome: () => '/private/test-instance',
    installerDirectory: () => '/private/test-instance/installer',
    launcherError: (message, fields) => Object.assign(new Error(message),fields),
    operationLock: {probe:async()=>({busy:true,inspectionRequired:false,errors:[]})},
    require: name => {
      if(name==='./os-lock')return {acquire:()=>({release(){}})};
      assert.equal(name,'./updater-task'); return {query:async()=>({status:'none',busy:false,settled:true})};
    },
    runOwnedTask: async (kind,target,work) => { calls.push(['owned',kind,target]); return work({stage:async()=>{}}); },
    findPython: () => '/managed/python', nodeStatus: () => ({ installed: false, hermesInstalled: false }),
    runBridge: async (command, options) => { calls.push([command, options.service]); return { running: false, tavernProcessRunning: false, gatewayRunning: false }; },
    app: { quit: () => calls.push('quit') },
    diagnostics: { write() {}, error() {}, clean: String },
    formatUserError,
    telemetry: { report() {} },
    dialog: { showMessageBox: async options => { dialogs.push(options); } },
    ...overrides,
  });
  const node = functions.get('requestQuit');
  assert.ok(node, 'Full exit must have a managed shutdown handler');
  for(const name of ['awaitLifecycleStep','hasLocalShutdownWork','acquireExitFence','confirmExitWithoutStopping']){
    const fn=functions.get(name);
    vm.runInContext(source.slice(fn.start,fn.end),context);
  }
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

test('planned APP handoff does not report late renderer or child exits as crashes',()=>{
  const listeners=new Map();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&['render-process-gone','child-process-gone'].includes(node.arguments[0]?.value))
      listeners.set(node.arguments[0].value,node.arguments[1]);
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);
  }
  visit(ast);
  assert.equal(listeners.size,2);
  const crashes=[];
  const state=vm.createContext({quitReady:true,quitting:false,recordNativeFailure:(...args)=>crashes.push(args),
    setTimeout:()=>({unref(){}})});
  const callbacks=[...listeners.values()].map(node=>vm.runInContext(`(${source.slice(node.start,node.end)})`,state));
  for(const callback of callbacks)callback({}, {reason:'killed',exitCode:1});
  assert.deepEqual(crashes,[]);
  state.quitReady=false;
  for(const callback of callbacks)callback({}, {reason:'killed',exitCode:1});
  assert.deepEqual(crashes.map(([kind])=>kind),['renderer','child']);
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
  finish({ running: false, tavernProcessRunning: false, gatewayRunning: false });
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
    assert.deepEqual([...f.dialogs[0].buttons],['返回启动器','仅退出启动器']);
    assert.equal(f.dialogs[0].defaultId,0);
    assert.equal(f.dialogs[0].cancelId,0);
    assert.match(f.dialogs[0].detail,/后台服务可能继续运行/);
    f.context.runBridge = async () => ({ running: false, tavernProcessRunning: false, gatewayRunning: false });
    await f.quit(f.event());
    assert.equal(f.calls.includes('quit'), true);
  }
});

test('local tasks and their still-active executors cannot race quitting', async () => {
  for (const flag of ['activeRun', 'modelBusy', 'selectingLocation','activeOperationContext','activeProcess']) {
    const f = fixture({ [flag]: true });
    await f.quit(f.event());
    assert.deepEqual(f.calls, []);
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.context.quitting, false);
  }
});

test('a busy writer cannot bypass active installation, model save or location selection protection',async()=>{
  for(const flag of ['activeRun','modelBusy','selectingLocation']){
    const f=fixture({[flag]:true,require:()=>({query:async()=>({status:'in-progress',busy:true,settled:false,
      operation:{kind:'update',state:'succeeded'}})})});
    await f.quit(f.event());await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.calls,[],flag);assert.equal(f.context.quitReady,false,flag);
    assert.equal(f.dialogs.length,1,flag);assert.equal(f.dialogs[0].type,'info',flag);
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

test('quit awaits shared liveness inspection and stops services after a positively interrupted submission',async()=>{
  let finish;
  const f=fixture({require:name=>{assert.equal(name,'./updater-task');return {query:()=>new Promise(resolve=>{finish=resolve;})};}});
  const closing=f.quit(f.event());
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.calls,[],'no quit or stop before submission liveness is known');
  finish({status:'interrupted',busy:false,settled:true});await closing;
  assert.deepEqual(f.calls.map(item=>Array.isArray(item)&&item[0]==='owned'?'owned':item),['owned',['stop','all'],'quit']);
});

test('quit waits for an independent update without stopping services and works after the task settles',async()=>{
  let state={status:'in-progress',busy:true,settled:false};
  const f=fixture({require:name=>{assert.equal(name,'./updater-task');return {query:async()=>state};}});
  await f.quit(f.event());await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.calls,[]);assert.equal(f.context.quitReady,false);assert.equal(f.dialogs.length,1);
  assert.equal(f.dialogs[0].type,'info');
  state={status:'succeeded',busy:false,settled:true};await f.quit(f.event());
  assert.deepEqual(f.calls.map(item=>Array.isArray(item)&&item[0]==='owned'?'owned':item),['owned',['stop','all'],'quit']);
});

test('pending or unconfirmed updater inspection keeps the window open without a shutdown attempt',async()=>{
  for(const state of [{status:'submitting',busy:false,settled:false},{status:'unknown',busy:null,settled:true}]){
    const f=fixture({require:()=>({query:async()=>state})});await f.quit(f.event());
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.calls,[]);assert.equal(f.context.quitReady,false);assert.equal(f.dialogs.length,1);
  }
});

test('only-exit accepts broken history after proving no writer or executor remains',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'nora-quit-only-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,'installer');
  const native=require('../installer/desktop/os-lock'),guard=require('../installer/desktop/operation-lock');
  const updater=require('../installer/desktop/updater-task');
  const job=path.join(directory,'update-jobs','76dff6a7-1cf2-45c7-9da0-a14354c50a61');
  fs.mkdirSync(job,{recursive:true});
  const damaged=path.join(job,'operation-ref.json');
  fs.writeFileSync(damaged,'{incomplete');
  assert.equal((await updater.query(home)).status,'inspection-required');
  const f=fixture({noraHome:()=>home,installerDirectory:()=>directory,operationLock:guard,
    require:name=>name==='./os-lock'?native:updater,
    diagnostics:{write:(event,detail)=>f.calls.push([event,detail?.servicesStopped]),error(){}},
    dialog:{showMessageBox:async options=>{
      f.dialogs.push(options);
      assert.equal(native.acquire({directory,probe:true}).busy,false);
      return {response:1};
    }},
  });
  await f.quit(f.event());
  assert.deepEqual(f.calls,[['shutdown.exit-only',false],'quit']);
  assert.equal(fs.readFileSync(damaged,'utf8'),'{incomplete');
  assert.equal(native.acquire({directory,probe:true}).busy,false);
});

test('a native writer or unresolved executor prevents offering only-exit',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-quit-held-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const native=require('../installer/desktop/os-lock'),guard=require('../installer/desktop/operation-lock');
  const f=fixture({installerDirectory:()=>directory,operationLock:guard,
    require:name=>name==='./os-lock'?native:{query:async()=>({status:'inspection-required',busy:null,settled:false})},
  });
  const lease=native.acquire({directory});
  try{await f.quit(f.event());}finally{lease.release();}
  const ledger=path.join(directory,'operations','.guards','orphan.json');
  fs.mkdirSync(path.dirname(ledger));
  fs.writeFileSync(ledger,JSON.stringify({schema:'nora-operation-guard/1',jobs:[{pid:process.pid}]}));
  await f.quit(f.event());
  assert.equal(f.dialogs.length,2);
  for(const dialog of f.dialogs)assert.deepEqual([...dialog.buttons],['知道了']);
  assert.deepEqual(f.calls,[]);
  assert.equal(native.acquire({directory,probe:true}).busy,false);
});

test('confirming only-exit rechecks a writer that arrived while the dialog was open',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nora-quit-race-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const native=require('../installer/desktop/os-lock'),guard=require('../installer/desktop/operation-lock');
  let arrived;
  const f=fixture({installerDirectory:()=>directory,operationLock:guard,
    require:name=>name==='./os-lock'?native:{query:async()=>({status:'inspection-required',busy:null,settled:false})},
    dialog:{showMessageBox:async options=>{
      f.dialogs.push(options);
      if(options.type==='warning'){
        arrived=native.acquire({directory});
        return {response:1};
      }
    }},
  });
  try{await f.quit(f.event());}finally{arrived?.release();}
  assert.ok(arrived,'a writer can acquire the fence while the user considers the dialog');
  assert.deepEqual([...f.dialogs[1].buttons],['知道了']);
  assert.deepEqual(f.calls,[]);
  assert.equal(f.context.quitReady,false);
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

test('a stuck read releases the exit attempt without stopping services', async () => {
  const f = fixture({
    statusRequest: new Promise(() => {}),
    setTimeout: callback => setTimeout(callback, 10),
  });
  await f.quit(f.event());
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.quitting, false);
  assert.equal(f.context.quitReady, false);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].detail,/状态检查仍在进行/);
  f.context.statusRequest = null;
  await f.quit(f.event());
  assert.ok(f.calls.includes('quit'));
});

test('a late owned shutdown does not exit the app and can only be retried after settling', async () => {
  let finish;
  let first = true;
  const f = fixture({
    runBridge: async () => {
      if (!first) return {tavernProcessRunning:false,gatewayRunning:false};
      first = false;
      return new Promise(resolve => { finish = resolve; });
    },
    setTimeout: callback => setTimeout(callback, 10),
  });
  await f.quit(f.event());
  assert.equal(f.context.quitting, false);
  assert.equal(f.context.quitReady, false);
  assert.match(f.dialogs[0].detail,/任务结束后可重试退出/);
  await f.quit(f.event());
  assert.equal(f.calls.length, 1, 'second attempt must wait for the original guarded writer');
  finish({tavernProcessRunning:false,gatewayRunning:false});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.includes('quit'), false, 'a timed out attempt cannot exit later');
  await f.quit(f.event());
  assert.equal(f.calls.includes('quit'), true);
});

test('missing Python cannot treat a partial managed installation as empty', async () => {
  const f = fixture({findPython: () => null, nodeStatus: () => ({managedInstallation:true})});
  await f.quit(f.event());
  assert.deepEqual(f.calls, []);
  assert.equal(f.dialogs.length, 1);
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
      win: {}, dialog: { showMessageBox() {} }, app: { quit: () => { quits++; } } });
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
    // A prepared APP replacement/recovery must close its current window even
    // while the handoff is still the active operation. The helper waits for it.
    for(const flag of ['activeRun','modelBusy']){
      context[flag]=true;
      const handoff=event();close(handoff);
      assert.equal(handoff.prevented,false,`${platform}: an approved handoff must exit with ${flag}`);
      context[flag]=false;
    }
    context.quitReady = false;
    for(const flag of ['activeRun','modelBusy']){
      context[flag] = true;
      const busy = event();close(busy);
      assert.equal(busy.prevented,true,`${platform} ${flag}`);
      context[flag] = false;
    }
  }
});

test('APP recovery delegates only its own restoration and exits after the writer releases its handoff',async()=>{
  for(const failedPreparation of [false,true]){
    const calls=[],lease={};
    const context=vm.createContext({activeRun:false,modelBusy:false,uninstalling:false,selectingLocation:false,quitting:false,
      statusRequest:null,quitReady:false,activeOperationContext:null,path,process,setImmediate,
      app:{isPackaged:true,getVersion:()=> '2.2.9',quit:()=>calls.push('quit')},
      ensureAppHelperRuntime:async options=>{
        if(options.lease){assert.equal(options.lease,lease);calls.push('private-cache');}
        else{assert.equal(options.refresh,true);calls.push('runtime');}
      },
      readLauncherRecovery:async()=>({canRecover:true,busy:false,job:'/owned/job',operationId:'owned-operation'}),
      operations:()=>({snapshot:async()=>({operationId:'owned-operation',snapshotSequence:1,kind:'update',target:{request:{launcherOnly:true}}}),recover:async(id,options)=>{
        assert.equal(id,'owned-operation');assert.equal(options.recoveryHandoff.job,'/owned/job');
        try{const prepared=await options.prepareHandoff({operationId:id,snapshot:{operationId:id},lease});
          return {state:'awaiting-handoff',handoffRef:'/owned/job',result:prepared};
        }finally{calls.push('writer-released');}
      }}),
      launcherRecoveryOptions:()=>({}),
      launcherUpdate:{restore:async options=>{
        assert.equal(options.job,'/owned/job');
        if(options.context){calls.push('prepare');if(failedPreparation)throw Error('APP proof unconfirmed');return {parentCreationTime:1};}
        assert.ok(calls.includes('writer-released'));calls.push('restore-helper');return {restarting:true};
      }},
      runBridge:async()=>assert.fail('main APP recovery must not operate on core services'),
      diagnostics:{begin(){},event(){},write(){},error(){},finish(){},clean:String},
      telemetry:{begin(){},stage(){},report(){}},rememberOperationFailure(){},finishOperationTelemetry(){},
      launcherError:message=>new Error(message),requireOperationResult:()=>({}),
    });
    const node=functions.get('recoverLauncher'),recover=vm.runInContext(`(${source.slice(node.start,node.end)})`,context);
    if(failedPreparation){
      await assert.rejects(recover(),/APP proof unconfirmed/);assert.deepEqual(calls,['runtime','private-cache','prepare','writer-released']);
      assert.equal(context.quitReady,false);assert.equal(context.activeRun,false);
    }else{
      await recover();await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(calls,['runtime','private-cache','prepare','writer-released','restore-helper','quit']);assert.equal(context.quitReady,true);
    }
    assert.equal(context.activeOperationContext,null);
  }
});
