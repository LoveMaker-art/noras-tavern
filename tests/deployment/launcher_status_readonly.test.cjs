const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {parse}=require('../installer/desktop/node_modules/acorn');
test('status polling reports a pending legacy transaction without stopping services or changing installer history',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  let callback;
  function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:status')callback=node.arguments[1];
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}
  const ast=parse(source,{ecmaVersion:'latest'});visit(ast);
  let stops=0,writes=0;
  const installer={phase:'update',task:'old unfinished task'};
  const recovery={status:'applying',kind:'legacy',canRecover:true};
  const context=vm.createContext({quitting:false,uninstalling:false,selectingLocation:false,modelBusy:false,statusRequest:null,activeRun:false,
    require:require('node:module').createRequire(path.join(__dirname,'../installer/desktop/main.js')),
    activeProcess:null,releaseAbort:null,cancelled:false,updatingSystem:false,desktopUpdateNotice:null,
    readLauncherRecovery:async()=>null,systemUpdate:{pending:()=>true,inspect:()=>recovery,recover:async()=>{stops++;}},noraHome:()=>'/fixture',
    stopForUpdate:async()=>{stops++;},readInstallerState:()=>installer,writeInstallerState:()=>{writes++;return installer;},findPython:()=>({command:'python'}),
    runBridge:async()=>({installed:true,version:'2.4.2',running:true}),lastStatusError:'',telemetry:null,LOCAL_TEST:null,
    releases:{bundledUpgradeTarget:()=>null},payloadDirectory:()=>'/payload',app:{getVersion:()=> '2.0.2'},CHANNEL:'stable',locationStatus:()=>({noraHome:'/fixture'}),
    statusErrorMessage:()=> 'fixture error',nodeStatus:()=>({}),activeOperationContext:null,operations:()=>({snapshot:async()=>({state:'idle',allowedActions:[]})})});
  const cancellation=ast.body.find(node=>node.id?.name==='taskCancellation');assert.ok(cancellation);
  vm.runInContext(source.slice(cancellation.start,cancellation.end),context);
  const query=vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context);
  const response=await query();
  assert.equal(stops,0);
  assert.equal(writes,0);
  assert.equal(response.running,true);
  assert.equal(response.updateRecovery.kind,'legacy');
  assert.equal(response.installer.phase,'update');
});

test('reopening never exposes a bundled core target, including a newer unattempted release',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  let callback;
  function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:status')callback=node.arguments[1];
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}
  const ast=parse(source,{ecmaVersion:'latest'});visit(ast);
  let target='v2.5.1',writes=0,updates=0;
  const context=vm.createContext({quitting:false,uninstalling:false,selectingLocation:false,modelBusy:false,statusRequest:null,activeRun:false,
    require:require('node:module').createRequire(path.join(__dirname,'../installer/desktop/main.js')),
    activeProcess:null,releaseAbort:null,cancelled:false,updatingSystem:false,desktopUpdateNotice:null,
    readLauncherRecovery:async()=>null,systemUpdate:{inspect:()=>null},noraHome:()=>'/fixture',
    readInstallerState:()=>({phase:'ready'}),writeInstallerState:()=>{writes++;},findPython:()=>({command:'python'}),
    runBridge:async command=>{if(command!=='status')updates++;return {installed:true,hermesInstalled:true,systemReady:true,version:'2.5.0'};},
    lastStatusError:'',telemetry:null,LOCAL_TEST:null,releases:{bundledUpgradeTarget:()=>target},payloadDirectory:()=>'/payload',
    app:{getVersion:()=> '2.5.1'},CHANNEL:'stable',locationStatus:()=>({noraHome:'/fixture'}),statusErrorMessage:()=> 'fixture error',nodeStatus:()=>({}),
    activeOperationContext:null,operations:()=>({snapshot:async()=>({state:'succeeded',kind:'stop',allowedActions:[]}),
      hasFailedUpdateTarget:tag=>tag==='v2.5.1'})});
  const cancellation=ast.body.find(node=>node.id?.name==='taskCancellation');
  vm.runInContext(source.slice(cancellation.start,cancellation.end),context);
  const query=vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context);
  assert.equal((await query()).bundledUpgradeTarget,null);
  target='v2.5.2';
  assert.equal((await query()).bundledUpgradeTarget,null);
  assert.equal(writes,0);assert.equal(updates,0);
});

test('a bound files-only recovery reports service facts after later tasks without retaining a program recovery page',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  let callback;
  function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:status')callback=node.arguments[1];
    for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}
  const ast=parse(source,{ecmaVersion:'latest'});visit(ast);
  const id='00000000-0000-4000-8000-000000000001';
  let recovery={status:'recovery-failed',operationId:id},legacy=null;
  let record={operationId:id,kind:'update',state:'rolled-back',effectState:'restored',verification:'failed',busy:false,
    currentFailure:null,recoveryOutcome:'files-restored-start-failed',secondaryFailures:[{code:'SERVICE_START_FAILED'}]};
  const current={operationId:'00000000-0000-4000-8000-000000000002',state:'succeeded',kind:'stop',busy:false};
  const context=vm.createContext({quitting:false,uninstalling:false,selectingLocation:false,modelBusy:false,statusRequest:null,activeRun:false,
    require:require('node:module').createRequire(path.join(__dirname,'../installer/desktop/main.js')),
    activeProcess:null,releaseAbort:null,cancelled:false,updatingSystem:false,desktopUpdateNotice:null,
    readLauncherRecovery:async()=>null,systemUpdate:{inspect:()=>legacy},noraHome:()=>'/fixture',
    readInstallerState:()=>({phase:'idle'}),reconcileInstallerState:()=>({phase:'idle'}),findPython:()=>({command:'python'}),
    runBridge:async()=>({installed:true,systemReady:true,running:false,gatewayRunning:false,warning:'服务未启动',updateRecovery:recovery}),
    lastStatusError:'',telemetry:null,LOCAL_TEST:null,releases:{bundledUpgradeTarget:()=>null},payloadDirectory:()=>'/payload',
    app:{getVersion:()=> '2.5.1'},CHANNEL:'stable',locationStatus:()=>({noraHome:'/fixture'}),statusErrorMessage:()=> 'fixture error',nodeStatus:()=>({}),
    activeOperationContext:null,operations:()=>({snapshot:async selected=>selected?record:current})});
  const cancellation=ast.body.find(node=>node.id?.name==='taskCancellation');
  vm.runInContext(source.slice(cancellation.start,cancellation.end),context);
  const query=vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context);
  const response=await query();
  assert.equal(response.updateRecovery,null);assert.equal(response.operation,current);
  assert.equal(response.running,false);assert.equal(response.gatewayRunning,false);assert.equal(response.warning,'服务未启动');
  for(const change of [{effectState:'unknown'},{busy:true},{operationId:current.operationId}]){
    const saved=record;record={...record,...change};assert.equal((await query()).updateRecovery,recovery);record=saved;
  }
  recovery={status:'recovery-failed'};assert.equal((await query()).updateRecovery,recovery);
  recovery={status:'recovery-failed',operationId:id};legacy={kind:'legacy',status:'applying'};
  assert.ok((await query()).updateRecovery,'a separate unfinished legacy recovery remains a blocker');
});
