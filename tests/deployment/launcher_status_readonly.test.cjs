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
    activeProcess:null,releaseAbort:null,cancelled:false,updatingSystem:false,
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
